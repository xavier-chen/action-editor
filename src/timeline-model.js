"use strict";

(function exposeTimelineModel(root, factory) {
  const registry = typeof module === "object" && module.exports
    ? require("./motor-registry")
    : root?.FaceMotorRegistry;
  const commandModel = typeof module === "object" && module.exports
    ? require("./command-ledger")
    : root?.FaceCommandLedger;
  const value = factory(registry, commandModel);
  if (typeof module === "object" && module.exports) module.exports = value;
  if (root) root.FaceTimelineModel = value;
}(typeof globalThis !== "undefined" ? globalThis : this, (registry, commandModel) => {
  if (!registry || !commandModel) throw new Error("时间轨模型缺少电机注册表或指令模型");

  const MAX_ACTIONS = 512;
  const MAX_START_MS = 10 * 60 * 1_000;
  const VALID_MICROSTEPS = Object.freeze([1, 2, 4, 8, 16, 32, 64, 128, 256]);
  const LEVEL_SQUARE_DENOMINATOR = 100 * 100;
  const DYNAMIC_LIMIT_NUMERATOR = 4;
  const DYNAMIC_LIMIT_DENOMINATOR = 5;
  const DEFAULT_MOTION_PROFILE = Object.freeze({
    fullSteps: 200,
    microsteps: 128,
    speedLimitRpm: 3_000,
    accelerationLimitRpmS: 20_000,
    sCurveTimeMs: 10,
  });

  function plainRecord(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${label}必须是对象`);
    }
    return value;
  }

  function onlyKeys(record, allowed, label) {
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) throw new TypeError(`${label}包含未知字段: ${key}`);
    }
  }

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

  function actionIdValue(value) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError("actionId 必须是非空字符串");
    }
    return value.trim();
  }

  function normalizeMotionProfile(input = DEFAULT_MOTION_PROFILE) {
    const record = plainRecord(input, "电机运动参数");
    onlyKeys(
      record,
      new Set(["fullSteps", "microsteps", "speedLimitRpm", "accelerationLimitRpmS", "sCurveTimeMs"]),
      "电机运动参数",
    );
    const profile = {
      fullSteps: integer(record.fullSteps, "每圈整步数", 4, 2_000),
      microsteps: integer(record.microsteps, "微步细分", 1, 256),
      speedLimitRpm: integer(record.speedLimitRpm, "速度上限 RPM", 1, 5_000),
      accelerationLimitRpmS: integer(record.accelerationLimitRpmS, "加速度上限 RPM/s", 1, 20_000),
      sCurveTimeMs: integer(record.sCurveTimeMs, "S 曲线时间", 0, 2_000),
    };
    if (profile.fullSteps % 4 !== 0) throw new RangeError("每圈整步数必须是 4 的倍数");
    if (!VALID_MICROSTEPS.includes(profile.microsteps)) {
      throw new RangeError("微步细分必须是 1、2、4、8、16、32、64、128 或 256");
    }
    return Object.freeze(profile);
  }

  function roundPositiveRatio(numerator, denominator) {
    return Math.floor((numerator + denominator / 2) / denominator);
  }

  function motionRatesFromLevels(speedLevel, accelerationLevel, profileInput = DEFAULT_MOTION_PROFILE) {
    const speed = integer(speedLevel, "速度等级", 1, 100);
    const acceleration = integer(accelerationLevel, "加速度等级", 0, 100);
    const profile = normalizeMotionProfile(profileInput);
    const microstepsPerRevolution = profile.fullSteps * profile.microsteps;
    const rateDenominator = 60 * LEVEL_SQUARE_DENOMINATOR;
    const requestedSpeed = Math.max(1, roundPositiveRatio(
      profile.speedLimitRpm * microstepsPerRevolution * speed * speed,
      rateDenominator,
    ));
    const accelerationBypassed = acceleration === 0;
    const requestedAcceleration = accelerationBypassed ? null : Math.max(1, roundPositiveRatio(
      profile.accelerationLimitRpmS * microstepsPerRevolution * acceleration * acceleration,
      rateDenominator,
    ));
    const firmwareSpeed = 10_000 * profile.microsteps - 2_500;
    const firmwareAcceleration = Math.min(375_000 * profile.microsteps, 1_875_000);
    const speedBoundary = Math.max(1, Math.floor(
      firmwareSpeed * DYNAMIC_LIMIT_NUMERATOR / DYNAMIC_LIMIT_DENOMINATOR,
    ));
    const accelerationBoundary = Math.max(1, Math.floor(
      firmwareAcceleration * DYNAMIC_LIMIT_NUMERATOR / DYNAMIC_LIMIT_DENOMINATOR,
    ));
    const actualSpeed = Math.min(requestedSpeed, speedBoundary);
    const actualAcceleration = accelerationBypassed
      ? null
      : Math.min(requestedAcceleration, accelerationBoundary);
    return Object.freeze({
      profile,
      actualSpeed,
      actualAcceleration,
      requestedSpeed,
      requestedAcceleration,
      accelerationBypassed,
      speedClamped: requestedSpeed !== actualSpeed,
      accelerationClamped: accelerationBypassed ? false : requestedAcceleration !== actualAcceleration,
    });
  }

  function estimateMotionDuration(input, profileInput = DEFAULT_MOTION_PROFILE) {
    const record = plainRecord(input, "动作参数");
    const count = integer(record.count, "微步数", 1, commandModel.MAX_STEP_COUNT);
    const speedLevel = integer(record.speedLevel, "速度等级", 1, 100);
    const accelerationLevel = integer(record.accelerationLevel, "加速度等级", 0, 100);
    const rates = motionRatesFromLevels(speedLevel, accelerationLevel, profileInput);
    if (rates.accelerationBypassed) {
      const rawDurationMs = count * 1_000 / rates.actualSpeed;
      return Object.freeze({
        ...rates,
        count,
        speedLevel,
        accelerationLevel,
        profileType: "immediate",
        peakSpeed: rates.actualSpeed,
        transitionTimeMs: 0,
        transitionDistance: 0,
        cruiseDistance: count,
        rawDurationMs,
        durationMs: Math.max(1, Math.ceil(rawDurationMs)),
      });
    }

    /*
     * This is the same continuous S-curve preview used by Protocol 6.  One
     * acceleration transition and one deceleration transition each last T;
     * their combined distance is peakSpeed * T.  Short moves therefore form
     * a triangular S-curve, while longer moves add a constant-speed section.
     */
    const minimumTransitionSeconds = rates.profile.sCurveTimeMs / 1_000;
    const transitionBoundaryDistance = (
      rates.actualAcceleration
      * minimumTransitionSeconds
      * minimumTransitionSeconds
      / 2
    );
    const unconstrainedPeak = (
      minimumTransitionSeconds > 0
      && count <= transitionBoundaryDistance
    )
      ? count / minimumTransitionSeconds
      : Math.sqrt(rates.actualAcceleration * count / 2);
    const peakSpeed = Math.min(rates.actualSpeed, unconstrainedPeak);
    const transitionTimeSeconds = Math.max(
      minimumTransitionSeconds,
      2 * peakSpeed / rates.actualAcceleration,
    );
    const transitionDistance = peakSpeed * transitionTimeSeconds;
    const cruiseDistance = Math.max(0, count - transitionDistance);
    const rawDurationMs = (
      2 * transitionTimeSeconds
      + cruiseDistance / peakSpeed
    ) * 1_000;
    return Object.freeze({
      ...rates,
      count,
      speedLevel,
      accelerationLevel,
      profileType: cruiseDistance > 0.000001 ? "s-curve-cruise" : "s-curve",
      peakSpeed,
      transitionTimeMs: transitionTimeSeconds * 1_000,
      transitionDistance,
      cruiseDistance,
      rawDurationMs,
      durationMs: Math.max(1, Math.ceil(rawDurationMs)),
    });
  }

  function estimateActionDuration(actionInput, profileInput = DEFAULT_MOTION_PROFILE) {
    const action = validateAction(actionInput);
    return estimateMotionDuration({
      count: Math.abs(action.signedSteps),
      speedLevel: action.speed,
      accelerationLevel: action.acceleration,
    }, profileInput);
  }

  function validateAction(input) {
    const record = plainRecord(input, "时间轨动作");
    onlyKeys(
      record,
      new Set(["actionId", "motorId", "nodeId", "startMs", "signedSteps", "speed", "acceleration", "closed"]),
      "时间轨动作",
    );
    const motorId = registry.normalizeMotorId(record.motorId);
    const command = commandModel.validateCommand({
      motorId,
      nodeId: record.nodeId,
      signedSteps: record.signedSteps,
      speed: record.speed,
      acceleration: record.acceleration,
      closed: record.closed,
    });
    return Object.freeze({
      ...(record.actionId === undefined ? {} : { actionId: actionIdValue(record.actionId) }),
      motorId: command.motorId,
      nodeId: command.nodeId,
      startMs: integer(record.startMs, "开始时间", 0, MAX_START_MS),
      signedSteps: command.signedSteps,
      speed: command.speed,
      acceleration: command.acceleration,
      closed: command.closed,
    });
  }

  function snapStartMs(value, snapMs = 100, maximum = MAX_START_MS) {
    const raw = Number(value);
    const snap = integer(snapMs, "吸附间隔", 0, 10_000);
    const max = integer(maximum, "时间轨上限", 0, MAX_START_MS);
    if (!Number.isFinite(raw)) throw new TypeError("开始时间必须是数字");
    const clamped = Math.min(max, Math.max(0, raw));
    const snapped = snap === 0 ? Math.round(clamped) : Math.round(clamped / snap) * snap;
    return Math.min(max, Math.max(0, snapped));
  }

  function millisecondsFromPixels(pixels, pixelsPerSecond) {
    const distance = Number(pixels);
    const scale = Number(pixelsPerSecond);
    if (!Number.isFinite(distance)) throw new TypeError("拖拽距离必须是数字");
    if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("时间轨缩放必须大于 0");
    return distance * 1_000 / scale;
  }

  function shiftTimelineStartMs(
    originalStartMs,
    pointerDeltaPixels,
    scrollDeltaPixels,
    pixelsPerSecond,
    snapMs = 100,
    maximum = MAX_START_MS,
  ) {
    const original = integer(originalStartMs, "原开始时间", 0, MAX_START_MS);
    const pointerDelta = Number(pointerDeltaPixels);
    const scrollDelta = Number(scrollDeltaPixels);
    if (!Number.isFinite(pointerDelta) || !Number.isFinite(scrollDelta)) {
      throw new TypeError("拖拽位移必须是数字");
    }
    const shifted = original + millisecondsFromPixels(
      pointerDelta + scrollDelta,
      pixelsPerSecond,
    );
    return snapStartMs(shifted, snapMs, maximum);
  }

  function freezeArray(items) {
    return Object.freeze(items.slice());
  }

  class TimelineProgram {
    constructor(actions = []) {
      if (!Array.isArray(actions)) throw new TypeError("时间轨动作必须是数组");
      this._actions = [];
      this._actionIds = new Set();
      this._nextActionNumber = 1;
      this._revision = 0;
      for (const action of actions) this.add(action);
    }

    get size() {
      return this._actions.length;
    }

    get revision() {
      return this._revision;
    }

    _nextId() {
      let candidate;
      do {
        candidate = `action-${String(this._nextActionNumber).padStart(6, "0")}`;
        this._nextActionNumber += 1;
      } while (this._actionIds.has(candidate));
      return candidate;
    }

    add(input) {
      if (this.size >= MAX_ACTIONS) throw new RangeError(`时间轨最多 ${MAX_ACTIONS} 个动作`);
      const validated = validateAction(input);
      const actionId = validated.actionId || this._nextId();
      if (this._actionIds.has(actionId)) throw new RangeError(`actionId 已存在: ${actionId}`);
      const action = Object.freeze({ ...validated, actionId });
      this._actions.push(action);
      this._actionIds.add(actionId);
      this._revision += 1;
      return action;
    }

    get(actionId) {
      const id = actionIdValue(actionId);
      return this._actions.find((action) => action.actionId === id) || null;
    }

    update(actionId, patch) {
      const id = actionIdValue(actionId);
      const index = this._actions.findIndex((action) => action.actionId === id);
      if (index < 0) throw new RangeError(`没有这个时间轨动作: ${id}`);
      const changes = plainRecord(patch, "动作更新");
      if (changes.actionId !== undefined && actionIdValue(changes.actionId) !== id) {
        throw new RangeError("不能修改 actionId");
      }
      const next = validateAction({ ...this._actions[index], ...changes, actionId: id });
      this._actions[index] = next;
      this._revision += 1;
      return next;
    }

    remove(actionId) {
      const id = actionIdValue(actionId);
      const index = this._actions.findIndex((action) => action.actionId === id);
      if (index < 0) return null;
      const [removed] = this._actions.splice(index, 1);
      this._actionIds.delete(id);
      this._revision += 1;
      return removed;
    }

    clear() {
      const removed = this.size;
      if (removed) {
        this._actions.length = 0;
        this._actionIds.clear();
        this._revision += 1;
      }
      return removed;
    }

    snapshot() {
      return freezeArray(this._actions);
    }

    groups() {
      const ordered = this._actions
        .map((action, insertionIndex) => ({ action, insertionIndex }))
        .sort((left, right) => (
          left.action.startMs - right.action.startMs
          || left.insertionIndex - right.insertionIndex
        ));
      const groups = [];
      for (const { action } of ordered) {
        const previous = groups.at(-1);
        if (previous && previous.startMs === action.startMs) {
          previous.actions.push(action);
        } else {
          groups.push({ startMs: action.startMs, actions: [action] });
        }
      }
      return freezeArray(groups.map((group) => Object.freeze({
        startMs: group.startMs,
        actions: freezeArray(group.actions),
      })));
    }

    conflicts() {
      const buckets = new Map();
      for (const action of this._actions) {
        const key = `${action.startMs}:${action.nodeId}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(action);
      }
      return freezeArray([...buckets.values()]
        .filter((actions) => actions.length > 1)
        .map((actions) => Object.freeze({
          startMs: actions[0].startMs,
          nodeId: actions[0].nodeId,
          actions: freezeArray(actions),
        })));
    }
  }

  return Object.freeze({
    MAX_ACTIONS,
    MAX_START_MS,
    DEFAULT_MOTION_PROFILE,
    normalizeMotionProfile,
    motionRatesFromLevels,
    estimateMotionDuration,
    estimateActionDuration,
    validateAction,
    snapStartMs,
    millisecondsFromPixels,
    shiftTimelineStartMs,
    TimelineProgram,
  });
}));
