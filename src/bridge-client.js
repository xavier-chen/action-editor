"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

const ACTIONS = new Set([
  "connect", "disconnect", "set_node", "ping", "status", "status_many", "move",
  "servo_move",
  "stop", "disable", "clear_faults", "calibration_start",
  "calibration_abort", "position_lock", "position_unlock", "param_get",
  "homing_start",
  "param_set", "param_save", "param_defaults", "pair_discover",
  "pair_assign", "sim_pair_window",
  "firmware_update_frames",
]);
const INTERNAL_ACTIONS = new Set(["motion_replay"]);
const MOTION_ACTIONS = new Set(["move", "servo_move"]);
const ADDRESSED_ACTIONS = new Set([
  "ping", "status", "move", "servo_move", "stop", "disable", "clear_faults",
  "calibration_start", "calibration_abort", "position_lock",
  "position_unlock", "homing_start", "param_get", "param_set", "param_save",
  "param_defaults",
]);

const DEVICE_ACK_TIMEOUT_MS = 5000;
const RECENT_ACK_TTL_MS = 1000;
/*
 * The MCU retains exact request identities for 2 s.  Stop retrying after
 * 1.5 s so the final replay still has transport and scheduler margin before
 * that firmware window closes.
 */
const MOTION_ACK_RETRY_INTERVAL_MS = 250;
const MOTION_ACK_RETRY_WINDOW_MS = 1500;

function expectedAck(action, params = {}) {
  const controls = {
    ping: 0x01,
    stop: 0x02,
    disable: 0x03,
    clear_faults: 0x04,
    status: 0x05,
    calibration_start: 0x06,
    calibration_abort: 0x07,
    position_lock: 0x0B,
    position_unlock: 0x0C,
    homing_start: 0x0D,
  };
  const parameters = {
    param_get: 0x01,
    param_set: 0x02,
    param_save: 0x03,
    param_defaults: 0x04,
  };
  if (
    (action === "stop" || action === "disable")
    && params.broadcast === true
  ) return null;
  if (Object.hasOwn(controls, action)) {
    return { commandClass: 3, opcode: controls[action] };
  }
  if (Object.hasOwn(parameters, action)) {
    return { commandClass: 4, opcode: parameters[action] };
  }
  if (action === "move") {
    return { commandClass: params.closed === true ? 2 : 1, opcode: 0 };
  }
  if (action === "servo_move") {
    return { commandClass: 2, opcode: 0 };
  }
  return null;
}

function ackKey(sessionEpoch, nodeId, commandClass, opcode, sequence) {
  return `${sessionEpoch}:${nodeId}:${commandClass}:${opcode}:${sequence}`;
}

class BridgeClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.python = options.python
      || process.env.ACTION_EDITOR_PYTHON
      || process.env.LUMDRIVER_PYTHON
      || "python3";
    this.script = options.script || path.join(__dirname, "..", "bridge", "lumdriver_bridge.py");
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ackWaiters = new Map();
    this.recentAcks = new Map();
    this.motionStateUncertain = new Map();
    this.motionCancelSerial = 0;
    this.motionCancelAll = null;
    this.motionCancelByNode = new Map();
    this.defaultNodeId = null;
    this.sessionEpoch = 0;
    this.stderr = "";
  }

  start() {
    if (this.process) return;
    const child = spawn(this.python, ["-u", this.script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    this.process = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-16_384);
    });
    child.once("error", (error) => {
      if (this.process !== child) return;
      this.process = null;
      this.#advanceSession("bridge-error");
      this.#failAll(error);
      this.emit("event", {
        event: "connection",
        data: { connected: false, reason: "bridge-error" },
      });
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      const detail = this.stderr.trim();
      this.process = null;
      this.#advanceSession("bridge-exit");
      this.#failAll(new Error(`CAN 桥接进程退出 code=${code} signal=${signal}${detail ? `: ${detail}` : ""}`));
      this.emit("event", { event: "connection", data: { connected: false, reason: "bridge-exit" } });
    });
  }

  request(action, params = {}, timeoutMs = 5000) {
    if (!ACTIONS.has(action) && !INTERNAL_ACTIONS.has(action)) {
      return Promise.reject(new Error(`不允许的桥接操作: ${action}`));
    }
    if (
      action === "stop"
      || action === "disable"
      || action === "clear_faults"
    ) {
      const broadcast = action !== "clear_faults"
        && params && params.broadcast === true;
      const targetNode = broadcast ? null : this.#requestedNode(params);
      const scope = broadcast
        ? `广播 ${action.toUpperCase()} 请求`
        : `节点 ${Number.isInteger(targetNode) ? targetNode : "未知"} ${action.toUpperCase()} 请求`;
      /*
       * Cancel host-side MOVE delivery before the safety frame is written.
       * This closes the race where an ACK retry could otherwise be emitted
       * after STOP/DISABLE/CLEAR_FAULTS and energize a board again.
       */
      this.#cancelMotionSends(targetNode, scope);
    }
    this.start();
    let requestParams = params;
    if (action === "connect" || action === "disconnect") {
      this.#advanceSession(action);
      requestParams = { ...params, sessionEpoch: this.sessionEpoch };
    }
    const id = this.nextId++;
    const message = JSON.stringify({ id, action, params: requestParams });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`${action} 请求超时`);
        error.code = "BRIDGE_REQUEST_TIMEOUT";
        reject(error);
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        action,
        motionNodeId: (
          MOTION_ACTIONS.has(action) || action === "motion_replay"
        ) ? this.#requestedNode(requestParams) : null,
      });
      this.process.stdin.write(`${message}\n`, "utf8", (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async requestWithAck(
    action,
    params = {},
    timeoutMs = DEVICE_ACK_TIMEOUT_MS,
  ) {
    const requestedNode = this.#requestedNode(params);
    const motionAction = MOTION_ACTIONS.has(action);
    const motionToken = motionAction
      ? Object.freeze({ serial: this.motionCancelSerial })
      : null;
    if (
      motionAction
      && Number.isInteger(requestedNode)
      && this.motionStateUncertain.has(requestedNode)
    ) {
      throw this.#motionUncertainError(
        this.motionStateUncertain.get(requestedNode),
      );
    }
    const expectation = expectedAck(action, params);
    const startedAt = Date.now();
    const requestEpoch = this.sessionEpoch;
    const requestTimeout = motionAction
      ? Math.min(timeoutMs, MOTION_ACK_RETRY_WINDOW_MS)
      : timeoutMs;
    let result;
    try {
      result = await this.request(action, params, requestTimeout);
    } catch (error) {
      if (motionAction) {
        if (error.code === "MOTION_SEND_CANCELLED") throw error;
        this.#throwIfMotionSendCancelled(
          motionToken,
          requestedNode,
          null,
        );
        if (error.code !== "VALIDATION_ERROR") {
          throw this.#setMotionUncertain(requestedNode, null, error);
        }
      }
      throw error;
    }
    if (!expectation || result.broadcast === true) return result;
    if (motionAction) {
      const resultNode = Number.isInteger(result.nodeId)
        ? result.nodeId
        : requestedNode;
      this.#throwIfMotionSendCancelled(
        motionToken,
        resultNode,
        result.sequence,
      );
    }
    if (requestEpoch !== this.sessionEpoch) {
      const error = new Error(`${action} 等待 ACK 时 CAN 会话已改变`);
      error.code = "CAN_SESSION_CHANGED";
      if (motionAction) {
        throw this.#setMotionUncertain(requestedNode, result.sequence, error);
      }
      throw error;
    }
    let nodeId;
    try {
      nodeId = this.#resultNode(action, params, result);
    } catch (error) {
      if (motionAction) {
        throw this.#setMotionUncertain(requestedNode, null, error);
      }
      throw error;
    }
    if (!Number.isInteger(result.sequence)) {
      const error = new Error(`${action} 未返回设备序号`);
      if (motionAction) {
        throw this.#setMotionUncertain(nodeId, null, error);
      }
      throw error;
    }
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(1, timeoutMs - elapsed);
    const ack = motionAction
      ? await this.#waitForMotionAck(
        action,
        expectation,
        result,
        requestEpoch,
        nodeId,
        startedAt,
        timeoutMs,
        motionToken,
      )
      : await this.#waitForAck(
        ackKey(
          requestEpoch,
          nodeId,
          expectation.commandClass,
          expectation.opcode,
          result.sequence,
        ),
        startedAt,
        remaining,
        action,
      );
    if (ack.ok !== true) {
      const error = new Error(
        `${action} 被设备拒绝：${ack.statusName || `状态 ${ack.status}`}`,
      );
      error.code = "DEVICE_ACK_REJECTED";
      error.ack = ack;
      throw error;
    }
    if (
      action === "stop"
      || (action === "disable" && params.broadcast !== true)
      || action === "clear_faults"
    ) {
      this.motionStateUncertain.delete(nodeId);
    }
    if (motionAction) {
      const {
        replayId: _replayId,
        ...publicResult
      } = result;
      return { ...publicResult, ack };
    }
    return { ...result, ack };
  }

  async close() {
    this.#cancelMotionSends(null, "桥接关闭");
    const child = this.process;
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ id: 0, action: "shutdown", params: {} })}\n`);
    } catch (_) {
      // The process may already be exiting.
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.process) child.kill("SIGTERM");
        resolve();
      }, 800);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  cancelMotionForNode(nodeId, reason = "外部安全停止") {
    if (!Number.isInteger(nodeId) || nodeId < 1 || nodeId > 127) {
      throw new RangeError("节点 ID 必须在 1–127 范围内");
    }
    this.#cancelMotionSends(nodeId, reason);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("event", { event: "error", data: { message: `桥接输出不是 JSON: ${error.message}` } });
      return;
    }
    if (message.type === "event") {
      if (message.event === "ack") this.#captureAck(message.data || {});
      this.emit("event", { event: message.event, data: message.data || {} });
      return;
    }
    if (message.type !== "response" || !Number.isInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) {
      const result = message.result || {};
      if (
        (pending.action === "connect" || pending.action === "set_node")
        && Number.isInteger(result.nodeId)
      ) {
        this.defaultNodeId = result.nodeId;
      } else if (pending.action === "disconnect") {
        this.defaultNodeId = null;
      }
      pending.resolve(result);
    }
    else {
      const error = new Error(message.error || "桥接请求失败");
      error.code = typeof message.errorCode === "string"
        ? message.errorCode
        : "BRIDGE_ERROR";
      pending.reject(error);
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.ackWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.ackWaiters.clear();
    this.recentAcks.clear();
  }

  #captureAck(ack) {
    if (
      !Number.isInteger(ack.nodeId)
      || !Number.isInteger(ack.commandClass)
      || !Number.isInteger(ack.opcode)
      || !Number.isInteger(ack.sequence)
    ) return;
    const epoch = Number.isInteger(ack.sessionEpoch)
      ? ack.sessionEpoch
      : this.sessionEpoch;
    const key = ackKey(
      epoch,
      ack.nodeId,
      ack.commandClass,
      ack.opcode,
      ack.sequence,
    );
    const waiter = this.ackWaiters.get(key);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.ackWaiters.delete(key);
      waiter.resolve(ack);
      return;
    }
    const now = Date.now();
    this.#pruneRecentAcks(now);
    this.recentAcks.set(key, { ack, receivedAt: now });
  }

  #waitForAck(key, notBefore, timeoutMs, action) {
    const recent = this.recentAcks.get(key);
    if (recent) {
      this.recentAcks.delete(key);
      if (recent.receivedAt >= notBefore) return Promise.resolve(recent.ack);
    }
    if (this.ackWaiters.has(key)) {
      return Promise.reject(new Error(`设备 ACK 序号冲突: ${key}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(key);
        const error = new Error(`${action} 等待设备 ACK 超时`);
        error.code = "DEVICE_ACK_TIMEOUT";
        reject(error);
      }, timeoutMs);
      this.ackWaiters.set(key, { resolve, reject, timer, action });
    });
  }

  async #waitForMotionAck(
    action,
    expectation,
    result,
    sessionEpoch,
    nodeId,
    startedAt,
    timeoutMs,
    motionToken,
  ) {
    const deadline = startedAt + Math.min(
      timeoutMs,
      MOTION_ACK_RETRY_WINDOW_MS,
    );
    const key = ackKey(
      sessionEpoch,
      nodeId,
      expectation.commandClass,
      expectation.opcode,
      result.sequence,
    );

    for (;;) {
      this.#throwIfMotionSendCancelled(
        motionToken,
        nodeId,
        result.sequence,
      );
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw this.#setMotionUncertain(nodeId, result.sequence);
      }
      try {
        const ack = await this.#waitForAck(
          key,
          startedAt,
          Math.min(MOTION_ACK_RETRY_INTERVAL_MS, remaining),
          action,
        );
        this.#throwIfMotionSendCancelled(
          motionToken,
          nodeId,
          result.sequence,
        );
        return ack;
      } catch (error) {
        if (error.code === "MOTION_SEND_CANCELLED") throw error;
        this.#throwIfMotionSendCancelled(
          motionToken,
          nodeId,
          result.sequence,
        );
        if (error.code !== "DEVICE_ACK_TIMEOUT") {
          throw this.#setMotionUncertain(nodeId, result.sequence, error);
        }
      }

      this.#throwIfMotionSendCancelled(
        motionToken,
        nodeId,
        result.sequence,
      );
      if (Date.now() >= deadline) {
        throw this.#setMotionUncertain(nodeId, result.sequence);
      }
      if (!Number.isInteger(result.replayId)) {
        throw this.#setMotionUncertain(
          nodeId,
          result.sequence,
          new Error("桥接未返回原始运动帧重发标识"),
        );
      }

      const replayTimeout = Math.max(
        1,
        Math.min(
          MOTION_ACK_RETRY_INTERVAL_MS,
          deadline - Date.now(),
        ),
      );
      let replay;
      try {
        replay = await this.request(
          "motion_replay",
          { replayId: result.replayId, nodeId },
          replayTimeout,
        );
      } catch (error) {
        if (error.code === "MOTION_SEND_CANCELLED") throw error;
        this.#throwIfMotionSendCancelled(
          motionToken,
          nodeId,
          result.sequence,
        );
        if (error.code === "BRIDGE_REQUEST_TIMEOUT") {
          continue;
        }
        throw this.#setMotionUncertain(nodeId, result.sequence, error);
      }
      this.#throwIfMotionSendCancelled(
        motionToken,
        nodeId,
        result.sequence,
      );
      if (
        Number(replay.sequence) !== result.sequence
        || Number(replay.replayId) !== result.replayId
        || Number(replay.nodeId) !== nodeId
      ) {
        throw this.#setMotionUncertain(
          nodeId,
          result.sequence,
          new Error("桥接重发标识或运动序号不匹配"),
        );
      }
    }
  }

  #cancelMotionSends(nodeId, reason) {
    const serial = this.motionCancelSerial + 1;
    const detail = Object.freeze({ serial, reason: String(reason || "安全命令") });
    this.motionCancelSerial = serial;
    if (Number.isInteger(nodeId)) {
      this.motionCancelByNode.set(nodeId, detail);
    } else {
      this.motionCancelAll = detail;
    }

    for (const [id, pending] of this.pending) {
      if (
        !MOTION_ACTIONS.has(pending.action)
        && pending.action !== "motion_replay"
      ) continue;
      if (
        Number.isInteger(nodeId)
        && Number.isInteger(pending.motionNodeId)
        && pending.motionNodeId !== nodeId
      ) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(this.#motionSendCancelledError(
        detail,
        pending.motionNodeId,
        null,
      ));
    }

    for (const [key, waiter] of this.ackWaiters) {
      if (!MOTION_ACTIONS.has(waiter.action)) continue;
      const fields = key.split(":");
      const waiterNode = Number(fields[1]);
      const sequence = Number(fields[4]);
      if (Number.isInteger(nodeId) && waiterNode !== nodeId) continue;
      clearTimeout(waiter.timer);
      this.ackWaiters.delete(key);
      waiter.reject(this.#motionSendCancelledError(
        detail,
        waiterNode,
        sequence,
      ));
    }
  }

  #motionCancellationFor(token, nodeId) {
    if (!token) return null;
    const candidates = [];
    if (
      this.motionCancelAll
      && this.motionCancelAll.serial > token.serial
    ) candidates.push(this.motionCancelAll);
    if (Number.isInteger(nodeId)) {
      const nodeCancellation = this.motionCancelByNode.get(nodeId);
      if (
        nodeCancellation
        && nodeCancellation.serial > token.serial
      ) candidates.push(nodeCancellation);
    }
    return candidates.reduce(
      (latest, candidate) => (
        !latest || candidate.serial > latest.serial ? candidate : latest
      ),
      null,
    );
  }

  #throwIfMotionSendCancelled(token, nodeId, sequence) {
    const cancellation = this.#motionCancellationFor(token, nodeId);
    if (cancellation) {
      throw this.#motionSendCancelledError(
        cancellation,
        nodeId,
        sequence,
      );
    }
  }

  #motionSendCancelledError(detail, nodeId, sequence) {
    const node = Number.isInteger(nodeId) ? `节点 ${nodeId} ` : "";
    const sequenceText = Number.isInteger(sequence) ? ` seq ${sequence}` : "";
    const error = new Error(
      `${node}运动发送${sequenceText}已因${detail.reason}取消；未继续 MOVE 重放（含舵机帧）。`,
    );
    error.code = "MOTION_SEND_CANCELLED";
    error.motionSendCancelled = true;
    if (Number.isInteger(nodeId)) error.nodeId = nodeId;
    if (Number.isInteger(sequence)) error.sequence = sequence;
    return error;
  }

  #setMotionUncertain(nodeId, sequence, cause = null) {
    const targetNode = Number.isInteger(nodeId) ? nodeId : null;
    let detail = targetNode === null
      ? null
      : this.motionStateUncertain.get(targetNode);
    if (!detail) {
      detail = {
        nodeId: targetNode,
        sequence: Number.isInteger(sequence) ? sequence : null,
        cause: cause && cause.message ? cause.message : null,
      };
      if (targetNode !== null) {
        this.motionStateUncertain.set(targetNode, detail);
      }
    }
    return this.#motionUncertainError(detail);
  }

  #motionUncertainError(detail) {
    const sequence = Number.isInteger(detail && detail.sequence)
      ? ` seq ${detail.sequence}`
      : "";
    const cause = detail && detail.cause ? `（${detail.cause}）` : "";
    const node = Number.isInteger(detail && detail.nodeId)
      ? `节点 ${detail.nodeId} `
      : "";
    const error = new Error(
      `${node}运动${sequence}未能在 MCU 2 秒去重窗口内确认 ACK${cause}；`
      + "执行状态不确定，已阻止生成新的运动序号。"
      + "请先发送定址 STOP 或 DISABLE 清空 MCU FIFO，再重新下发动作。",
    );
    error.code = "MOTION_STATE_UNCERTAIN";
    error.motionStateUncertain = true;
    if (Number.isInteger(detail && detail.nodeId)) {
      error.nodeId = detail.nodeId;
    }
    if (Number.isInteger(detail && detail.sequence)) {
      error.sequence = detail.sequence;
    }
    return error;
  }

  #pruneRecentAcks(now = Date.now()) {
    for (const [key, item] of this.recentAcks) {
      if (now - item.receivedAt > RECENT_ACK_TTL_MS) {
        this.recentAcks.delete(key);
      }
    }
  }

  #requestedNode(params) {
    if (Number.isInteger(params && params.nodeId)) return params.nodeId;
    return Number.isInteger(this.defaultNodeId) ? this.defaultNodeId : null;
  }

  #resultNode(action, params, result) {
    if (!ADDRESSED_ACTIONS.has(action)) return null;
    const nodeId = result.nodeId;
    if (!Number.isInteger(nodeId) || nodeId < 1 || nodeId > 127) {
      const error = new Error(`${action} 未返回有效目标节点`);
      error.code = "BRIDGE_INVALID_NODE_RESULT";
      throw error;
    }
    const requestedNode = this.#requestedNode(params);
    if (Number.isInteger(requestedNode) && requestedNode !== nodeId) {
      const error = new Error(
        `${action} 返回节点 ${nodeId}，与请求节点 ${requestedNode} 不一致`,
      );
      error.code = "BRIDGE_NODE_MISMATCH";
      throw error;
    }
    return nodeId;
  }

  #advanceSession(action) {
    this.#cancelMotionSends(null, `CAN 会话切换（${action}）`);
    this.sessionEpoch += 1;
    this.defaultNodeId = null;
    const error = new Error(`${action} 已切换 CAN 会话`);
    error.code = "CAN_SESSION_CHANGED";
    for (const waiter of this.ackWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.ackWaiters.clear();
    this.recentAcks.clear();
  }
}

module.exports = {
  ACTIONS,
  BridgeClient,
  DEVICE_ACK_TIMEOUT_MS,
  MOTION_ACK_RETRY_INTERVAL_MS,
  MOTION_ACK_RETRY_WINDOW_MS,
  expectedAck,
};
