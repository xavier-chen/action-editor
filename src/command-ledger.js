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

  function setSummaryValue(summary, key, value) {
    Object.defineProperty(summary, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  function frozenPositionSummary(positions, keyForEntry = (key) => key) {
    const summary = {};
    for (const [key, steps] of positions) {
      if (steps !== 0) setSummaryValue(summary, keyForEntry(key), steps);
    }
    return Object.freeze(summary);
  }

  class CommandLedger {
    constructor() {
      this._entries = [];
      this._nextEntryNumber = 1;
      this._revision = 0;
      // These compact indexes make status rendering proportional to the number
      // of configured motors/nodes, rather than to the unbounded command log.
      // Zero-valued keys are retained so positionSummary keeps the historical
      // first-seen property order used by the former log scan.
      this._motorPositions = new Map();
      this._nodePositions = new Map();
      this._latestNodeEntries = new Map();
      this._positionSummaryCache = null;
      this._nodePositionSummaryCache = null;
      this._returnCommandsCache = null;
    }

    get size() {
      return this._entries.length;
    }

    _append(command, actual, source) {
      const steps = actualSteps(command, actual);
      if (steps === 0) return null;
      const motorPosition = safePositionAdd(
        this._motorPositions.get(command.motorId) || 0,
        steps,
      );
      const nodePosition = safePositionAdd(
        this._nodePositions.get(command.nodeId) || 0,
        steps,
      );
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
      this._motorPositions.set(entry.motorId, motorPosition);
      this._nodePositions.set(entry.nodeId, nodePosition);
      // Map insertion order doubles as the node's latest-activity order.
      this._latestNodeEntries.delete(entry.nodeId);
      this._latestNodeEntries.set(entry.nodeId, entry);
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
      if (this._positionSummaryCache?.revision !== this._revision) {
        this._positionSummaryCache = {
          revision: this._revision,
          value: frozenPositionSummary(this._motorPositions),
        };
      }
      return this._positionSummaryCache.value;
    }

    nodePositionSummary() {
      if (this._nodePositionSummaryCache?.revision !== this._revision) {
        this._nodePositionSummaryCache = {
          revision: this._revision,
          value: frozenPositionSummary(this._nodePositions, String),
        };
      }
      return this._nodePositionSummaryCache.value;
    }

    createReturnCommands() {
      if (this._returnCommandsCache?.revision === this._revision) {
        return this._returnCommandsCache.value;
      }

      const commands = [];
      const latestEntries = Array.from(this._latestNodeEntries.values()).reverse();
      for (const recent of latestEntries) {
        const nodeId = recent.nodeId;
        let remaining = -(this._nodePositions.get(nodeId) || 0);
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
      const value = freezeArray(commands);
      this._returnCommandsCache = { revision: this._revision, value };
      return value;
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
      this._motorPositions.clear();
      this._nodePositions.clear();
      this._latestNodeEntries.clear();
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
