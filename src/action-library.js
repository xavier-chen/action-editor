"use strict";

(function exposeActionLibrary(root, factory) {
  const registry = typeof module === "object" && module.exports
    ? require("./motor-registry")
    : root?.FaceMotorRegistry;
  const value = factory(registry);
  if (typeof module === "object" && module.exports) module.exports = value;
  if (root) root.FaceActionLibrary = value;
}(typeof globalThis !== "undefined" ? globalThis : this, (registry) => {
  if (!registry) throw new Error("命名动作模型缺少电机注册表");

  const MAX_ACTION_NAME_LENGTH = 32;
  const MAX_ACTION_DEFINITIONS = 128;
  const MAX_MOTIONS_PER_DEFINITION = 128;
  const MAX_PLACEMENTS = 512;
  const MAX_ACTION_TRACKS = 128;
  const MAX_ACTION_TRACK_NAME_LENGTH = 24;
  const MAX_START_MS = 10 * 60 * 1_000;
  const MAX_STEP_COUNT = 0xFFFFFF;

  function plainRecord(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${label}必须是对象`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label}必须是普通对象`);
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

  function stableId(value, fieldName) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`${fieldName} 必须是非空字符串`);
    }
    return value.trim();
  }

  function actionName(value) {
    if (typeof value !== "string") throw new TypeError("动作名称必须是字符串");
    const normalized = value.trim().normalize("NFC");
    const length = [...normalized].length;
    if (length < 1 || length > MAX_ACTION_NAME_LENGTH) {
      throw new RangeError(`动作名称长度必须为 1–${MAX_ACTION_NAME_LENGTH} 个字符`);
    }
    return normalized;
  }

  function actionTrackName(value) {
    if (typeof value !== "string") throw new TypeError("轨道名称必须是字符串");
    const normalized = value.trim().normalize("NFC");
    const length = [...normalized].length;
    if (length < 1 || length > MAX_ACTION_TRACK_NAME_LENGTH) {
      throw new RangeError(`轨道名称长度必须为 1–${MAX_ACTION_TRACK_NAME_LENGTH} 个字符`);
    }
    return normalized;
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

  function freezeArray(items) {
    return Object.freeze(items.slice());
  }

  function validateMotion(input) {
    const record = plainRecord(input, "动作运动片段");
    onlyKeys(
      record,
      new Set([
        "motionId",
        "motorId",
        "nodeId",
        "startMs",
        "signedSteps",
        "speed",
        "acceleration",
        "closed",
      ]),
      "动作运动片段",
    );
    return Object.freeze({
      ...(record.motionId === undefined
        ? {}
        : { motionId: stableId(record.motionId, "motionId") }),
      motorId: registry.normalizeMotorId(record.motorId),
      nodeId: integer(record.nodeId, "电机 ID", 1, 127),
      startMs: integer(record.startMs, "开始时间", 0, MAX_START_MS),
      signedSteps: signedStepsValue(record.signedSteps),
      speed: integer(record.speed, "速度", 1, 100),
      acceleration: integer(record.acceleration, "加速度", 1, 100),
      closed: closedValue(record.closed),
    });
  }

  function validateActionDefinition(input) {
    const record = plainRecord(input, "命名动作");
    onlyKeys(
      record,
      new Set(["actionDefinitionId", "name", "motions"]),
      "命名动作",
    );
    if (!Array.isArray(record.motions)) throw new TypeError("动作运动片段必须是数组");
    if (record.motions.length < 1 || record.motions.length > MAX_MOTIONS_PER_DEFINITION) {
      throw new RangeError(`每个动作必须包含 1–${MAX_MOTIONS_PER_DEFINITION} 个运动片段`);
    }
    return Object.freeze({
      ...(record.actionDefinitionId === undefined
        ? {}
        : { actionDefinitionId: stableId(record.actionDefinitionId, "actionDefinitionId") }),
      name: actionName(record.name),
      motions: freezeArray(record.motions.map(validateMotion)),
    });
  }

  function deriveMotionLanes(motions, motorOrder = []) {
    if (!Array.isArray(motions)) throw new TypeError("动作运动片段必须是数组");
    if (!Array.isArray(motorOrder)) throw new TypeError("电机顺序必须是数组");

    const orderByMotorId = new Map();
    for (const motorId of motorOrder) {
      const normalizedMotorId = registry.normalizeMotorId(motorId);
      if (!orderByMotorId.has(normalizedMotorId)) {
        orderByMotorId.set(normalizedMotorId, orderByMotorId.size);
      }
    }

    const laneByMotorId = new Map();
    motions.forEach((motionInput, index) => {
      const motion = validateMotion(motionInput);
      let lane = laneByMotorId.get(motion.motorId);
      if (!lane) {
        lane = { motorId: motion.motorId, firstIndex: index, entries: [] };
        laneByMotorId.set(motion.motorId, lane);
      }
      lane.entries.push(Object.freeze({ motion, index }));
    });

    return freezeArray([...laneByMotorId.values()]
      .sort((left, right) => {
        const leftOrder = orderByMotorId.has(left.motorId)
          ? orderByMotorId.get(left.motorId)
          : Number.MAX_SAFE_INTEGER;
        const rightOrder = orderByMotorId.has(right.motorId)
          ? orderByMotorId.get(right.motorId)
          : Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.firstIndex - right.firstIndex;
      })
      .map((lane) => Object.freeze({
        motorId: lane.motorId,
        entries: freezeArray(lane.entries.slice().sort((left, right) => (
          left.motion.startMs - right.motion.startMs || left.index - right.index
        ))),
      })));
  }

  function validatePlacement(input) {
    const record = plainRecord(input, "动作时间轴放置项");
    onlyKeys(
      record,
      new Set(["placementId", "actionDefinitionId", "trackId", "startMs"]),
      "动作时间轴放置项",
    );
    return Object.freeze({
      ...(record.placementId === undefined
        ? {}
        : { placementId: stableId(record.placementId, "placementId") }),
      actionDefinitionId: stableId(record.actionDefinitionId, "actionDefinitionId"),
      ...(record.trackId === undefined ? {} : { trackId: stableId(record.trackId, "trackId") }),
      startMs: integer(record.startMs, "开始时间", 0, MAX_START_MS),
    });
  }

  function validateActionTrack(input) {
    const record = plainRecord(input, "动作时间轴轨道");
    onlyKeys(record, new Set(["trackId", "name"]), "动作时间轴轨道");
    return Object.freeze({
      ...(record.trackId === undefined ? {} : { trackId: stableId(record.trackId, "trackId") }),
      name: actionTrackName(record.name),
    });
  }

  function nextGeneratedId(prefix, usedIds, nextNumber) {
    let candidate;
    do {
      candidate = `${prefix}-${String(nextNumber.value).padStart(6, "0")}`;
      nextNumber.value += 1;
    } while (usedIds.has(candidate));
    usedIds.add(candidate);
    return candidate;
  }

  function observeGeneratedId(id, prefix, nextNumber) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    if (!match) return;
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number >= nextNumber.value) {
      nextNumber.value = number + 1;
    }
  }

  function activeMotionOwners(definitions) {
    const owners = new Map();
    for (const definition of definitions) {
      for (const motion of definition.motions) {
        owners.set(motion.motionId, definition.actionDefinitionId);
      }
    }
    return owners;
  }

  function canonicalDefinition(validated, context, policy) {
    let definitionId = validated.actionDefinitionId;
    if (definitionId === undefined) {
      definitionId = nextGeneratedId(
        "action-definition",
        context.usedDefinitionIds,
        context.nextDefinitionNumber,
      );
    } else {
      if (context.usedDefinitionIds.has(definitionId) && !policy.allowDefinitionId(definitionId)) {
        throw new RangeError(`actionDefinitionId 已使用: ${definitionId}`);
      }
      context.usedDefinitionIds.add(definitionId);
      observeGeneratedId(definitionId, "action-definition", context.nextDefinitionNumber);
    }

    const incomingMotionIds = new Set();
    const motions = validated.motions.map((motion) => {
      let motionId = motion.motionId;
      if (motionId === undefined) {
        motionId = nextGeneratedId("motion", context.usedMotionIds, context.nextMotionNumber);
      } else {
        if (incomingMotionIds.has(motionId)) {
          throw new RangeError(`motionId 重复: ${motionId}`);
        }
        if (context.usedMotionIds.has(motionId) && !policy.allowMotionId(motionId, definitionId)) {
          throw new RangeError(`motionId 已使用: ${motionId}`);
        }
        context.usedMotionIds.add(motionId);
        observeGeneratedId(motionId, "motion", context.nextMotionNumber);
      }
      incomingMotionIds.add(motionId);
      return Object.freeze({ ...motion, motionId });
    });

    return Object.freeze({
      actionDefinitionId: definitionId,
      name: validated.name,
      motions: freezeArray(motions),
    });
  }

  class ActionLibrary {
    constructor(definitions = []) {
      this._definitions = [];
      this._definitionIds = new Set();
      this._usedDefinitionIds = new Set();
      this._usedMotionIds = new Set();
      this._nextDefinitionNumber = 1;
      this._nextMotionNumber = 1;
      this._revision = 0;
      this.import(definitions);
    }

    get size() {
      return this._definitions.length;
    }

    get revision() {
      return this._revision;
    }

    _context() {
      return {
        usedDefinitionIds: new Set(this._usedDefinitionIds),
        usedMotionIds: new Set(this._usedMotionIds),
        nextDefinitionNumber: { value: this._nextDefinitionNumber },
        nextMotionNumber: { value: this._nextMotionNumber },
      };
    }

    _commitContext(context) {
      this._usedDefinitionIds = context.usedDefinitionIds;
      this._usedMotionIds = context.usedMotionIds;
      this._nextDefinitionNumber = context.nextDefinitionNumber.value;
      this._nextMotionNumber = context.nextMotionNumber.value;
    }

    add(input) {
      if (this.size >= MAX_ACTION_DEFINITIONS) {
        throw new RangeError(`最多可以保存 ${MAX_ACTION_DEFINITIONS} 个命名动作`);
      }
      const validated = validateActionDefinition(input);
      if (this._definitions.some(({ name }) => name === validated.name)) {
        throw new RangeError(`动作名称已存在: ${validated.name}`);
      }
      const context = this._context();
      const definition = canonicalDefinition(validated, context, {
        allowDefinitionId: () => false,
        allowMotionId: () => false,
      });
      this._definitions.push(definition);
      this._definitionIds.add(definition.actionDefinitionId);
      this._commitContext(context);
      this._revision += 1;
      return definition;
    }

    get(actionDefinitionId) {
      const id = stableId(actionDefinitionId, "actionDefinitionId");
      return this._definitions.find((definition) => definition.actionDefinitionId === id) || null;
    }

    update(actionDefinitionId, patch) {
      const id = stableId(actionDefinitionId, "actionDefinitionId");
      const index = this._definitions.findIndex((definition) => definition.actionDefinitionId === id);
      if (index < 0) throw new RangeError(`没有这个命名动作: ${id}`);
      const changes = plainRecord(patch, "命名动作更新");
      if (
        changes.actionDefinitionId !== undefined
        && stableId(changes.actionDefinitionId, "actionDefinitionId") !== id
      ) {
        throw new RangeError("不能修改 actionDefinitionId");
      }
      const validated = validateActionDefinition({
        ...this._definitions[index],
        ...changes,
        actionDefinitionId: id,
      });
      if (this._definitions.some((definition, candidateIndex) => (
        candidateIndex !== index && definition.name === validated.name
      ))) {
        throw new RangeError(`动作名称已存在: ${validated.name}`);
      }
      const currentMotionIds = new Set(
        this._definitions[index].motions.map(({ motionId }) => motionId),
      );
      const context = this._context();
      const definition = canonicalDefinition(validated, context, {
        allowDefinitionId: (candidate) => candidate === id,
        allowMotionId: (candidate, ownerId) => ownerId === id && currentMotionIds.has(candidate),
      });
      this._definitions[index] = definition;
      this._commitContext(context);
      this._revision += 1;
      return definition;
    }

    remove(actionDefinitionId) {
      const id = stableId(actionDefinitionId, "actionDefinitionId");
      const index = this._definitions.findIndex((definition) => definition.actionDefinitionId === id);
      if (index < 0) return null;
      const [removed] = this._definitions.splice(index, 1);
      this._definitionIds.delete(id);
      this._revision += 1;
      return removed;
    }

    clear() {
      const removed = this.size;
      if (removed) {
        this._definitions.length = 0;
        this._definitionIds.clear();
        this._revision += 1;
      }
      return removed;
    }

    snapshot() {
      return freezeArray(this._definitions);
    }

    import(definitions) {
      if (!Array.isArray(definitions)) throw new TypeError("命名动作必须是数组");
      if (definitions.length > MAX_ACTION_DEFINITIONS) {
        throw new RangeError(`最多可以保存 ${MAX_ACTION_DEFINITIONS} 个命名动作`);
      }
      const validated = definitions.map(validateActionDefinition);
      const currentDefinitionIds = new Set(this._definitionIds);
      const currentMotionOwners = activeMotionOwners(this._definitions);
      const context = this._context();
      const incomingIds = new Set();
      const incomingNames = new Set();
      const imported = validated.map((entry) => {
        if (incomingNames.has(entry.name)) throw new RangeError(`动作名称已存在: ${entry.name}`);
        incomingNames.add(entry.name);
        if (entry.actionDefinitionId !== undefined && incomingIds.has(entry.actionDefinitionId)) {
          throw new RangeError(`actionDefinitionId 重复: ${entry.actionDefinitionId}`);
        }
        const definition = canonicalDefinition(entry, context, {
          allowDefinitionId: (candidate) => currentDefinitionIds.has(candidate),
          allowMotionId: (candidate, ownerId) => currentMotionOwners.get(candidate) === ownerId,
        });
        if (incomingIds.has(definition.actionDefinitionId)) {
          throw new RangeError(`actionDefinitionId 重复: ${definition.actionDefinitionId}`);
        }
        incomingIds.add(definition.actionDefinitionId);
        return definition;
      });

      this._definitions = imported;
      this._definitionIds = incomingIds;
      this._commitContext(context);
      this._revision += 1;
      return this.snapshot();
    }
  }

  class NamedActionTimeline {
    constructor(placements = []) {
      this._placements = [];
      this._placementIds = new Set();
      this._usedPlacementIds = new Set();
      this._nextPlacementNumber = 1;
      this._revision = 0;
      this.import(placements);
    }

    get size() {
      return this._placements.length;
    }

    get revision() {
      return this._revision;
    }

    _nextId(usedIds, nextNumber) {
      return nextGeneratedId("placement", usedIds, nextNumber);
    }

    add(input) {
      if (this.size >= MAX_PLACEMENTS) {
        throw new RangeError(`动作时间轴最多可以放置 ${MAX_PLACEMENTS} 个动作`);
      }
      const validated = validatePlacement(input);
      const usedIds = new Set(this._usedPlacementIds);
      const nextNumber = { value: this._nextPlacementNumber };
      let placementId = validated.placementId;
      if (placementId === undefined) {
        placementId = this._nextId(usedIds, nextNumber);
      } else {
        if (usedIds.has(placementId)) throw new RangeError(`placementId 已使用: ${placementId}`);
        usedIds.add(placementId);
        observeGeneratedId(placementId, "placement", nextNumber);
      }
      const placement = Object.freeze({ ...validated, placementId });
      this._placements.push(placement);
      this._placementIds.add(placementId);
      this._usedPlacementIds = usedIds;
      this._nextPlacementNumber = nextNumber.value;
      this._revision += 1;
      return placement;
    }

    get(placementId) {
      const id = stableId(placementId, "placementId");
      return this._placements.find((placement) => placement.placementId === id) || null;
    }

    update(placementId, patch) {
      const id = stableId(placementId, "placementId");
      const index = this._placements.findIndex((placement) => placement.placementId === id);
      if (index < 0) throw new RangeError(`没有这个动作时间轴放置项: ${id}`);
      const changes = plainRecord(patch, "动作时间轴放置项更新");
      if (changes.placementId !== undefined && stableId(changes.placementId, "placementId") !== id) {
        throw new RangeError("不能修改 placementId");
      }
      const placement = Object.freeze(validatePlacement({
        ...this._placements[index],
        ...changes,
        placementId: id,
      }));
      this._placements[index] = placement;
      this._revision += 1;
      return placement;
    }

    remove(placementId) {
      const id = stableId(placementId, "placementId");
      const index = this._placements.findIndex((placement) => placement.placementId === id);
      if (index < 0) return null;
      const [removed] = this._placements.splice(index, 1);
      this._placementIds.delete(id);
      this._revision += 1;
      return removed;
    }

    clear() {
      const removed = this.size;
      if (removed) {
        this._placements.length = 0;
        this._placementIds.clear();
        this._revision += 1;
      }
      return removed;
    }

    snapshot() {
      return freezeArray(this._placements);
    }

    import(placements) {
      if (!Array.isArray(placements)) throw new TypeError("动作时间轴放置项必须是数组");
      if (placements.length > MAX_PLACEMENTS) {
        throw new RangeError(`动作时间轴最多可以放置 ${MAX_PLACEMENTS} 个动作`);
      }
      const validated = placements.map(validatePlacement);
      const currentIds = new Set(this._placementIds);
      const usedIds = new Set(this._usedPlacementIds);
      const nextNumber = { value: this._nextPlacementNumber };
      const incomingIds = new Set();
      const imported = validated.map((entry) => {
        let placementId = entry.placementId;
        if (placementId === undefined) {
          placementId = this._nextId(usedIds, nextNumber);
        } else {
          if (incomingIds.has(placementId)) throw new RangeError(`placementId 重复: ${placementId}`);
          if (usedIds.has(placementId) && !currentIds.has(placementId)) {
            throw new RangeError(`placementId 已使用: ${placementId}`);
          }
          usedIds.add(placementId);
          observeGeneratedId(placementId, "placement", nextNumber);
        }
        if (incomingIds.has(placementId)) throw new RangeError(`placementId 重复: ${placementId}`);
        incomingIds.add(placementId);
        return Object.freeze({ ...entry, placementId });
      });

      this._placements = imported;
      this._placementIds = incomingIds;
      this._usedPlacementIds = usedIds;
      this._nextPlacementNumber = nextNumber.value;
      this._revision += 1;
      return this.snapshot();
    }
  }

  class ActionTrackCatalog {
    constructor(tracks = []) {
      this._tracks = [];
      this._trackIds = new Set();
      this._usedTrackIds = new Set();
      this._nextTrackNumber = 1;
      this._revision = 0;
      this.import(tracks);
    }

    get size() {
      return this._tracks.length;
    }

    get revision() {
      return this._revision;
    }

    get(trackId) {
      const id = stableId(trackId, "trackId");
      return this._tracks.find((track) => track.trackId === id) || null;
    }

    add(input) {
      if (this.size >= MAX_ACTION_TRACKS) {
        throw new RangeError(`动作时间轴最多可以创建 ${MAX_ACTION_TRACKS} 条轨道`);
      }
      const validated = validateActionTrack(input);
      if (this._tracks.some(({ name }) => name === validated.name)) {
        throw new RangeError(`轨道名称已存在: ${validated.name}`);
      }
      const usedIds = new Set(this._usedTrackIds);
      const nextNumber = { value: this._nextTrackNumber };
      let trackId = validated.trackId;
      if (trackId === undefined) {
        trackId = nextGeneratedId("action-track", usedIds, nextNumber);
      } else {
        if (usedIds.has(trackId)) throw new RangeError(`trackId 已使用: ${trackId}`);
        usedIds.add(trackId);
        observeGeneratedId(trackId, "action-track", nextNumber);
      }
      const track = Object.freeze({ ...validated, trackId });
      this._tracks.push(track);
      this._trackIds.add(trackId);
      this._usedTrackIds = usedIds;
      this._nextTrackNumber = nextNumber.value;
      this._revision += 1;
      return track;
    }

    update(trackId, patch) {
      const id = stableId(trackId, "trackId");
      const index = this._tracks.findIndex((track) => track.trackId === id);
      if (index < 0) throw new RangeError(`没有这个动作时间轴轨道: ${id}`);
      const changes = plainRecord(patch, "动作时间轴轨道更新");
      if (changes.trackId !== undefined && stableId(changes.trackId, "trackId") !== id) {
        throw new RangeError("不能修改 trackId");
      }
      const track = validateActionTrack({ ...this._tracks[index], ...changes, trackId: id });
      if (this._tracks.some((candidate, candidateIndex) => (
        candidateIndex !== index && candidate.name === track.name
      ))) {
        throw new RangeError(`轨道名称已存在: ${track.name}`);
      }
      this._tracks[index] = track;
      this._revision += 1;
      return track;
    }

    remove(trackId) {
      const id = stableId(trackId, "trackId");
      const index = this._tracks.findIndex((track) => track.trackId === id);
      if (index < 0) return null;
      const [removed] = this._tracks.splice(index, 1);
      this._trackIds.delete(id);
      this._revision += 1;
      return removed;
    }

    snapshot() {
      return freezeArray(this._tracks);
    }

    import(tracks) {
      if (!Array.isArray(tracks)) throw new TypeError("动作时间轴轨道必须是数组");
      if (tracks.length > MAX_ACTION_TRACKS) {
        throw new RangeError(`动作时间轴最多可以创建 ${MAX_ACTION_TRACKS} 条轨道`);
      }
      const validated = tracks.map(validateActionTrack);
      const currentIds = new Set(this._trackIds);
      const usedIds = new Set(this._usedTrackIds);
      const nextNumber = { value: this._nextTrackNumber };
      const incomingIds = new Set();
      const incomingNames = new Set();
      const imported = validated.map((entry) => {
        if (incomingNames.has(entry.name)) throw new RangeError(`轨道名称已存在: ${entry.name}`);
        incomingNames.add(entry.name);
        let trackId = entry.trackId;
        if (trackId === undefined) {
          trackId = nextGeneratedId("action-track", usedIds, nextNumber);
        } else {
          if (incomingIds.has(trackId)) throw new RangeError(`trackId 重复: ${trackId}`);
          if (usedIds.has(trackId) && !currentIds.has(trackId)) {
            throw new RangeError(`trackId 已使用: ${trackId}`);
          }
          usedIds.add(trackId);
          observeGeneratedId(trackId, "action-track", nextNumber);
        }
        incomingIds.add(trackId);
        return Object.freeze({ ...entry, trackId });
      });
      this._tracks = imported;
      this._trackIds = incomingIds;
      this._usedTrackIds = usedIds;
      this._nextTrackNumber = nextNumber.value;
      this._revision += 1;
      return this.snapshot();
    }
  }

  return Object.freeze({
    MAX_ACTION_NAME_LENGTH,
    MAX_ACTION_DEFINITIONS,
    MAX_MOTIONS_PER_DEFINITION,
    MAX_PLACEMENTS,
    MAX_ACTION_TRACKS,
    MAX_ACTION_TRACK_NAME_LENGTH,
    MAX_START_MS,
    MAX_STEP_COUNT,
    validateMotion,
    validateActionDefinition,
    deriveMotionLanes,
    validatePlacement,
    validateActionTrack,
    ActionLibrary,
    NamedActionTimeline,
    ActionTrackCatalog,
  });
}));
