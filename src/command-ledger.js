"use strict";

(function exposeCommandLedger(root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  if (root) root.FaceCommandLedger = value;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const MAX_PROGRAM_COMMANDS = 256;
  const MAX_STEP_COUNT = 0xFFFFFF;

  function integer(value, label, minimum, maximum) {
    if (value === null || value === "" || typeof value === "boolean") {
      throw new TypeError(`${label}必须是整数`);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new TypeError(`${label}必须是整数`);
    if (number < minimum || number > maximum) {
      throw new RangeError(`${label}必须为 ${minimum}–${maximum}`);
    }
    return number;
  }

  function motorIdValue(value) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError("电机位置不能为空");
    }
    return value.trim();
  }

  function commandIdValue(value) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError("commandId 必须是非空字符串");
    }
    return value.trim();
  }

  function signedStepsValue(value) {
    if (value === null || value === "" || typeof value === "boolean") {
      throw new TypeError("步数必须是非零整数");
    }
    const steps = Number(value);
    if (!Number.isSafeInteger(steps)) throw new TypeError("步数必须是非零整数");
    if (steps === 0 || Math.abs(steps) > MAX_STEP_COUNT) {
      throw new RangeError(`步数绝对值必须为 1–${MAX_STEP_COUNT}`);
    }
    return steps;
  }

  function closedValue(value) {
    if (value === undefined) return false;
    if (typeof value !== "boolean") throw new TypeError("闭环模式必须是布尔值");
    return value;
  }

  /**
   * Validate form input and return the canonical command shape. Numeric form
   * strings are accepted, while empty strings, booleans and fractional values
   * are rejected.
   */
  function validateCommand(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("指令必须是对象");
    }
    const command = {
      motorId: motorIdValue(input.motorId),
      nodeId: integer(input.nodeId, "电机 ID", 1, 127),
      signedSteps: signedStepsValue(input.signedSteps),
      speed: integer(input.speed, "速度", 1, 100),
      acceleration: integer(input.acceleration, "加速度", 1, 100),
      closed: closedValue(input.closed),
    };
    if (input.commandId !== undefined && input.commandId !== null) {
      command.commandId = commandIdValue(input.commandId);
    }
    return Object.freeze(command);
  }

  function toBridgePayload(input) {
    const command = validateCommand(input);
    return Object.freeze({
      nodeId: command.nodeId,
      direction: command.signedSteps < 0 ? 1 : 0,
      count: Math.abs(command.signedSteps),
      speedLevel: command.speed,
      accelerationLevel: command.acceleration,
      closed: command.closed,
    });
  }

  function freezeArray(items) {
    return Object.freeze(items.slice());
  }

  class CommandProgram {
    constructor(commands = []) {
      if (!Array.isArray(commands)) throw new TypeError("初始指令必须是数组");
      this._commands = [];
      this._commandIds = new Set();
      this._nextCommandNumber = 1;
      for (const command of commands) this.add(command);
    }

    get size() {
      return this._commands.length;
    }

    _nextId() {
      let candidate;
      do {
        candidate = `command-${String(this._nextCommandNumber).padStart(6, "0")}`;
        this._nextCommandNumber += 1;
      } while (this._commandIds.has(candidate));
      return candidate;
    }

    add(input) {
      if (this.size >= MAX_PROGRAM_COMMANDS) {
        throw new RangeError(`指令程序最多 ${MAX_PROGRAM_COMMANDS} 条`);
      }
      const validated = validateCommand(input);
      const commandId = validated.commandId || this._nextId();
      if (this._commandIds.has(commandId)) {
        throw new RangeError(`commandId 已存在: ${commandId}`);
      }
      const command = Object.freeze({
        commandId,
        motorId: validated.motorId,
        nodeId: validated.nodeId,
        signedSteps: validated.signedSteps,
        speed: validated.speed,
        acceleration: validated.acceleration,
        closed: validated.closed,
      });
      this._commands.push(command);
      this._commandIds.add(commandId);
      return command;
    }

    remove(commandId) {
      const id = commandIdValue(commandId);
      const index = this._commands.findIndex((command) => command.commandId === id);
      if (index < 0) return null;
      const [removed] = this._commands.splice(index, 1);
      this._commandIds.delete(id);
      return removed;
    }

    clear() {
      const removed = this.size;
      this._commands.length = 0;
      this._commandIds.clear();
      return removed;
    }

    snapshot() {
      return freezeArray(this._commands);
    }
  }

  function actualSteps(command, actual) {
    if (actual === undefined || actual === true) return command.signedSteps;
    let candidate = actual;
    if (actual && typeof actual === "object") {
      candidate = actual.actualSignedSteps
        ?? actual.signedSteps
        ?? actual.value?.actualSignedSteps
        ?? actual.value?.signedSteps;
    }
    if (candidate === undefined) return command.signedSteps;
    if (candidate === null || candidate === "" || typeof candidate === "boolean") {
      throw new TypeError("实际步数必须是整数");
    }
    const steps = Number(candidate);
    if (!Number.isSafeInteger(steps)) throw new TypeError("实际步数必须是整数");
    if (Math.abs(steps) > MAX_STEP_COUNT) {
      throw new RangeError(`实际步数绝对值不能超过 ${MAX_STEP_COUNT}`);
    }
    return steps;
  }

  function resultSucceeded(result) {
    if (result === true) return true;
    if (!result || typeof result !== "object") return false;
    if (result.status === "fulfilled") return true;
    return result.success === true || result.ok === true;
  }

  function safePositionAdd(current, amount) {
    const next = current + amount;
    if (!Number.isSafeInteger(next)) throw new RangeError("累计位置超出安全整数范围");
    return next;
  }

  function idFragment(value) {
    return encodeURIComponent(value).replaceAll("%", "_");
  }

  class CommandLedger {
    constructor() {
      this._entries = [];
      this._nextEntryNumber = 1;
      this._revision = 0;
    }

    get size() {
      return this._entries.length;
    }

    _append(command, actual, source) {
      const steps = actualSteps(command, actual);
      if (steps === 0) return null;
      const entry = Object.freeze({
        entryId: `entry-${String(this._nextEntryNumber).padStart(6, "0")}`,
        commandId: command.commandId || null,
        motorId: command.motorId,
        nodeId: command.nodeId,
        signedSteps: steps,
        speed: command.speed,
        acceleration: command.acceleration,
        closed: command.closed,
        source,
      });
      this._nextEntryNumber += 1;
      this._entries.push(entry);
      this._revision += 1;
      return entry;
    }

    recordSuccess(input, actual) {
      const command = validateCommand(input);
      return this._append(command, actual, "command");
    }

    snapshot() {
      return freezeArray(this._entries);
    }

    positionSummary() {
      const positions = {};
      for (const entry of this._entries) {
        const next = safePositionAdd(
          Object.hasOwn(positions, entry.motorId) ? positions[entry.motorId] : 0,
          entry.signedSteps,
        );
        Object.defineProperty(positions, entry.motorId, {
          value: next,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      for (const [motorId, steps] of Object.entries(positions)) {
        if (steps === 0) delete positions[motorId];
      }
      return Object.freeze(positions);
    }

    nodePositionSummary() {
      const positions = {};
      for (const entry of this._entries) {
        const nodeKey = String(entry.nodeId);
        const next = safePositionAdd(
          Object.hasOwn(positions, nodeKey) ? positions[nodeKey] : 0,
          entry.signedSteps,
        );
        Object.defineProperty(positions, nodeKey, {
          value: next,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      for (const [nodeId, steps] of Object.entries(positions)) {
        if (steps === 0) delete positions[nodeId];
      }
      return Object.freeze(positions);
    }

    createReturnCommands() {
      const positions = this.nodePositionSummary();
      const latest = new Map();
      const nodeOrder = [];
      for (let index = this._entries.length - 1; index >= 0; index -= 1) {
        const entry = this._entries[index];
        const nodeKey = String(entry.nodeId);
        if (!Object.hasOwn(positions, nodeKey) || latest.has(entry.nodeId)) continue;
        latest.set(entry.nodeId, entry);
        nodeOrder.push(entry.nodeId);
      }

      const commands = [];
      for (const nodeId of nodeOrder) {
        const recent = latest.get(nodeId);
        let remaining = -positions[String(nodeId)];
        let chunk = 1;
        while (remaining !== 0) {
          const signedSteps = Math.sign(remaining) * Math.min(
            Math.abs(remaining),
            MAX_STEP_COUNT,
          );
          commands.push(validateCommand({
            commandId: `return-${this._revision}-node-${idFragment(nodeId)}-${chunk}`,
            motorId: recent.motorId,
            nodeId,
            signedSteps,
            speed: recent.speed,
            acceleration: recent.acceleration,
            closed: recent.closed,
          }));
          remaining -= signedSteps;
          chunk += 1;
        }
      }
      return freezeArray(commands);
    }

    markReturnResults(commands, results) {
      if (!Array.isArray(commands) || !Array.isArray(results)) {
        throw new TypeError("返回指令和结果必须是数组");
      }
      if (commands.length !== results.length) {
        throw new RangeError("返回指令和结果数量必须一致");
      }

      const succeededCommandIds = [];
      const failedCommandIds = [];
      for (let index = 0; index < commands.length; index += 1) {
        const command = validateCommand(commands[index]);
        const result = results[index];
        if (resultSucceeded(result)) {
          this._append(command, result, "return");
          succeededCommandIds.push(command.commandId || null);
        } else {
          failedCommandIds.push(command.commandId || null);
        }
      }

      const allSucceeded = failedCommandIds.length === 0;
      const atOrigin = Object.keys(this.nodePositionSummary()).length === 0;
      const cleared = allSucceeded && atOrigin;
      if (cleared) this.clear();
      return Object.freeze({
        allSucceeded,
        cleared,
        succeededCommandIds: freezeArray(succeededCommandIds),
        failedCommandIds: freezeArray(failedCommandIds),
        remainingPositions: this.positionSummary(),
      });
    }

    clear() {
      const removed = this.size;
      this._entries.length = 0;
      this._revision += 1;
      return removed;
    }
  }

  return Object.freeze({
    MAX_PROGRAM_COMMANDS,
    MAX_STEP_COUNT,
    validateCommand,
    toBridgePayload,
    CommandProgram,
    CommandLedger,
  });
}));
