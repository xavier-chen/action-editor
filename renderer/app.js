"use strict";

const api = window.motorTerminal;
const registry = window.FaceMotorRegistry;
const commandModel = window.FaceCommandLedger;
const timelineModel = window.FaceTimelineModel;
const $ = (id) => document.getElementById(id);

const STORAGE_KEY = "lumface-can-terminal-v1";
const RECOVERY_STORAGE_KEY = `${STORAGE_KEY}-recovery`;
const CONFIG_FORMAT = "face-robot-can-motor-config";
const CONFIG_SCHEMA_VERSION = 5;
const GROUP_CONFIG_SCHEMA_VERSION = 4;
const DYNAMIC_CONFIG_SCHEMA_VERSION = 3;
const LEGACY_CONFIG_SCHEMA_VERSION = 2;
const OLDEST_CONFIG_SCHEMA_VERSION = 1;
const TIMELINE_FILE_FORMAT = "face-robot-timeline-animation";
const TIMELINE_FILE_SCHEMA_VERSION = 4;
const DYNAMIC_TIMELINE_FILE_SCHEMA_VERSION = 3;
const LEGACY_TIMELINE_FILE_SCHEMA_VERSION = 2;
const OLDEST_TIMELINE_FILE_SCHEMA_VERSION = 1;
const ADDED_MOTOR_IDS_V2 = Object.freeze(["head_yaw_2"]);
const LEGACY_MOTOR_IDS_V1 = Object.freeze(
  registry.MOTOR_IDS.filter((motorId) => !ADDED_MOTOR_IDS_V2.includes(motorId)),
);
const CAN_INTERFACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/;
const LOG_LIMIT = 240;
const STATUS_FRESH_MS = 4_000;
const DEFAULT_DRAFT = Object.freeze({
  steps: "1000",
  speed: "20",
  acceleration: "20",
  closed: false,
});
const DEFAULT_TIMELINE_DURATION_MS = 10_000;
const DEFAULT_TIMELINE_SNAP_MS = 100;
const DEFAULT_TIMELINE_PIXELS_PER_SECOND = 120;
const DEFAULT_NODE_QUEUE_CAPACITY = 64;
const TIMELINE_MAX_LATE_MS = 250;
const MOTION_ACK_TIMEOUT_MS = 1_000;
const TIMELINE_SNAP_OPTIONS = new Set([0, 50, 100, 250, 500, 1_000]);
const PAGE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "motor", tabId: "motorControlTab", panelId: "motorControlPage" }),
  Object.freeze({ id: "timeline", tabId: "timelineEditorTab", panelId: "timelineEditorPage" }),
  Object.freeze({ id: "namedAction", tabId: "namedActionEditorTab", panelId: "namedActionEditorPage" }),
  Object.freeze({ id: "actionTimeline", tabId: "actionTimelineTab", panelId: "actionTimelinePage" }),
]);

function defaultDrafts(catalog = registry.MOTORS) {
  return Object.fromEntries(catalog.map(({ id }) => [id, { ...DEFAULT_DRAFT }]));
}

function defaultTimelineTrackEnabled(catalog = registry.MOTORS) {
  return Object.fromEntries(catalog.map(({ id }) => [id, false]));
}

const state = {
  connected: false,
  connecting: false,
  disconnecting: false,
  configIoBusy: false,
  busy: false,
  activeOperation: "",
  operationEpoch: 0,
  connectionEpoch: 0,
  statusPolling: false,
  originReliable: false,
  pendingOriginNodes: new Set(),
  originCompletionMessage: "",
  interfaceName: "can0",
  simulate: false,
  groups: [...registry.DEFAULT_GROUPS],
  nextCustomGroupNumber: 1,
  motors: [...registry.MOTORS],
  nextCustomMotorNumber: 1,
  localRecoveryCreated: false,
  bindings: registry.defaultBindings(),
  drafts: defaultDrafts(),
  program: new commandModel.CommandProgram(),
  ledger: new commandModel.CommandLedger(),
  programStats: new Map(),
  nodeStatus: new Map(),
  motionProfiles: new Map(),
  motionProfileLoading: new Set(),
  motionProfileErrors: new Map(),
  logs: [],
  activePage: "motor",
  timeline: new timelineModel.TimelineProgram(),
  timelineTrackEnabled: defaultTimelineTrackEnabled(),
  timelineEnableRevision: 0,
  timelineDurationMs: DEFAULT_TIMELINE_DURATION_MS,
  timelineSnapMs: DEFAULT_TIMELINE_SNAP_MS,
  timelinePixelsPerSecond: DEFAULT_TIMELINE_PIXELS_PER_SECOND,
  timelineCursorMs: 0,
  timelineDirection: 1,
  selectedTimelineMotorId: null,
  selectedTimelineActionId: null,
  timelineCursorDrag: null,
  timelineDrag: null,
  timelineRun: null,
  timelineTest: null,
  motionAckWaiters: new Map(),
  motionAckCache: new Map(),
};

const motorRows = new Map();
let motorStatusRenderHandle = null;
let motorStatusUiDirty = false;

function motorById(motorId) {
  return state.motors.find(({ id }) => id === motorId);
}

function motorIds() {
  return state.motors.map(({ id }) => id);
}

function hasMotor(motorId) {
  return typeof motorId === "string" && state.motors.some(({ id }) => id === motorId);
}

function nextCustomMotorNumberFor(catalog = state.motors) {
  let highest = 0;
  for (const { id } of catalog) {
    const match = /^custom_motor_(\d+)$/.exec(id);
    const sequence = match ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(sequence) && sequence >= 1) highest = Math.max(highest, sequence);
  }
  return highest < Number.MAX_SAFE_INTEGER ? highest + 1 : 1;
}

function nextCustomGroupNumberFor(catalog = state.groups) {
  let highest = 0;
  for (const { id } of catalog) {
    const match = /^custom_group_(\d+)$/.exec(id);
    const sequence = match ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(sequence) && sequence >= 1) highest = Math.max(highest, sequence);
  }
  return highest < Number.MAX_SAFE_INTEGER ? highest + 1 : 1;
}

function groupById(groupId) {
  return state.groups.find(({ id }) => id === groupId);
}

function bindingNodeId(motorId) {
  const value = Number(state.bindings[motorId]?.nodeId);
  return Number.isInteger(value) && value >= 1 && value <= 127 ? value : null;
}

function timelineTrackIsEnabled(motorId) {
  return hasMotor(motorId) && state.timelineTrackEnabled[motorId] === true;
}

function configuredNodeIds() {
  return [...new Set(motorIds().map(bindingNodeId).filter(Number.isInteger))];
}

function nodePositionSummary() {
  const summary = state.ledger.nodePositionSummary();
  if (summary instanceof Map) return Object.fromEntries(summary);
  return summary && typeof summary === "object" ? summary : {};
}

function commandCount() {
  return state.program.size;
}

function storedInteger(value, minimum, maximum, fallback, allowZero = true) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) return fallback;
  if (!allowZero && number === 0) return fallback;
  return String(number);
}

function preserveLocalRecoveryCopy(rawStoredState) {
  if (typeof rawStoredState !== "string" || rawStoredState === "" || rawStoredState === "null") return;
  try {
    localStorage.setItem(RECOVERY_STORAGE_KEY, rawStoredState);
    state.localRecoveryCreated = true;
  } catch (_) {
    // Startup still falls back safely if the browser profile is read-only.
  }
}

function recoverValidGroupCatalog(rawCatalog) {
  let recovered = [];
  for (const rawGroup of rawCatalog.slice(0, registry.MAX_GROUPS)) {
    try {
      recovered = [...registry.normalizeGroupCatalog([...recovered, rawGroup])];
    } catch (_) {
      // Keep every independently valid, non-conflicting group. The original
      // document remains available under RECOVERY_STORAGE_KEY.
    }
  }
  return recovered.length ? recovered : registry.DEFAULT_GROUPS;
}

function recoverValidMotorCatalog(rawCatalog, groups = state.groups) {
  let recovered = [];
  for (const rawMotor of rawCatalog.slice(0, registry.MAX_MOTORS)) {
    try {
      recovered = [...registry.normalizeMotorCatalog([...recovered, rawMotor], groups)];
    } catch (_) {
      // Keep every independently valid, non-conflicting motor; the exact
      // original document remains available under RECOVERY_STORAGE_KEY.
    }
  }
  if (recovered.length) return recovered;
  try {
    return registry.normalizeMotorCatalog(registry.MOTORS, groups);
  } catch (_) {
    return [];
  }
}

function loadStoredState() {
  let rawStoredState = "null";
  try {
    rawStoredState = localStorage.getItem(STORAGE_KEY) || "null";
  } catch (_) {
    // Continue with defaults when the Chromium profile is temporarily unreadable.
  }
  let stored = null;
  try {
    stored = JSON.parse(rawStoredState);
  } catch (_) {
    preserveLocalRecoveryCopy(rawStoredState);
    stored = null;
  }
  if (!stored || typeof stored !== "object") stored = {};

  if (typeof stored.interfaceName === "string" && CAN_INTERFACE_PATTERN.test(stored.interfaceName)) {
    state.interfaceName = stored.interfaceName;
  }
  state.simulate = stored.simulate === true;

  let groups = registry.DEFAULT_GROUPS;
  if (Array.isArray(stored.groups)) {
    try {
      groups = registry.normalizeGroupCatalog(stored.groups);
    } catch (_) {
      preserveLocalRecoveryCopy(rawStoredState);
      groups = recoverValidGroupCatalog(stored.groups);
    }
  }
  state.groups = [...groups];
  const savedNextCustomGroupNumber = Number(stored.nextCustomGroupNumber);
  state.nextCustomGroupNumber = Math.max(
    nextCustomGroupNumberFor(state.groups),
    Number.isSafeInteger(savedNextCustomGroupNumber) && savedNextCustomGroupNumber >= 1
      ? savedNextCustomGroupNumber
      : 1,
  );

  let catalog;
  try {
    catalog = registry.normalizeMotorCatalog(registry.MOTORS, state.groups);
  } catch (_) {
    catalog = [];
  }
  if (Array.isArray(stored.motors)) {
    try {
      catalog = registry.normalizeMotorCatalog(stored.motors, state.groups);
    } catch (_) {
      preserveLocalRecoveryCopy(rawStoredState);
      catalog = recoverValidMotorCatalog(stored.motors, state.groups);
    }
  }
  state.motors = [...catalog];
  const savedNextCustomMotorNumber = Number(stored.nextCustomMotorNumber);
  state.nextCustomMotorNumber = Math.max(
    nextCustomMotorNumberFor(state.motors),
    Number.isSafeInteger(savedNextCustomMotorNumber) && savedNextCustomMotorNumber >= 1
      ? savedNextCustomMotorNumber
      : 1,
  );
  state.bindings = registry.defaultBindings(state.motors);
  state.drafts = defaultDrafts(state.motors);
  state.timelineTrackEnabled = defaultTimelineTrackEnabled(state.motors);
  state.program = new commandModel.CommandProgram();
  state.timeline = new timelineModel.TimelineProgram();

  for (const motorId of motorIds()) {
    const nodeId = Number(stored.bindings?.[motorId]?.nodeId);
    const validNodeId = Number.isInteger(nodeId) && nodeId >= 1 && nodeId <= 127
      ? nodeId
      : null;
    state.bindings[motorId] = { ...registry.defaultBinding(motorId), nodeId: validNodeId };
    const savedDraft = stored.drafts?.[motorId] || {};
    const savedSteps = savedDraft.steps ?? Math.abs(Number(savedDraft.signedSteps));
    state.drafts[motorId] = {
      steps: storedInteger(savedSteps, 1, commandModel.MAX_STEP_COUNT, "1000"),
      speed: storedInteger(savedDraft.speed ?? stored.speed, 1, 100, "20"),
      acceleration: storedInteger(savedDraft.acceleration ?? stored.acceleration, 1, 100, "20"),
      closed: savedDraft.closed === true,
    };
  }
  if (Array.isArray(stored.program)) {
    for (const item of stored.program.slice(0, commandModel.MAX_PROGRAM_COMMANDS)) {
      if (!hasMotor(item?.motorId)) continue;
      try {
        state.program.add(item);
      } catch (_) {
        // Invalid or obsolete saved commands are ignored instead of blocking startup.
      }
    }
  }

  const storedTimeline = stored.timeline;
  for (const motorId of motorIds()) {
    state.timelineTrackEnabled[motorId] = storedTimeline?.trackEnabled?.[motorId] === true;
  }
  const durationMs = Number(storedTimeline?.durationMs);
  if (Number.isSafeInteger(durationMs) && durationMs >= 1_000 && durationMs <= timelineModel.MAX_START_MS) {
    state.timelineDurationMs = durationMs;
  }
  const snapMs = Number(storedTimeline?.snapMs);
  if (TIMELINE_SNAP_OPTIONS.has(snapMs)) state.timelineSnapMs = snapMs;
  const pixelsPerSecond = Number(storedTimeline?.pixelsPerSecond);
  if (Number.isSafeInteger(pixelsPerSecond) && pixelsPerSecond >= 50 && pixelsPerSecond <= 240) {
    state.timelinePixelsPerSecond = pixelsPerSecond;
  }
  if (Array.isArray(storedTimeline?.actions)) {
    for (const action of storedTimeline.actions.slice(0, timelineModel.MAX_ACTIONS)) {
      if (!hasMotor(action?.motorId)) continue;
      try {
        state.timeline.add(action);
      } catch (_) {
        // Invalid or obsolete timeline actions are ignored without blocking startup.
      }
    }
  }
  const latestTimelineMs = timelineSchedule().reduce(
    (latest, entry) => Math.max(latest, entry.estimatedEndMs),
    0,
  );
  state.timelineDurationMs = Math.min(
    timelineModel.MAX_START_MS,
    Math.max(state.timelineDurationMs, Math.ceil(latestTimelineMs / 1_000) * 1_000),
  );
  window.LumNamedActions.loadStoredState(stored, rawStoredState);
}

let saveTimer = null;
function persistedStateDocument() {
  const ids = motorIds();
  return {
    schemaVersion: 12,
    interfaceName: state.interfaceName,
    simulate: state.simulate,
    nextCustomGroupNumber: state.nextCustomGroupNumber,
    groups: state.groups.map(({ id, label }) => ({ id, label })),
    nextCustomMotorNumber: state.nextCustomMotorNumber,
    motors: state.motors.map(({ id, label, shortLabel, group }) => ({
      id,
      label,
      shortLabel,
      group,
    })),
    bindings: Object.fromEntries(ids.map((motorId) => [motorId, state.bindings[motorId]])),
    drafts: Object.fromEntries(ids.map((motorId) => [motorId, state.drafts[motorId]])),
    program: state.program.snapshot().map(({ commandId: _commandId, ...command }) => command),
    timeline: {
      durationMs: state.timelineDurationMs,
      snapMs: state.timelineSnapMs,
      pixelsPerSecond: state.timelinePixelsPerSecond,
      trackEnabled: Object.fromEntries(ids.map((motorId) => [
        motorId,
        state.timelineTrackEnabled[motorId] === true,
      ])),
      actions: state.timeline.snapshot(),
    },
    ...window.LumNamedActions.persistedStateFields(),
  };
}

function setSaveStatus(mode, message) {
  const root = $("saveStatus");
  if (!root) return;
  root.className = `save-status ${mode}`;
  root.querySelector("span").textContent = message;
}

function writePersistedState() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedStateDocument()));
    setSaveStatus("saved", "配置与动作已保存");
    return true;
  } catch (_) {
    setSaveStatus("error", "本机保存失败");
    return false;
  }
}

function persistState(immediate = false) {
  clearTimeout(saveTimer);
  if (immediate) return writePersistedState();
  setSaveStatus("saving", "正在保存…");
  saveTimer = setTimeout(writePersistedState, 100);
  return true;
}

function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = String(message);
  $("toastRegion").append(item);
  setTimeout(() => item.remove(), 4_200);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

function configurationRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  return value;
}

function configurationOnlyKeys(record, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`${label}包含未知字段: ${key}`);
  }
}

function configurationInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label}必须是 ${minimum}–${maximum} 的整数`);
  }
  return value;
}

function configurationBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

function configurationInterfaceName(value) {
  if (typeof value !== "string" || !CAN_INTERFACE_PATTERN.test(value)) {
    throw new TypeError("配置中的 CAN 接口名不合法");
  }
  return value;
}

function importedMotorIdsForSchema(
  schemaVersion,
  currentVersion,
  legacyVersion,
  oldestVersion,
  label,
  dynamicVersions = [],
) {
  if (schemaVersion === legacyVersion) return registry.MOTOR_IDS;
  if (schemaVersion === oldestVersion) return LEGACY_MOTOR_IDS_V1;
  const compatibleDynamicVersions = Array.isArray(dynamicVersions)
    ? dynamicVersions
    : [dynamicVersions];
  if (schemaVersion === currentVersion || compatibleDynamicVersions.includes(schemaVersion)) return null;
  throw new RangeError(`不支持的${label}版本: ${schemaVersion}`);
}

function configurationExportedAt(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label}导出时间不合法`);
  }
  return value;
}

function exportConfigurationDocument() {
  const interfaceName = configurationInterfaceName($("interfaceInput").value.trim());
  const groups = state.groups.map(({ id, label }) => ({ groupId: id, label }));
  const motors = state.motors.map((motor) => {
    const motorId = motor.id;
    const draft = state.drafts[motorId];
    return {
      motorId,
      label: motor.label,
      group: motor.group,
      nodeId: bindingNodeId(motorId),
      steps: positiveStepMagnitude(draft.steps),
      speed: configurationInteger(Number(draft.speed), `${motor.label} 速度`, 1, 100),
      acceleration: configurationInteger(Number(draft.acceleration), `${motor.label} 加速度`, 1, 100),
      closed: draft.closed === true,
    };
  });
  return {
    format: CONFIG_FORMAT,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    interfaceName,
    simulate: $("simulateInput").checked,
    groupCount: groups.length,
    groups,
    motorCount: motors.length,
    motors,
  };
}

function normalizeImportedConfiguration(content) {
  if (typeof content !== "string") throw new TypeError("配置文件内容不合法");
  let documentValue;
  try {
    documentValue = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch (_) {
    throw new TypeError("配置文件不是有效 JSON");
  }
  const documentRecord = configurationRecord(documentValue, "配置文件");
  const schemaVersion = documentRecord.schemaVersion;
  const hasGroupCatalog = schemaVersion === CONFIG_SCHEMA_VERSION
    || schemaVersion === GROUP_CONFIG_SCHEMA_VERSION;
  const hasDynamicMotorCatalog = hasGroupCatalog
    || schemaVersion === DYNAMIC_CONFIG_SCHEMA_VERSION;
  configurationOnlyKeys(
    documentRecord,
    hasGroupCatalog
      ? [
        "format",
        "schemaVersion",
        "exportedAt",
        "interfaceName",
        "simulate",
        "groupCount",
        "groups",
        "motorCount",
        "motors",
      ]
      : ["format", "schemaVersion", "exportedAt", "interfaceName", "simulate", "motorCount", "motors"],
    "配置文件",
  );
  if (documentRecord.format !== CONFIG_FORMAT) throw new TypeError("不是本软件导出的电机配置");
  const legacyMotorIds = importedMotorIdsForSchema(
    schemaVersion,
    CONFIG_SCHEMA_VERSION,
    LEGACY_CONFIG_SCHEMA_VERSION,
    OLDEST_CONFIG_SCHEMA_VERSION,
    "配置",
    [GROUP_CONFIG_SCHEMA_VERSION, DYNAMIC_CONFIG_SCHEMA_VERSION],
  );
  const interfaceName = configurationInterfaceName(documentRecord.interfaceName);
  if (typeof documentRecord.simulate !== "boolean") throw new TypeError("仿真模式必须是布尔值");
  configurationExportedAt(documentRecord.exportedAt, "配置文件");
  if (!Array.isArray(documentRecord.motors)) throw new TypeError("配置中的电机目录必须是数组");

  let groups = registry.DEFAULT_GROUPS;
  if (hasGroupCatalog) {
    configurationInteger(documentRecord.groupCount, "配置中的分组数量", 0, registry.MAX_GROUPS);
    if (!Array.isArray(documentRecord.groups)) throw new TypeError("配置中的分组目录必须是数组");
    if (documentRecord.groupCount !== documentRecord.groups.length) {
      throw new RangeError("配置中的分组数量不匹配");
    }
    groups = registry.normalizeGroupCatalog(documentRecord.groups.map((rawGroup, index) => {
      const entry = configurationRecord(rawGroup, `第 ${index + 1} 个分组配置`);
      configurationOnlyKeys(entry, ["groupId", "label"], `第 ${index + 1} 个分组配置`);
      return {
        id: registry.normalizeGroupId(entry.groupId),
        label: registry.normalizeGroupLabel(entry.label),
      };
    }));
  }

  let motors;
  let importedMotorIds;
  if (hasDynamicMotorCatalog) {
    configurationInteger(documentRecord.motorCount, "配置中的电机数量", 0, registry.MAX_MOTORS);
    if (documentRecord.motorCount !== documentRecord.motors.length) {
      throw new RangeError("配置中的电机数量不匹配");
    }
    const catalogInput = documentRecord.motors.map((rawMotor, index) => {
      const entry = configurationRecord(rawMotor, `第 ${index + 1} 个电机配置`);
      configurationOnlyKeys(
        entry,
        schemaVersion === CONFIG_SCHEMA_VERSION
          ? ["motorId", "label", "group", "nodeId", "enabled", "steps", "speed", "acceleration", "closed"]
          : ["motorId", "label", "group", "nodeId", "enabled", "steps", "speed", "acceleration"],
        `第 ${index + 1} 个电机配置`,
      );
      return {
        id: registry.normalizeMotorId(entry.motorId),
        label: registry.normalizeMotorLabel(entry.label),
        shortLabel: registry.normalizeMotorLabel(entry.label),
        group: entry.group,
      };
    });
    motors = registry.normalizeMotorCatalog(catalogInput, groups);
    importedMotorIds = motors.map(({ id }) => id);
  } else {
    importedMotorIds = legacyMotorIds;
    motors = registry.MOTORS;
    groups = registry.DEFAULT_GROUPS;
    if (documentRecord.motorCount !== importedMotorIds.length) {
      throw new RangeError("配置中的电机数量不匹配");
    }
    if (documentRecord.motors.length !== importedMotorIds.length) {
      throw new RangeError(`配置必须包含该版本全部 ${importedMotorIds.length} 个电机`);
    }
  }

  const usedMotorIds = new Set();
  const bindings = registry.defaultBindings(motors);
  const drafts = defaultDrafts(motors);
  const importedMotorsById = new Map(motors.map((motor) => [motor.id, motor]));
  for (const rawMotor of documentRecord.motors) {
    const entry = configurationRecord(rawMotor, "电机配置");
    configurationOnlyKeys(
      entry,
      hasDynamicMotorCatalog
        ? (schemaVersion === CONFIG_SCHEMA_VERSION
          ? ["motorId", "label", "group", "nodeId", "enabled", "steps", "speed", "acceleration", "closed"]
          : ["motorId", "label", "group", "nodeId", "enabled", "steps", "speed", "acceleration"])
        : ["motorId", "label", "nodeId", "enabled", "steps", "speed", "acceleration"],
      "电机配置",
    );
    if (typeof entry.motorId !== "string" || !importedMotorIds.includes(entry.motorId)) {
      throw new RangeError(`未知电机位置: ${entry.motorId}`);
    }
    if (usedMotorIds.has(entry.motorId)) throw new RangeError(`电机位置重复: ${entry.motorId}`);
    usedMotorIds.add(entry.motorId);
    const motor = importedMotorsById.get(entry.motorId);
    let nodeId = null;
    if (entry.nodeId !== null) {
      nodeId = configurationInteger(entry.nodeId, `${motor.label} 节点 ID`, 1, 127);
    }
    const steps = configurationInteger(entry.steps, `${motor.label} 步数`, 1, commandModel.MAX_STEP_COUNT);
    const speed = configurationInteger(entry.speed, `${motor.label} 速度`, 1, 100);
    const acceleration = configurationInteger(entry.acceleration, `${motor.label} 加速度`, 1, 100);
    const closed = schemaVersion === CONFIG_SCHEMA_VERSION
      ? configurationBoolean(entry.closed, `${motor.label} 闭环模式`)
      : false;
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      throw new TypeError(`${motor.label} 旧版使能状态必须是布尔值`);
    }
    bindings[entry.motorId] = { ...registry.defaultBinding(entry.motorId), nodeId };
    drafts[entry.motorId] = {
      steps: String(steps),
      speed: String(speed),
      acceleration: String(acceleration),
      closed,
    };
  }
  if (usedMotorIds.size !== importedMotorIds.length) throw new RangeError("配置缺少电机位置");
  return { interfaceName, simulate: documentRecord.simulate, groups, motors, bindings, drafts };
}

function syncConfigurationInputs() {
  $("interfaceInput").value = state.interfaceName;
  $("simulateInput").checked = state.simulate;
  for (const motorId of motorIds()) {
    const row = motorRows.get(motorId);
    if (!row) continue;
    row.querySelector(".motor-id-input").value = bindingNodeId(motorId) ?? "";
    row.querySelector(".motor-steps-input").value = state.drafts[motorId].steps;
    row.querySelector(".motor-speed-input").value = state.drafts[motorId].speed;
    row.querySelector(".motor-acceleration-input").value = state.drafts[motorId].acceleration;
    row.querySelector(".motor-loop-mode-select").value = state.drafts[motorId].closed ? "closed" : "open";
  }
}

function motorCatalogRemovalImpact(motors) {
  const allowedMotorIds = new Set(motors.map(({ id }) => id));
  return {
    removedCommands: state.program.snapshot().filter(({ motorId }) => !allowedMotorIds.has(motorId)).length,
    removedActions: state.timeline.snapshot().filter(({ motorId }) => !allowedMotorIds.has(motorId)).length,
    ...window.LumNamedActions.motorCatalogRemovalImpact(allowedMotorIds),
  };
}

function installMotorCatalog({ groups = state.groups, motors, bindings, drafts }) {
  const nextGroups = registry.normalizeGroupCatalog(groups);
  const nextMotors = registry.normalizeMotorCatalog(motors, nextGroups);
  const allowedMotorIds = new Set(nextMotors.map(({ id }) => id));
  const previousCommands = state.program.snapshot();
  const previousActions = state.timeline.snapshot();
  const previousTrackEnabled = state.timelineTrackEnabled;
  const keptCommands = previousCommands.filter(({ motorId }) => allowedMotorIds.has(motorId));
  const keptActions = previousActions.filter(({ motorId }) => allowedMotorIds.has(motorId));

  state.groups = [...nextGroups];
  state.nextCustomGroupNumber = Math.max(
    state.nextCustomGroupNumber,
    nextCustomGroupNumberFor(state.groups),
  );
  state.motors = [...nextMotors];
  state.nextCustomMotorNumber = Math.max(
    state.nextCustomMotorNumber,
    nextCustomMotorNumberFor(state.motors),
  );
  state.bindings = bindings;
  state.drafts = drafts;
  state.program = new commandModel.CommandProgram(keptCommands);
  state.timeline = new timelineModel.TimelineProgram(keptActions);
  state.timelineTrackEnabled = Object.fromEntries(state.motors.map(({ id }) => [
    id,
    previousTrackEnabled[id] === true,
  ]));
  state.timelineEnableRevision += 1;
  if (!allowedMotorIds.has(state.selectedTimelineMotorId)) state.selectedTimelineMotorId = null;
  if (state.selectedTimelineActionId && !state.timeline.get(state.selectedTimelineActionId)) {
    state.selectedTimelineActionId = null;
  }
  const namedRemoval = window.LumNamedActions.reconcileMotorCatalog(allowedMotorIds);
  return {
    removedCommands: previousCommands.length - keptCommands.length,
    removedActions: previousActions.length - keptActions.length,
    ...namedRemoval,
  };
}

async function exportConfiguration() {
  if (state.configIoBusy || state.busy || state.connecting) return;
  state.configIoBusy = true;
  renderConnection();
  try {
    const content = `${JSON.stringify(exportConfigurationDocument(), null, 2)}\n`;
    const result = await api.exportConfigFile(content);
    if (!result?.canceled) toast(`配置已导出：${result.fileName || "JSON 文件"}`);
  } catch (error) {
    toast(`导出失败：${errorMessage(error)}`, "error");
  } finally {
    state.configIoBusy = false;
    renderConnection();
  }
}

async function importConfiguration() {
  if (state.connected || state.connecting || state.busy || state.configIoBusy) {
    toast("请先断开 CAN，再导入配置", "warning");
    return;
  }
  state.configIoBusy = true;
  renderConnection();
  try {
    const result = await api.importConfigFile();
    if (result?.canceled) return;
    if (state.connected || state.connecting || state.busy) throw new Error("导入期间 CAN 状态已改变，未应用配置");
    const normalized = normalizeImportedConfiguration(result?.content);
    const impact = motorCatalogRemovalImpact(normalized.motors);
    if (impact.removedCommands || impact.removedActions || impact.removedDefinitions || impact.removedPlacements) {
      const confirmed = await confirmAction(
        "导入配置并清理失效内容",
        `新配置不包含部分现有电机，应用后会删除 ${impact.removedCommands} 条指令记录、${impact.removedActions} 个电机时间轴动作、${impact.removedDefinitions || 0} 个命名动作和 ${impact.removedPlacements || 0} 个动作时间轴实例。`,
        "应用并清理",
      );
      if (!confirmed) return;
      if (state.connected || state.connecting || state.disconnecting || state.busy) {
        throw new Error("确认期间 CAN 状态已改变，未应用配置");
      }
    }
    state.interfaceName = normalized.interfaceName;
    state.simulate = normalized.simulate;
    const removed = installMotorCatalog(normalized);
    state.nodeStatus.clear();
    state.motionProfiles.clear();
    state.motionProfileLoading.clear();
    state.motionProfileErrors.clear();
    window.LumNamedActions.motionProfilesChanged();
    state.programStats.clear();
    state.ledger.clear();
    state.pendingOriginNodes.clear();
    state.originReliable = false;
    state.originCompletionMessage = "";
    buildMotorRows();
    syncConfigurationInputs();
    resetTimelineEditor({ keepMotor: false });
    const saved = persistState(true);
    refreshMotorRows();
    renderOrigin();
    renderProgram();
    renderTimeline();
    window.LumNamedActions.renderAll();
    const removedText = removed.removedCommands || removed.removedActions || removed.removedDefinitions || removed.removedPlacements
      ? `；已清理 ${removed.removedCommands} 条失效指令、${removed.removedActions} 个电机时间轴动作、${removed.removedDefinitions || 0} 个命名动作、${removed.removedPlacements || 0} 个动作实例`
      : "";
    addLog("success", "导入", `已应用配置 ${result.fileName || "JSON 文件"}${removedText}`);
    toast(
      saved
        ? `配置已导入并保存：${result.fileName || "JSON 文件"}${removedText}`
        : "配置已导入，但本机保存失败",
      saved ? "info" : "error",
    );
  } catch (error) {
    toast(`导入失败：${errorMessage(error)}`, "error");
  } finally {
    state.configIoBusy = false;
    renderConnection();
  }
}

function exportTimelineDocument() {
  return {
    format: TIMELINE_FILE_FORMAT,
    schemaVersion: TIMELINE_FILE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    motorCount: state.motors.length,
    motors: state.motors.map(({ id, label }) => ({ motorId: id, label })),
    timeline: {
      durationMs: state.timelineDurationMs,
      snapMs: state.timelineSnapMs,
      pixelsPerSecond: state.timelinePixelsPerSecond,
      trackEnabled: state.timelineTrackEnabled,
      actions: state.timeline.snapshot(),
    },
  };
}

function normalizeTimelineTrackEnabled(value, importedMotorIds = motorIds()) {
  const trackEnabled = defaultTimelineTrackEnabled(state.motors);
  if (value === undefined) return trackEnabled;
  const record = configurationRecord(value, "时间轨控制位置使能");
  configurationOnlyKeys(record, importedMotorIds, "时间轨控制位置使能");
  for (const motorId of importedMotorIds) {
    if (!Object.hasOwn(record, motorId)) throw new RangeError(`时间轨使能缺少控制位置: ${motorId}`);
    if (typeof record[motorId] !== "boolean") {
      throw new TypeError(`${motorById(motorId)?.label || motorId} 的时间轨使能必须是布尔值`);
    }
    if (hasMotor(motorId)) trackEnabled[motorId] = record[motorId] === true;
  }
  return trackEnabled;
}

function normalizeImportedTimeline(content) {
  if (typeof content !== "string") throw new TypeError("动画时间轴文件内容不合法");
  let parsed;
  try {
    parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch (_) {
    throw new TypeError("动画时间轴文件不是有效 JSON");
  }
  const documentRecord = configurationRecord(parsed, "动画时间轴文件");
  configurationOnlyKeys(
    documentRecord,
    ["format", "schemaVersion", "exportedAt", "motorCount", "motors", "timeline"],
    "动画时间轴文件",
  );
  if (documentRecord.format !== TIMELINE_FILE_FORMAT) throw new TypeError("不是本软件导出的动画时间轴");
  const schemaVersion = documentRecord.schemaVersion;
  const legacyMotorIds = importedMotorIdsForSchema(
    schemaVersion,
    TIMELINE_FILE_SCHEMA_VERSION,
    LEGACY_TIMELINE_FILE_SCHEMA_VERSION,
    OLDEST_TIMELINE_FILE_SCHEMA_VERSION,
    "动画时间轴",
    [DYNAMIC_TIMELINE_FILE_SCHEMA_VERSION],
  );
  let importedMotorIds;
  if (
    schemaVersion === TIMELINE_FILE_SCHEMA_VERSION
    || schemaVersion === DYNAMIC_TIMELINE_FILE_SCHEMA_VERSION
  ) {
    configurationInteger(documentRecord.motorCount, "动画时间轴电机数量", 0, registry.MAX_MOTORS);
    if (!Array.isArray(documentRecord.motors)) throw new TypeError("动画时间轴缺少电机引用快照");
    if (documentRecord.motorCount !== documentRecord.motors.length) {
      throw new RangeError("动画时间轴电机数量不匹配");
    }
    const snapshotCatalog = registry.normalizeMotorCatalog(documentRecord.motors.map((rawMotor, index) => {
      const entry = configurationRecord(rawMotor, `动画时间轴第 ${index + 1} 个电机引用`);
      configurationOnlyKeys(entry, ["motorId", "label"], `动画时间轴第 ${index + 1} 个电机引用`);
      return {
        id: registry.normalizeMotorId(entry.motorId),
        label: registry.normalizeMotorLabel(entry.label),
        group: registry.CUSTOM_GROUP_ID,
      };
    }));
    importedMotorIds = snapshotCatalog.map(({ id }) => id);
  } else {
    if (documentRecord.motors !== undefined) {
      throw new TypeError("旧版动画时间轴不应包含 motors 字段");
    }
    importedMotorIds = legacyMotorIds;
    if (documentRecord.motorCount !== importedMotorIds.length) {
      throw new RangeError(`动画时间轴必须对应该版本 ${importedMotorIds.length} 个电机位置`);
    }
  }
  configurationExportedAt(documentRecord.exportedAt, "动画时间轴");
  const timeline = configurationRecord(documentRecord.timeline, "动画时间轴");
  configurationOnlyKeys(
    timeline,
    ["durationMs", "snapMs", "pixelsPerSecond", "trackEnabled", "actions"],
    "动画时间轴",
  );
  const durationMs = configurationInteger(
    timeline.durationMs,
    "动画时长",
    1_000,
    timelineModel.MAX_START_MS,
  );
  const snapMs = configurationInteger(timeline.snapMs, "吸附间隔", 0, 1_000);
  if (!TIMELINE_SNAP_OPTIONS.has(snapMs)) throw new RangeError("动画时间轴吸附间隔不受支持");
  const pixelsPerSecond = configurationInteger(timeline.pixelsPerSecond, "时间轴缩放", 50, 240);
  const trackEnabled = normalizeTimelineTrackEnabled(timeline.trackEnabled, importedMotorIds);
  if (!Array.isArray(timeline.actions)) throw new TypeError("动画时间轴动作必须是数组");
  if (timeline.actions.length > timelineModel.MAX_ACTIONS) {
    throw new RangeError(`动画时间轴最多 ${timelineModel.MAX_ACTIONS} 个动作`);
  }
  const normalizedActions = timeline.actions.map((rawAction, index) => {
    const action = configurationRecord(rawAction, `第 ${index + 1} 个时间轨动作`);
    const legacyActionKeys = [
      "actionId", "motorId", "nodeId", "startMs", "signedSteps", "speed", "acceleration",
    ];
    configurationOnlyKeys(
      action,
      schemaVersion === TIMELINE_FILE_SCHEMA_VERSION
        ? [...legacyActionKeys, "closed"]
        : legacyActionKeys,
      `第 ${index + 1} 个时间轨动作`,
    );
    const closed = schemaVersion === TIMELINE_FILE_SCHEMA_VERSION
      ? configurationBoolean(action.closed, `第 ${index + 1} 个时间轨动作的闭环模式`)
      : false;
    return { ...action, closed };
  });
  for (const action of normalizedActions) {
    if (!importedMotorIds.includes(action?.motorId)) {
      throw new RangeError(`该版本动画包含未知电机位置: ${action?.motorId}`);
    }
  }
  const actionMotorIds = new Set(normalizedActions.map(({ motorId }) => motorId));
  const missingMotorIds = importedMotorIds.filter((motorId) => (
    !hasMotor(motorId)
    && (timeline.trackEnabled?.[motorId] === true || actionMotorIds.has(motorId))
  ));
  if (missingMotorIds.length) {
    throw new RangeError(`当前电机配置缺少动画引用的位置: ${missingMotorIds.join("、")}`);
  }
  const program = new timelineModel.TimelineProgram(normalizedActions);
  const latestActionMs = program.snapshot().reduce(
    (latest, action) => Math.max(latest, action.startMs),
    0,
  );
  if (latestActionMs > durationMs) {
    throw new RangeError(`动画时长 ${durationMs} ms 小于最后动作时间 ${latestActionMs} ms`);
  }
  return { durationMs, snapMs, pixelsPerSecond, trackEnabled, program };
}

function saveTimelineProject() {
  if (state.busy || state.configIoBusy || state.connecting || state.disconnecting) return;
  const saved = persistState(true);
  toast(
    saved ? `时间轴已保存到本机 · ${state.timeline.size} 个动作` : "时间轴本机保存失败",
    saved ? "info" : "error",
  );
}

async function exportTimelineProject() {
  if (state.busy || state.configIoBusy || state.connecting || state.disconnecting) return;
  state.configIoBusy = true;
  renderConnection();
  try {
    const content = `${JSON.stringify(exportTimelineDocument(), null, 2)}\n`;
    const result = await api.exportTimelineFile(content);
    if (!result?.canceled) toast(`动画时间轴已导出：${result.fileName || "JSON 文件"}`);
  } catch (error) {
    toast(`动画时间轴导出失败：${errorMessage(error)}`, "error");
  } finally {
    state.configIoBusy = false;
    renderConnection();
  }
}

async function importTimelineProject() {
  if (state.busy || state.configIoBusy || state.connecting || state.disconnecting) return;
  state.configIoBusy = true;
  renderConnection();
  try {
    const result = await api.importTimelineFile();
    if (result?.canceled) return;
    if (state.busy || state.connecting || state.disconnecting) {
      throw new Error("导入期间运行状态已变化，未应用动画时间轴");
    }
    const imported = normalizeImportedTimeline(result?.content);
    state.timeline = imported.program;
    state.timelineDurationMs = imported.durationMs;
    state.timelineSnapMs = imported.snapMs;
    state.timelinePixelsPerSecond = imported.pixelsPerSecond;
    state.timelineTrackEnabled = imported.trackEnabled;
    state.timelineEnableRevision += 1;
    state.timelineCursorMs = 0;
    state.selectedTimelineActionId = null;
    resetTimelineEditor();
    const saved = persistState(true);
    renderTimeline();
    if (state.connected) refreshTimelineMotionProfiles();
    toast(
      saved
        ? `动画时间轴已导入并保存：${result.fileName || "JSON 文件"} · ${state.timeline.size} 个动作`
        : "动画时间轴已导入，但本机保存失败",
      saved ? "info" : "error",
    );
  } catch (error) {
    toast(`动画时间轴导入失败：${errorMessage(error)}`, "error");
  } finally {
    state.configIoBusy = false;
    renderConnection();
  }
}

function addLog(level, label, message, render = true) {
  state.logs.push({ timestamp: Date.now(), level, label, message: String(message) });
  if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
  if (render) renderLogs();
}

function confirmAction(title, message, buttonText = "确认") {
  return new Promise((resolve) => {
    const modal = $("confirmModal");
    $("confirmTitle").textContent = title;
    $("confirmMessage").textContent = message;
    $("confirmAcceptButton").textContent = buttonText;
    modal.hidden = false;
    const finish = (result) => {
      modal.hidden = true;
      $("confirmAcceptButton").removeEventListener("click", accept);
      $("confirmCancelButton").removeEventListener("click", cancel);
      resolve(result);
    };
    const accept = () => finish(true);
    const cancel = () => finish(false);
    $("confirmAcceptButton").addEventListener("click", accept);
    $("confirmCancelButton").addEventListener("click", cancel);
  });
}

function updateMotorRowLabelMetadata(row, motor) {
  if (!row || !motor) return;
  const nameLabel = row.querySelector(".motor-name-label");
  nameLabel.textContent = motor.label;
  nameLabel.title = `${motor.label}（名称创建后固定；如需更名请删除后重新添加）`;
  nameLabel.setAttribute("aria-label", `${motor.label}，名称不可修改`);
  const idInput = row.querySelector(".motor-id-input");
  idInput.title = `${motor.label} CAN 节点 ID（1–127，允许与其他位置重复）`;
  idInput.setAttribute("aria-label", `${motor.label} CAN ID`);
  const stepsInput = row.querySelector(".motor-steps-input");
  stepsInput.title = `${motor.label} 相对步数（正数）`;
  stepsInput.setAttribute("aria-label", `${motor.label} 相对步数绝对值`);
  row.querySelector(".motor-speed-input").setAttribute("aria-label", `${motor.label} 速度等级`);
  row.querySelector(".motor-acceleration-input").setAttribute("aria-label", `${motor.label} 加速度等级`);
  const loopModeSelect = row.querySelector(".motor-loop-mode-select");
  loopModeSelect.title = `${motor.label} 控制模式`;
  loopModeSelect.setAttribute("aria-label", `${motor.label} 开环或闭环控制模式`);
  row.querySelector(".motor-forward-button").setAttribute("aria-label", `${motor.label} 正向转动`);
  row.querySelector(".motor-reverse-button").setAttribute("aria-label", `${motor.label} 反向转动`);
  row.querySelector(".motor-stop-button").setAttribute("aria-label", `停止 ${motor.label}`);
  row.querySelector(".motor-disable-button").setAttribute("aria-label", `${motor.label} 失能`);
  const deleteButton = row.querySelector(".motor-delete-button");
  deleteButton.title = `删除 ${motor.label}`;
  deleteButton.setAttribute("aria-label", `删除 ${motor.label}`);
}

function createMotorControlRow(motor) {
  const row = document.createElement("div");
  row.className = "motor-control-row";
  row.dataset.motorId = motor.id;

  const name = document.createElement("span");
  name.className = "motor-name";
  const label = document.createElement("b");
  label.className = "motor-name-label";
  label.textContent = motor.label;
  label.title = `${motor.label}（名称创建后固定；如需更名请删除后重新添加）`;
  label.setAttribute("aria-label", `${motor.label}，名称不可修改`);
  const position = document.createElement("small");
  position.className = "motor-position";
  position.textContent = "位置 0";
  name.append(label, position);

  const idInput = document.createElement("input");
  idInput.className = "motor-id-input";
  idInput.type = "number";
  idInput.min = "1";
  idInput.max = "127";
  idInput.step = "1";
  idInput.placeholder = "—";
  idInput.value = bindingNodeId(motor.id) ?? "";
  idInput.title = `${motor.label} CAN 节点 ID（1–127，允许与其他位置重复）`;
  idInput.setAttribute("aria-label", `${motor.label} CAN ID`);

  const stepsInput = document.createElement("input");
  stepsInput.className = "motor-steps-input";
  stepsInput.type = "number";
  stepsInput.min = "1";
  stepsInput.max = "16777215";
  stepsInput.step = "1";
  stepsInput.value = state.drafts[motor.id].steps;
  stepsInput.title = `${motor.label} 相对步数（正数）`;
  stepsInput.setAttribute("aria-label", `${motor.label} 相对步数绝对值`);

  const speedInput = document.createElement("input");
  speedInput.className = "motor-speed-input";
  speedInput.type = "number";
  speedInput.min = "1";
  speedInput.max = "100";
  speedInput.step = "1";
  speedInput.value = state.drafts[motor.id].speed;
  speedInput.title = `${motor.label} 速度等级 1–100`;
  speedInput.setAttribute("aria-label", `${motor.label} 速度等级`);

  const accelerationInput = document.createElement("input");
  accelerationInput.className = "motor-acceleration-input";
  accelerationInput.type = "number";
  accelerationInput.min = "1";
  accelerationInput.max = "100";
  accelerationInput.step = "1";
  accelerationInput.value = state.drafts[motor.id].acceleration;
  accelerationInput.title = `${motor.label} 加速度等级 1–100`;
  accelerationInput.setAttribute("aria-label", `${motor.label} 加速度等级`);

  const loopModeSelect = document.createElement("select");
  loopModeSelect.className = "motor-loop-mode-select";
  loopModeSelect.title = `${motor.label} 控制模式`;
  loopModeSelect.setAttribute("aria-label", `${motor.label} 开环或闭环控制模式`);
  for (const [value, text] of [["open", "开"], ["closed", "闭"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    loopModeSelect.append(option);
  }
  loopModeSelect.value = state.drafts[motor.id].closed ? "closed" : "open";

  const forwardButton = document.createElement("button");
  forwardButton.className = "motor-row-button motor-forward-button";
  forwardButton.type = "button";
  forwardButton.textContent = "＋";
  forwardButton.title = "按当前步数正向转动并记录";
  forwardButton.setAttribute("aria-label", `${motor.label} 正向转动`);

  const reverseButton = document.createElement("button");
  reverseButton.className = "motor-row-button motor-reverse-button";
  reverseButton.type = "button";
  reverseButton.textContent = "−";
  reverseButton.title = "按当前步数反向转动并记录";
  reverseButton.setAttribute("aria-label", `${motor.label} 反向转动`);

  const stopButton = document.createElement("button");
  stopButton.className = "motor-row-button motor-stop-button";
  stopButton.type = "button";
  stopButton.textContent = "■";
  stopButton.title = "立即停止这个电机";
  stopButton.setAttribute("aria-label", `停止 ${motor.label}`);

  const disableButton = document.createElement("button");
  disableButton.className = "motor-row-button motor-disable-button";
  disableButton.type = "button";
  disableButton.textContent = "断";
  disableButton.title = "使这个电机失能";
  disableButton.setAttribute("aria-label", `${motor.label} 失能`);

  const deleteButton = document.createElement("button");
  deleteButton.className = "motor-row-button motor-delete-button";
  deleteButton.type = "button";
  deleteButton.textContent = "×";
  deleteButton.title = `删除 ${motor.label}`;
  deleteButton.setAttribute("aria-label", `删除 ${motor.label}`);

  row.append(
    name,
    idInput,
    stepsInput,
    speedInput,
    accelerationInput,
    loopModeSelect,
    forwardButton,
    reverseButton,
    stopButton,
    disableButton,
    deleteButton,
  );
  updateMotorRowLabelMetadata(row, motor);
  return row;
}

function createColumnHeader() {
  const header = document.createElement("div");
  header.className = "motor-columns";
  for (const text of ["电机 / 累计", "ID", "步数", "速", "加", "模式", "+", "−", "停", "断", "删"]) {
    const cell = document.createElement("span");
    cell.textContent = text;
    header.append(cell);
  }
  return header;
}

function buildMotorRows() {
  const root = $("motorRows");
  root.replaceChildren();
  motorRows.clear();

  const rowsByGroup = new Map(state.groups.map((group) => [group.id, []]));
  for (const motor of state.motors) {
    const row = createMotorControlRow(motor);
    row.dataset.motorId = motor.id;
    motorRows.set(motor.id, row);
    rowsByGroup.get(motor.group)?.push(row);
  }

  const columnCount = Math.min(2, state.groups.length);
  const splitIndex = Math.ceil(state.groups.length / Math.max(1, columnCount));
  const banks = Array.from({ length: columnCount }, () => {
    const bank = document.createElement("div");
    bank.className = "motor-bank";
    return bank;
  });

  for (const [groupIndex, group] of state.groups.entries()) {
    const groupRows = rowsByGroup.get(group.id) || [];
    const section = document.createElement("section");
    section.className = "motor-group";
    section.dataset.groupId = group.id;
    const heading = document.createElement("div");
    heading.className = "motor-group-heading";
    const nameInput = document.createElement("input");
    nameInput.className = "group-name-input";
    nameInput.type = "text";
    nameInput.maxLength = String(registry.MAX_GROUP_LABEL_LENGTH);
    nameInput.value = group.label;
    nameInput.dataset.previousLabel = group.label;
    nameInput.title = "直接修改分组名称，回车保存，Esc 取消";
    nameInput.setAttribute("aria-label", `${group.label} 分组名称`);
    nameInput.spellcheck = false;
    const actions = document.createElement("span");
    actions.className = "motor-group-actions";
    const count = document.createElement("span");
    count.className = "motor-group-count";
    count.textContent = `${groupRows.length} 轴`;
    const addButton = document.createElement("button");
    addButton.className = "group-add-motor-button";
    addButton.type = "button";
    addButton.textContent = "＋ 电机";
    addButton.title = `向“${group.label}”添加电机`;
    addButton.setAttribute("aria-label", `向${group.label}分组添加电机`);
    const deleteButton = document.createElement("button");
    deleteButton.className = "group-delete-button";
    deleteButton.type = "button";
    deleteButton.textContent = "删除组";
    deleteButton.title = groupRows.length
      ? `请先删除“${group.label}”中的全部电机`
      : `删除空分组“${group.label}”`;
    deleteButton.setAttribute("aria-label", `删除${group.label}分组`);
    actions.append(count, addButton, deleteButton);
    heading.append(nameInput, actions);
    section.append(heading, createColumnHeader(), ...groupRows);
    if (!groupRows.length) {
      const empty = document.createElement("p");
      empty.className = "motor-group-empty";
      empty.textContent = "此分组暂无电机，可点击“＋ 电机”添加";
      section.append(empty);
    }
    const bankIndex = columnCount === 1 || groupIndex < splitIndex ? 0 : 1;
    banks[bankIndex].append(section);
  }
  for (const bank of banks) root.append(bank);
  if (!state.groups.length) {
    const empty = document.createElement("p");
    empty.className = "motor-empty";
    empty.textContent = "当前没有分组。点击右上角“＋ 添加分组”开始配置。";
    root.append(empty);
  }
  $("motorCount").textContent = String(state.motors.length);
}

function motorStructureLocked() {
  return state.connected
    || state.connecting
    || state.disconnecting
    || state.busy
    || state.configIoBusy;
}

function groupCatalogEditingLocked() {
  return state.connecting
    || state.disconnecting
    || state.busy
    || state.configIoBusy;
}

function nextNewGroupLabel() {
  const usedLabels = new Set(state.groups.map(({ label }) => (
    label.normalize("NFKC").toLocaleLowerCase("zh-CN")
  )));
  let number = 1;
  while (usedLabels.has(`新分组 ${number}`.normalize("NFKC").toLocaleLowerCase("zh-CN"))) number += 1;
  return `新分组 ${number}`;
}

function addGroup() {
  if (groupCatalogEditingLocked()) {
    toast("当前操作进行中，暂时不能添加分组", "warning");
    return;
  }
  try {
    if (state.groups.length >= registry.MAX_GROUPS) {
      throw new RangeError(`最多可以配置 ${registry.MAX_GROUPS} 个分组`);
    }
    const label = nextNewGroupLabel();
    let sequence = Number.isSafeInteger(state.nextCustomGroupNumber)
      && state.nextCustomGroupNumber >= 1
      && state.nextCustomGroupNumber < Number.MAX_SAFE_INTEGER
      ? state.nextCustomGroupNumber
      : 1;
    let groupId = `custom_group_${sequence}`;
    while (groupById(groupId)) {
      sequence += 1;
      groupId = `custom_group_${sequence}`;
    }
    state.groups = [...registry.normalizeGroupCatalog([
      ...state.groups,
      { id: groupId, label },
    ])];
    state.nextCustomGroupNumber = sequence + 1;
    buildMotorRows();
    const saved = persistState(true);
    refreshMotorRows();
    refreshGroupCatalogControls();
    renderTimeline();
    requestAnimationFrame(() => {
      const input = $("motorRows")?.querySelector(`[data-group-id="${groupId}"] .group-name-input`);
      input?.focus();
      input?.select();
    });
    toast(
      saved ? `${label} 已添加并保存，可直接输入新名称` : `${label} 已添加，但本机保存失败`,
      saved ? "info" : "error",
    );
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function nextNewMotorLabel() {
  const usedLabels = new Set(state.motors.map(({ label }) => (
    label.normalize("NFKC").toLocaleLowerCase("zh-CN")
  )));
  let number = 1;
  while (usedLabels.has(`新电机 ${number}`.normalize("NFKC").toLocaleLowerCase("zh-CN"))) number += 1;
  return `新电机 ${number}`;
}

function requestNewMotorDetails(groups, preferredGroupId = null) {
  return new Promise((resolve) => {
    const modal = $("motorCreateModal");
    const form = $("motorCreateForm");
    const nameInput = $("motorCreateNameInput");
    const groupSelect = $("motorCreateGroupSelect");
    const error = $("motorCreateError");
    const cancelButton = $("motorCreateCancelButton");
    if (!modal.hidden) {
      resolve(null);
      return;
    }
    groupSelect.replaceChildren();
    for (const group of groups) {
      const option = document.createElement("option");
      option.value = group.id;
      option.textContent = group.label;
      groupSelect.append(option);
    }
    const defaultGroupId = groups.some(({ id }) => id === preferredGroupId)
      ? preferredGroupId
      : groups[0]?.id || "";
    groupSelect.value = defaultGroupId;
    nameInput.maxLength = String(registry.MAX_MOTOR_LABEL_LENGTH);
    nameInput.value = nextNewMotorLabel();
    error.textContent = "";
    modal.hidden = false;

    const cleanup = () => {
      form.removeEventListener("submit", submit);
      form.removeEventListener("keydown", keydown);
      cancelButton.removeEventListener("click", cancel);
    };
    const finish = (result) => {
      cleanup();
      modal.hidden = true;
      resolve(result);
    };
    const cancel = () => finish(null);
    const keydown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    const submit = (event) => {
      event.preventDefault();
      try {
        const label = registry.normalizeMotorLabel(nameInput.value);
        const labelKey = label.normalize("NFKC").toLocaleLowerCase("zh-CN");
        if (state.motors.some(({ label: existing }) => (
          existing.normalize("NFKC").toLocaleLowerCase("zh-CN") === labelKey
        ))) throw new RangeError(`电机名称重复: ${label}`);
        const groupId = groupSelect.value;
        if (!groups.some(({ id }) => id === groupId)) throw new RangeError("请选择有效的所属分组");
        finish({ label, groupId });
      } catch (submitError) {
        error.textContent = errorMessage(submitError);
        nameInput.focus();
        nameInput.select();
      }
    };
    form.addEventListener("submit", submit);
    form.addEventListener("keydown", keydown);
    cancelButton.addEventListener("click", cancel);
    requestAnimationFrame(() => {
      nameInput.focus();
      nameInput.select();
    });
  });
}

async function addMotor(preferredGroupId = null) {
  if (motorStructureLocked()) {
    toast(state.connected ? "请先断开 CAN，再添加电机" : "当前操作进行中，暂时不能添加电机", "warning");
    return;
  }
  try {
    if (state.motors.length >= registry.MAX_MOTORS) {
      throw new RangeError(`最多可以配置 ${registry.MAX_MOTORS} 个电机`);
    }
    const availableGroups = state.groups.length
      ? state.groups
      : [...registry.normalizeGroupCatalog([
        { id: registry.CUSTOM_GROUP_ID, label: "自定义电机" },
      ])];
    const defaultGroupId = typeof preferredGroupId === "string"
      && availableGroups.some(({ id }) => id === preferredGroupId)
      ? preferredGroupId
      : availableGroups.find(({ id }) => id === registry.CUSTOM_GROUP_ID)?.id || availableGroups[0].id;
    const details = await requestNewMotorDetails(availableGroups, defaultGroupId);
    if (!details) return;
    if (motorStructureLocked()) {
      toast(state.connected ? "CAN 已连接，本次未添加电机" : "当前状态已变化，本次未添加电机", "warning");
      return;
    }
    const targetGroups = state.groups.length ? state.groups : availableGroups;
    const targetGroupId = details.groupId;
    if (!targetGroups.some(({ id }) => id === targetGroupId)) {
      throw new RangeError("所选分组已不存在，请重新添加");
    }
    const label = registry.normalizeMotorLabel(details.label);
    let sequence = Number.isSafeInteger(state.nextCustomMotorNumber)
      && state.nextCustomMotorNumber >= 1
      && state.nextCustomMotorNumber < Number.MAX_SAFE_INTEGER
      ? state.nextCustomMotorNumber
      : 1;
    let motorId = `custom_motor_${sequence}`;
    while (hasMotor(motorId)) {
      sequence += 1;
      motorId = `custom_motor_${sequence}`;
    }
    const catalog = registry.normalizeMotorCatalog([
      ...state.motors,
      {
        id: motorId,
        label,
        shortLabel: label,
        group: targetGroupId,
      },
    ], targetGroups);
    const motor = catalog.at(-1);
    state.groups = [...targetGroups];
    state.motors = [...catalog];
    state.nextCustomMotorNumber = sequence + 1;
    state.bindings[motor.id] = registry.defaultBinding(motor.id);
    state.drafts[motor.id] = { ...DEFAULT_DRAFT };
    state.timelineTrackEnabled[motor.id] = false;
    if (!state.selectedTimelineMotorId) state.selectedTimelineMotorId = motor.id;
    buildMotorRows();
    const saved = persistState(true);
    refreshMotorRows();
    renderProgram();
    renderTimeline();
    toast(
      saved ? `${motor.label} 已添加并保存；名称和分组已固定` : `${motor.label} 已添加，但本机保存失败`,
      saved ? "info" : "error",
    );
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function commitGroupName(groupId, input) {
  const group = groupById(groupId);
  if (!group) return;
  if (groupCatalogEditingLocked()) {
    input.value = group.label;
    return;
  }
  try {
    const label = registry.normalizeGroupLabel(input.value);
    if (label === group.label) {
      input.value = label;
      return;
    }
    state.groups = [...registry.normalizeGroupCatalog(state.groups.map((entry) => (
      entry.id === groupId ? { ...entry, label } : entry
    )))];
    const saved = persistState(true);
    input.value = label;
    input.dataset.previousLabel = label;
    input.setAttribute?.("aria-label", `${label} 分组名称`);
    renderTimeline();
    toast(
      saved ? `分组“${group.label}”已重命名为“${label}”并保存` : "分组名称已修改，但本机保存失败",
      saved ? "info" : "error",
    );
  } catch (error) {
    input.value = group.label;
    input.classList.add("invalid");
    toast(errorMessage(error), "error");
    setTimeout(() => input.classList.remove("invalid"), 1_500);
  }
}

async function deleteGroup(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  if (groupCatalogEditingLocked()) {
    toast("当前操作进行中，暂时不能删除分组", "warning");
    return;
  }
  const memberMotors = state.motors.filter(({ group: motorGroup }) => motorGroup === groupId);
  if (memberMotors.length) {
    toast(`“${group.label}”分组中还有电机（${memberMotors.length} 个），请先删除组内电机，再删除分组`, "warning");
    return;
  }

  try {
    const nextGroups = registry.normalizeGroupCatalog(
      state.groups.filter(({ id }) => id !== groupId),
    );
    const nextMotors = registry.normalizeMotorCatalog(state.motors, nextGroups);
    state.groups = [...nextGroups];
    state.motors = [...nextMotors];
    buildMotorRows();
    const saved = persistState(true);
    refreshMotorRows();
    refreshGroupCatalogControls();
    renderProgram();
    renderTimeline();
    toast(
      saved ? `空分组“${group.label}”已删除并保存` : `分组“${group.label}”已删除，但本机保存失败`,
      saved ? "info" : "error",
    );
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function deleteMotor(motorId) {
  const motor = motorById(motorId);
  if (!motor) return;
  if (motorStructureLocked()) {
    toast(state.connected ? "请先断开 CAN，再删除电机" : "当前操作进行中，暂时不能删除电机", "warning");
    return;
  }
  const commandReferences = state.program.snapshot().filter((command) => command.motorId === motorId).length;
  const actionReferences = state.timeline.snapshot().filter((action) => action.motorId === motorId).length;
  const remainingMotors = state.motors.filter(({ id }) => id !== motorId);
  const namedImpact = window.LumNamedActions.motorCatalogRemovalImpact(
    new Set(remainingMotors.map(({ id }) => id)),
  );
  if (
    commandReferences
    || actionReferences
    || namedImpact.removedDefinitions
    || namedImpact.removedPlacements
  ) {
    const confirmed = await confirmAction(
      `删除 ${motor.label}`,
      `该电机有 ${commandReferences} 条指令记录、${actionReferences} 个电机时间轴动作，并影响 ${namedImpact.removedDefinitions} 个命名动作和 ${namedImpact.removedPlacements} 个动作时间轴实例。删除电机时会一并清理这些内容。`,
      "删除电机",
    );
    if (!confirmed || motorStructureLocked() || !hasMotor(motorId)) return;
  }

  const motors = remainingMotors;
  const bindings = Object.fromEntries(motors.map(({ id }) => [id, state.bindings[id]]));
  const drafts = Object.fromEntries(motors.map(({ id }) => [id, state.drafts[id]]));
  const removed = installMotorCatalog({ motors, bindings, drafts });
  const remainingCommandIds = new Set(state.program.snapshot().map(({ commandId }) => commandId));
  state.programStats = new Map([...state.programStats].filter(([commandId]) => remainingCommandIds.has(commandId)));
  buildMotorRows();
  resetTimelineEditor({ keepMotor: false });
  const saved = persistState(true);
  refreshMotorRows();
  renderProgram();
  renderTimeline();
  window.LumNamedActions.renderAll();
  const removedAny = removed.removedCommands
    || removed.removedActions
    || removed.removedDefinitions
    || removed.removedPlacements;
  toast(
    saved
      ? `${motor.label} 已删除并保存${removedAny ? `；同时清理 ${removed.removedCommands} 条指令、${removed.removedActions} 个电机时间轴动作、${removed.removedDefinitions || 0} 个命名动作和 ${removed.removedPlacements || 0} 个动作实例` : ""}`
      : `${motor.label} 已删除，但本机保存失败`,
    saved ? "info" : "error",
  );
}

function formatTimelineTime(value) {
  const milliseconds = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

function formatEstimatedDuration(value) {
  const milliseconds = Math.max(1, Math.ceil(Number(value) || 0));
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 10_000) return `${(milliseconds / 1_000).toFixed(2)} s`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return formatTimelineTime(milliseconds);
}

function motionProfileForNode(nodeId) {
  return state.motionProfiles.get(Number(nodeId)) || timelineModel.DEFAULT_MOTION_PROFILE;
}

function timelineActionEstimate(action) {
  return timelineModel.estimateActionDuration(action, motionProfileForNode(action.nodeId));
}

function timelineSchedule(actions = state.timeline.snapshot()) {
  const availableByNode = new Map();
  return actions
    .map((action, insertionIndex) => ({ action, insertionIndex }))
    .sort((left, right) => left.action.startMs - right.action.startMs || left.insertionIndex - right.insertionIndex)
    .map(({ action }) => {
      const estimate = timelineActionEstimate(action);
      const estimatedStartMs = Math.max(action.startMs, availableByNode.get(action.nodeId) || 0);
      const estimatedEndMs = estimatedStartMs + estimate.durationMs;
      availableByNode.set(action.nodeId, estimatedEndMs);
      return Object.freeze({
        action,
        estimate,
        estimatedStartMs,
        estimatedEndMs,
        queuedDelayMs: estimatedStartMs - action.startMs,
      });
    });
}

function enabledTimelineActions(actions = state.timeline.snapshot()) {
  return actions.filter((action) => timelineTrackIsEnabled(action.motorId));
}

function timelineConflictsForActions(actions) {
  const buckets = new Map();
  for (const action of actions) {
    const key = `${action.startMs}:${action.nodeId}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(action);
  }
  return [...buckets.values()]
    .filter((items) => items.length > 1)
    .map((items) => ({ startMs: items[0].startMs, nodeId: items[0].nodeId, actions: items }));
}

function groupTimelineActions(actions) {
  const groups = [];
  actions
    .map((action, insertionIndex) => ({ action, insertionIndex }))
    .sort((left, right) => left.action.startMs - right.action.startMs || left.insertionIndex - right.insertionIndex)
    .forEach(({ action }) => {
      const previous = groups.at(-1);
      if (previous?.startMs === action.startMs) previous.actions.push(action);
      else groups.push({ startMs: action.startMs, actions: [action] });
    });
  return groups;
}

function timelineVisualEndMs() {
  return timelineSchedule().reduce(
    (latest, entry) => Math.max(latest, entry.estimatedEndMs),
    state.timelineDurationMs,
  );
}

function timelineNodeAvailableMs(nodeId) {
  return timelineSchedule().reduce(
    (latest, entry) => entry.action.nodeId === nodeId ? Math.max(latest, entry.estimatedEndMs) : latest,
    0,
  );
}

function timelineMotionProfileNodeIds() {
  const nodeIds = new Set(state.timeline.snapshot().map(({ nodeId }) => nodeId));
  const timelineMotorId = selectedTimelineMotorId();
  const selectedNodeId = timelineMotorId ? bindingNodeId(timelineMotorId) : null;
  if (selectedNodeId != null) nodeIds.add(selectedNodeId);
  return [...nodeIds];
}

async function ensureMotionProfile(nodeId) {
  const targetNodeId = Number(nodeId);
  if (
    !state.connected
    || !Number.isInteger(targetNodeId)
    || targetNodeId < 1
    || targetNodeId > 127
    || state.motionProfiles.has(targetNodeId)
    || state.motionProfileLoading.has(targetNodeId)
    || state.motionProfileErrors.has(targetNodeId)
  ) return;
  const connectionEpoch = state.connectionEpoch;
  state.motionProfileLoading.add(targetNodeId);
  if (state.activePage === "timeline") renderTimelineEstimate();
  try {
    const result = await api.motionProfile(targetNodeId);
    if (!state.connected || connectionEpoch !== state.connectionEpoch) return;
    const profile = timelineModel.normalizeMotionProfile({
      fullSteps: result?.fullSteps,
      microsteps: result?.microsteps,
      speedLimitRpm: result?.speedLimitRpm,
      accelerationLimitRpmS: result?.accelerationLimitRpmS,
      sCurveTimeMs: result?.sCurveTimeMs,
    });
    state.motionProfiles.set(targetNodeId, profile);
    state.motionProfileErrors.delete(targetNodeId);
  } catch (error) {
    if (state.connected && connectionEpoch === state.connectionEpoch) {
      state.motionProfileErrors.set(targetNodeId, errorMessage(error));
    }
  } finally {
    state.motionProfileLoading.delete(targetNodeId);
    if (state.activePage === "timeline") renderTimeline();
    window.LumNamedActions.motionProfilesChanged();
  }
}

function refreshTimelineMotionProfiles() {
  for (const nodeId of timelineMotionProfileNodeIds()) void ensureMotionProfile(nodeId);
}

function timelineActionBindingCurrent(action) {
  return bindingNodeId(action.motorId) === action.nodeId;
}

function selectedTimelineAction() {
  return state.selectedTimelineActionId == null
    ? null
    : state.timeline.get(state.selectedTimelineActionId);
}

function setTimelineDirection(direction) {
  state.timelineDirection = direction === -1 ? -1 : 1;
  for (const button of document.querySelectorAll(".timeline-direction-button")) {
    const active = Number(button.dataset.direction) === state.timelineDirection;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function defaultTimelineMotorId() {
  const ids = motorIds();
  return ids.find((motorId) => bindingNodeId(motorId) != null) || ids[0] || null;
}

function setSelectedTimelineMotorId(motorId) {
  state.selectedTimelineMotorId = hasMotor(motorId)
    ? motorId
    : defaultTimelineMotorId();
  return state.selectedTimelineMotorId;
}

function selectedTimelineMotorId() {
  return hasMotor(state.selectedTimelineMotorId)
    ? state.selectedTimelineMotorId
    : setSelectedTimelineMotorId(null);
}

function renderTimelineMotorSelection() {
  const motorId = selectedTimelineMotorId();
  const motor = motorById(motorId);
  if (!motor) {
    $("timelineSelectedMotorName").textContent = "暂无电机";
    $("timelineSelectedMotorMeta").textContent = "请先到电机控制页添加电机";
    return;
  }
  const nodeId = bindingNodeId(motorId);
  $("timelineSelectedMotorName").textContent = motor?.label || motorId;
  $("timelineSelectedMotorMeta").textContent = nodeId == null
    ? "ID 未配置 · 点击右侧其他电机行即可切换"
    : `CAN ID ${nodeId} · 点击右侧其他电机行即可切换`;
}

function refreshTimelineBindingHint() {
  const motorId = selectedTimelineMotorId();
  const motor = motorById(motorId);
  if (!motor) {
    const hint = $("timelineBindingHint");
    hint.className = "timeline-binding-hint stale";
    hint.textContent = "当前没有电机；请先到电机控制页添加电机";
    return;
  }
  const nodeId = bindingNodeId(motorId);
  const enabled = timelineTrackIsEnabled(motorId);
  const hint = $("timelineBindingHint");
  const selected = selectedTimelineAction();
  hint.className = `timeline-binding-hint ${nodeId == null || !enabled ? "stale" : "ready"}`;
  hint.textContent = nodeId == null
    ? "该位置尚未配置 ID；可编辑，但不能添加或测试"
    : selected && selected.motorId === motorId && selected.nodeId !== nodeId
      ? `当前 ID ${nodeId} · 所选动作保存的是旧 ID ${selected.nodeId}，更新后生效`
      : enabled
        ? `当前绑定 CAN 节点 ID ${nodeId} · 时间轨已使能`
        : `当前绑定 CAN 节点 ID ${nodeId} · 时间轨未使能；可编辑，播放时跳过`;
}

function timelineInteractionLocked() {
  return state.busy || state.configIoBusy || state.connecting || state.disconnecting;
}

function setTimelineTrackEnabled(motorId, input) {
  const locked = timelineInteractionLocked();
  if (!hasMotor(motorId) || locked) {
    input.checked = timelineTrackIsEnabled(motorId);
    return;
  }
  const enabled = input.checked === true;
  if (enabled === timelineTrackIsEnabled(motorId)) return;
  state.timelineTrackEnabled[motorId] = enabled;
  state.timelineEnableRevision += 1;
  const saved = persistState(true);
  renderTimeline();
  const label = motorById(motorId)?.label || motorId;
  const message = enabled
    ? `${label} 已加入时间轨播放`
    : `${label} 已从时间轨播放中跳过`;
  toast(saved ? `${message}，状态已保存` : `${message}，但本机保存失败`, saved ? "info" : "error");
}

function handleTimelineTrackEnableChange(event) {
  const input = event.target.closest(".timeline-track-enable-input");
  if (!input) return;
  setTimelineTrackEnabled(input.dataset.motorId, input);
}

function selectTimelineMotor(motorId) {
  if (!hasMotor(motorId) || timelineInteractionLocked()) return false;
  if (selectedTimelineMotorId() === motorId && !selectedTimelineAction()) return false;
  setSelectedTimelineMotorId(motorId);
  resetTimelineEditor();
  renderTimeline();
  const nodeId = bindingNodeId(motorId);
  if (nodeId != null) void ensureMotionProfile(nodeId);
  return true;
}

function handleTimelineTrackSelection(event) {
  if (event.target.closest(".timeline-clip, .timeline-track-enable-control")) return;
  const track = event.target.closest(".timeline-track-label, .timeline-track-lane");
  if (!track?.dataset.motorId) return;
  const restoreKeyboardFocus = event.detail === 0
    && Boolean(event.target.closest(".timeline-track-select-button"));
  if (!selectTimelineMotor(track.dataset.motorId) || !restoreKeyboardFocus) return;
  document.querySelector(
    `.timeline-track-label[data-motor-id="${CSS.escape(track.dataset.motorId)}"] .timeline-track-select-button`,
  )?.focus();
}

function resetTimelineEditor(options = {}) {
  const { keepMotor = true } = options;
  state.selectedTimelineActionId = null;
  const motorId = keepMotor
    ? selectedTimelineMotorId()
    : setSelectedTimelineMotorId(null);
  const draft = state.drafts[motorId] || DEFAULT_DRAFT;
  $("timelineStartInput").value = String(state.timelineCursorMs);
  $("timelineStepsInput").value = draft.steps;
  $("timelineSpeedInput").value = draft.speed;
  $("timelineAccelerationInput").value = draft.acceleration;
  $("timelineLoopModeSelect").value = draft.closed ? "closed" : "open";
  setTimelineDirection(1);
  refreshTimelineBindingHint();
  renderTimelineEditorState();
}

function loadTimelineActionIntoEditor(action) {
  if (!action) {
    resetTimelineEditor();
    return;
  }
  state.selectedTimelineActionId = action.actionId;
  setSelectedTimelineMotorId(action.motorId);
  $("timelineStartInput").value = String(action.startMs);
  $("timelineStepsInput").value = String(Math.abs(action.signedSteps));
  $("timelineSpeedInput").value = String(action.speed);
  $("timelineAccelerationInput").value = String(action.acceleration);
  $("timelineLoopModeSelect").value = action.closed ? "closed" : "open";
  setTimelineDirection(action.signedSteps < 0 ? -1 : 1);
  refreshTimelineBindingHint();
  renderTimelineEditorState();
}

function renderTimelineEditorState() {
  const selected = selectedTimelineAction();
  $("timelineEditorMode").textContent = selected
    ? `编辑 ${motorById(selected.motorId)?.label || selected.motorId} · ${loopModeLabel(selected.closed)} · ${formatTimelineTime(selected.startMs)}`
    : state.motors.length
      ? "新建动作 · 拖动时间尺获取开始时间"
      : "请先到电机控制页添加电机";
  $("timelineSaveActionButton").textContent = "＋ 添加为新动作";
  $("timelineUpdateActionButton").hidden = !selected;
  $("timelineDeleteActionButton").hidden = !selected;
}

function timelineDraftFromEditor() {
  const motorId = selectedTimelineMotorId();
  if (!motorId || !motorById(motorId)) throw new Error("请先添加一个电机");
  const nodeId = bindingNodeId(motorId);
  if (nodeId == null) throw new Error(`${motorById(motorId).label} 尚未配置 CAN ID`);
  const rawStartMs = Number($("timelineStartInput").value);
  if (!Number.isSafeInteger(rawStartMs) || rawStartMs < 0 || rawStartMs > timelineModel.MAX_START_MS) {
    throw new Error(`开始时间必须是 0–${timelineModel.MAX_START_MS} ms 的整数`);
  }
  const startMs = timelineModel.snapStartMs(
    rawStartMs,
    state.timelineSnapMs,
    timelineModel.MAX_START_MS,
  );
  return timelineModel.validateAction({
    motorId,
    nodeId,
    startMs,
    signedSteps: state.timelineDirection * positiveStepMagnitude($("timelineStepsInput").value),
    speed: $("timelineSpeedInput").value,
    acceleration: $("timelineAccelerationInput").value,
    closed: $("timelineLoopModeSelect").value === "closed",
  });
}

function projectedTimelineEntry(draft) {
  const selected = selectedTimelineAction();
  const candidate = Object.freeze({
    ...draft,
    actionId: selected?.actionId || "__timeline-preview__",
  });
  const actions = selected
    ? state.timeline.snapshot().map((action) => action.actionId === selected.actionId ? candidate : action)
    : [...state.timeline.snapshot(), candidate];
  return timelineSchedule(actions).find(({ action }) => action.actionId === candidate.actionId) || null;
}

function renderTimelineEstimate() {
  const duration = $("timelineEstimatedDuration");
  const windowText = $("timelineEstimatedWindow");
  const profileText = $("timelineEstimateProfile");
  const placeAfter = $("timelinePlaceAfterButton");
  if (!duration || !windowText || !profileText || !placeAfter) return;
  windowText.className = "";
  placeAfter.dataset.startMs = "";
  try {
    const draft = timelineDraftFromEditor();
    const entry = projectedTimelineEntry(draft);
    const estimate = entry?.estimate || timelineActionEstimate(draft);
    const profile = motionProfileForNode(draft.nodeId);
    duration.textContent = formatEstimatedDuration(estimate.durationMs);
    const shape = estimate.profileType === "s-curve-cruise" ? "S 曲线＋匀速段" : "短行程 S 曲线";
    if (entry?.queuedDelayMs > 0) {
      windowText.className = "warning";
      windowText.textContent = `发送 ${formatTimelineTime(draft.startMs)}；同 ID 忙到 ${formatTimelineTime(entry.estimatedStartMs)}，预计结束 ${formatTimelineTime(entry.estimatedEndMs)}`;
    } else {
      const endMs = draft.startMs + estimate.durationMs;
      windowText.textContent = `发送 ${formatTimelineTime(draft.startMs)} → 预计结束 ${formatTimelineTime(endMs)} · ${shape}${draft.closed ? " · 闭环实际到位时间另计" : ""}`;
    }

    if (state.motionProfiles.has(draft.nodeId)) {
      profileText.textContent = `节点 ${draft.nodeId} 实际参数 · ${profile.fullSteps} 整步 × ${profile.microsteps} 微步 · ${profile.speedLimitRpm} rpm / ${profile.accelerationLimitRpmS} rpm/s`;
    } else if (state.motionProfileLoading.has(draft.nodeId)) {
      profileText.textContent = `正在读取节点 ${draft.nodeId} 参数；当前暂按固件默认值估算`;
    } else if (state.motionProfileErrors.has(draft.nodeId)) {
      profileText.textContent = `节点 ${draft.nodeId} 参数未读取到；当前按固件默认值估算`;
    } else {
      profileText.textContent = `固件默认参数 · ${profile.fullSteps} 整步 × ${profile.microsteps} 微步 · ${profile.speedLimitRpm} rpm / ${profile.accelerationLimitRpmS} rpm/s`;
    }

    const availableMs = timelineNodeAvailableMs(draft.nodeId);
    const snapMs = state.timelineSnapMs || 1;
    const nextStartMs = Math.ceil(availableMs / snapMs) * snapMs;
    if (availableMs > 0 && nextStartMs <= timelineModel.MAX_START_MS) {
      placeAfter.dataset.startMs = String(nextStartMs);
      placeAfter.textContent = `接到同 ID 最后 · ${formatTimelineTime(nextStartMs)}`;
    } else if (availableMs > timelineModel.MAX_START_MS) {
      placeAfter.textContent = "同 ID 预计结束时间已超过 10:00";
    } else {
      placeAfter.textContent = "同 ID 暂无前序动作";
    }
  } catch (_) {
    duration.textContent = "—";
    windowText.textContent = "输入完整且有效的步数、速度和加速度后显示";
    profileText.textContent = "连接 CAN 后会自动只读获取该节点的实际运动参数";
    placeAfter.textContent = "接到同 ID 最后";
  }
}

function timelineConflictActionIds() {
  return new Set(timelineConflictsForActions(enabledTimelineActions())
    .flatMap(({ actions }) => actions.map(({ actionId }) => actionId)));
}

function renderTimelineRuler(visualDurationMs = state.timelineDurationMs) {
  const ruler = $("timelineRuler");
  ruler.replaceChildren();
  const seconds = Math.ceil(visualDurationMs / 1_000);
  for (let second = 0; second <= seconds; second += 1) {
    const tick = document.createElement("span");
    tick.className = "timeline-ruler-tick";
    tick.style.left = `${second * state.timelinePixelsPerSecond}px`;
    const label = document.createElement("span");
    label.textContent = second < 60 ? `${second}s` : `${Math.floor(second / 60)}:${String(second % 60).padStart(2, "0")}`;
    tick.append(label);
    ruler.append(tick);
  }
}

function renderTimelineTracks() {
  const tracks = $("timelineTracks");
  tracks.replaceChildren();
  const conflicts = timelineConflictActionIds();
  const scheduleByActionId = new Map(
    timelineSchedule(enabledTimelineActions()).map((entry) => [entry.action.actionId, entry]),
  );
  const actionsByMotor = new Map(motorIds().map((motorId) => [motorId, []]));
  for (const action of state.timeline.snapshot()) actionsByMotor.get(action.motorId)?.push(action);

  for (const group of state.groups) {
    const groupedMotors = state.motors.filter((motor) => motor.group === group.id);
    if (!groupedMotors.length) continue;
    const divider = document.createElement("div");
    divider.className = "timeline-group-divider";
    divider.dataset.groupId = group.id;
    divider.textContent = group.label;
    const count = document.createElement("small");
    count.textContent = `${groupedMotors.length} 轴`;
    divider.append(count);
    tracks.append(divider);

    for (const motor of groupedMotors) {
    const trackSelected = motor.id === selectedTimelineMotorId();
    const row = document.createElement("div");
    row.className = `timeline-track-row${trackSelected ? " selected-track" : ""}`;
    row.dataset.motorId = motor.id;
    const nodeId = bindingNodeId(motor.id);
    const positionEnabled = timelineTrackIsEnabled(motor.id);
    const label = document.createElement("div");
    label.className = `timeline-track-label ${nodeId == null ? "" : "bound"}${positionEnabled ? " enabled" : " disabled-position"}${trackSelected ? " selected-track" : ""}`;
    label.dataset.motorId = motor.id;
    label.title = `点击选择 ${motor.label} 并新建动作`;
    const heading = document.createElement("div");
    heading.className = "timeline-track-heading";
    const name = document.createElement("button");
    name.className = "timeline-track-select-button";
    name.type = "button";
    name.textContent = motor.label;
    name.setAttribute("aria-pressed", String(trackSelected));
    name.setAttribute("aria-label", `${trackSelected ? "当前已选择" : "选择"}${motor.label}轨道，新建动作`);
    const enableControl = document.createElement("label");
    enableControl.className = "timeline-track-enable-control";
    enableControl.title = `${motor.label} 时间轨使能；未勾选的动作播放时跳过`;
    const enableInput = document.createElement("input");
    enableInput.className = "timeline-track-enable-input";
    enableInput.type = "checkbox";
    enableInput.checked = positionEnabled;
    enableInput.disabled = state.busy || state.configIoBusy || state.connecting || state.disconnecting;
    enableInput.dataset.motorId = motor.id;
    enableInput.setAttribute("aria-label", `${motor.label} 时间轨使能`);
    const enableText = document.createElement("span");
    enableText.textContent = "使能";
    enableControl.append(enableInput, enableText);
    heading.append(name, enableControl);
    const id = document.createElement("small");
    id.textContent = nodeId == null ? "ID 未配置" : `当前 ID ${nodeId} · ${positionEnabled ? "播放" : "跳过"}`;
    label.append(heading, id);

    const lane = document.createElement("div");
    lane.className = `timeline-track-lane${trackSelected ? " selected-track" : ""}`;
    lane.dataset.motorId = motor.id;
    lane.title = `点击空白处选择 ${motor.label} 并新建动作`;
    for (const action of actionsByMotor.get(motor.id).sort((left, right) => left.startMs - right.startMs)) {
      const clip = document.createElement("button");
      const stale = !timelineActionBindingCurrent(action);
      const schedule = scheduleByActionId.get(action.actionId);
      const estimate = schedule?.estimate || timelineActionEstimate(action);
      const queued = Number(schedule?.queuedDelayMs) > 0;
      const visibleDurationMs = Math.max(
        1,
        Math.min(estimate.durationMs, timelineModel.MAX_START_MS - action.startMs),
      );
      clip.type = "button";
      clip.className = `timeline-clip ${action.signedSteps < 0 ? "negative" : "positive"}${action.closed ? " closed-loop" : " open-loop"}${action.actionId === state.selectedTimelineActionId ? " selected" : ""}${conflicts.has(action.actionId) ? " conflict" : ""}${queued ? " queued" : ""}${!timelineTrackIsEnabled(action.motorId) ? " disabled-position" : ""}${stale ? " stale" : ""}`;
      clip.dataset.actionId = action.actionId;
      clip.dataset.mode = action.closed ? "闭" : "开";
      clip.dataset.summary = `${loopModeLabel(action.closed)} · ${formatSigned(action.signedSteps)} step · 约 ${formatEstimatedDuration(estimate.durationMs)} · 至 ${formatTimelineTime(schedule?.estimatedEndMs ?? action.startMs + estimate.durationMs)}`;
      clip.style.left = `${action.startMs / 1_000 * state.timelinePixelsPerSecond}px`;
      clip.style.width = `${Math.max(12, visibleDurationMs / 1_000 * state.timelinePixelsPerSecond)}px`;
      clip.title = `${motor.label} · ${loopModeLabel(action.closed)} · 发送 ${formatTimelineTime(action.startMs)} · 理论持续 ${formatEstimatedDuration(estimate.durationMs)} · 预计结束 ${formatTimelineTime(schedule?.estimatedEndMs ?? action.startMs + estimate.durationMs)} · ID ${action.nodeId} · ${formatSigned(action.signedSteps)} step · V${action.speed}/A${action.acceleration}${action.closed ? " · 闭环实际到位可能晚于理论轨迹" : ""}${queued ? ` · 同 ID 排队约 ${formatEstimatedDuration(schedule.queuedDelayMs)}` : ""}${!positionEnabled ? " · 时间轨未使能，播放时跳过" : ""}${stale ? " · 当前绑定已变化" : ""}`;
      clip.setAttribute("aria-label", clip.title);
      const primary = document.createElement("b");
      primary.textContent = `${formatSigned(action.signedSteps)} · ${action.startMs}ms`;
      const secondary = document.createElement("small");
      secondary.textContent = `${loopModeLabel(action.closed)} · ID ${action.nodeId} · V${action.speed}/A${action.acceleration}`;
      clip.append(primary, secondary);
      lane.append(clip);
    }
    row.append(label, lane);
      tracks.append(row);
    }
  }
  if (!state.motors.length) {
    const empty = document.createElement("p");
    empty.className = "motor-empty";
    empty.textContent = "当前没有可编辑的电机轨道。请先到电机控制页添加电机。";
    tracks.append(empty);
  }
}

function renderTimelineCursor() {
  const cursor = Math.min(state.timelineDurationMs, Math.max(0, state.timelineCursorMs));
  state.timelineCursorMs = cursor;
  $("timelineCanvas").style.setProperty("--playhead-x", `${cursor / 1_000 * state.timelinePixelsPerSecond}px`);
  $("timelineTimeDisplay").textContent = `${formatTimelineTime(cursor)} / ${formatTimelineTime(state.timelineDurationMs)}`;
  $("timelinePlayhead").dataset.time = `${cursor} ms`;
  $("timelineRuler").setAttribute("aria-valuemax", String(state.timelineDurationMs));
  $("timelineRuler").setAttribute("aria-valuenow", String(cursor));
  $("timelineRuler").setAttribute("aria-valuetext", `${cursor} ms`);
}

function followTimelineCursor() {
  if (state.activePage !== "timeline") return;
  const scroller = $("timelineScroller");
  const canvasStyle = getComputedStyle($("timelineCanvas"));
  const labelWidth = Number.parseFloat(canvasStyle.getPropertyValue("--track-label-width")) || 0;
  const cursorPixels = state.timelineCursorMs / 1_000 * state.timelinePixelsPerSecond;
  const playheadContentX = labelWidth + cursorPixels;
  const leftEdge = scroller.scrollLeft + labelWidth + 24;
  const rightEdge = scroller.scrollLeft + scroller.clientWidth - 36;
  if (playheadContentX > rightEdge) {
    scroller.scrollLeft = Math.max(0, playheadContentX - scroller.clientWidth + 56);
  } else if (playheadContentX < leftEdge) {
    scroller.scrollLeft = Math.max(0, cursorPixels - 24);
  }
}

function timelineStatusText() {
  if (state.timelineRun?.phase === "playing") {
    return `正在按时间发送 · ${state.timelineRun.sentCount} / ${state.timelineRun.actionCount} 个动作已触发`;
  }
  if (state.timelineRun?.phase === "draining") return "动作均已发送，正在等待相关节点 FIFO 清空";
  if (state.timelineTest) return "正在测试动作；可随时点击“停止测试”";
  if (!state.motors.length) return "当前没有电机；请先到电机控制页添加电机";
  const actions = state.timeline.snapshot();
  const activeActions = enabledTimelineActions(actions);
  const conflicts = timelineConflictsForActions(activeActions);
  if (conflicts.length) return `存在 ${conflicts.length} 组同一时间、同一物理 ID 冲突，需错开时间`;
  const stale = activeActions.filter((action) => !timelineActionBindingCurrent(action));
  if (stale.length) return `${stale.length} 个已使能动作的 ID 已变化；选择动作并更新后才能播放`;
  if (actions.length && !activeActions.length) return "当前没有已使能的动作轨道；勾选轨道使能后才能播放";
  const queued = timelineSchedule(activeActions).filter(({ queuedDelayMs }) => queuedDelayMs > 0);
  if (queued.length) return `${queued.length} 个动作早于同 ID 的预计结束时间，播放时会进入电机 FIFO 排队`;
  if (activeActions.length < actions.length) {
    return `将播放 ${activeActions.length} / ${actions.length} 个动作；未使能轨道的动作会跳过`;
  }
  return "拖动时间尺或黄色指针获取开始时间；点击电机行新建，点击动作块编辑";
}

function timelineEditorInputsValid() {
  try {
    timelineDraftFromEditor();
    return true;
  } catch (_) {
    return false;
  }
}

function renderTimelineControls() {
  const locked = state.busy || state.configIoBusy || state.connecting || state.disconnecting;
  const actions = state.timeline.snapshot();
  const activeActions = enabledTimelineActions(actions);
  const stale = activeActions.some((action) => !timelineActionBindingCurrent(action));
  const conflicts = timelineConflictsForActions(activeActions).length > 0;
  const running = Boolean(state.timelineRun);
  const editorValid = timelineEditorInputsValid();
  const noMotors = state.motors.length === 0;
  for (const id of [
    "timelineStartInput", "timelineStepsInput", "timelineSpeedInput",
    "timelineAccelerationInput", "timelineLoopModeSelect",
    "timelineSaveActionButton", "timelineUpdateActionButton",
    "timelineDeleteActionButton",
  ]) $(id).disabled = locked || noMotors;
  for (const id of [
    "timelineDurationInput", "timelineSnapSelect", "timelineZoomInput",
    "timelineSaveProjectButton", "timelineImportProjectButton", "timelineExportProjectButton",
  ]) $(id).disabled = locked;
  for (const button of document.querySelectorAll(".timeline-direction-button")) {
    button.disabled = locked || noMotors;
  }
  for (const input of document.querySelectorAll(".timeline-track-enable-input")) input.disabled = locked;
  $("timelineSaveActionButton").disabled = locked || noMotors || !editorValid;
  $("timelineUpdateActionButton").disabled = locked || noMotors || !editorValid || !selectedTimelineAction();
  const editorTrackEnabled = timelineTrackIsEnabled(selectedTimelineMotorId());
  $("timelineTestButton").disabled = !state.connected || locked || !editorValid || !editorTrackEnabled;
  $("timelineStopTestButton").disabled = !state.timelineTest || state.disconnecting;
  $("timelinePlayButton").disabled = !state.connected || locked || !activeActions.length || stale || conflicts;
  $("timelineStopButton").disabled = !running || state.disconnecting;
  $("timelineClearButton").disabled = locked || actions.length === 0;
  $("timelineEnabledTrackCount").textContent = String(
    motorIds().filter((motorId) => timelineTrackIsEnabled(motorId)).length,
  );
  $("timelineActionCount").textContent = String(actions.length);
  $("timelineStatus").textContent = timelineStatusText();
  renderTimelineEstimate();
  $("timelinePlaceAfterButton").disabled = locked || !$("timelinePlaceAfterButton").dataset.startMs;
  for (const { tabId } of PAGE_DEFINITIONS) $(tabId).disabled = locked;
  renderTimelineEditorState();
  renderTimelineCursor();
}

function renderTimeline() {
  const canvas = $("timelineCanvas");
  const visualDurationMs = Math.min(
    timelineModel.MAX_START_MS,
    Math.ceil(timelineVisualEndMs() / 1_000) * 1_000,
  );
  const width = Math.max(600, visualDurationMs / 1_000 * state.timelinePixelsPerSecond);
  canvas.style.setProperty("--timeline-width", `${width}px`);
  canvas.style.setProperty("--second-width", `${state.timelinePixelsPerSecond}px`);
  canvas.style.setProperty("--minor-width", `${Math.max(5, state.timelinePixelsPerSecond / 10)}px`);
  $("timelineDurationInput").value = String(state.timelineDurationMs / 1_000);
  $("timelineSnapSelect").value = String(state.timelineSnapMs);
  $("timelineZoomInput").value = String(state.timelinePixelsPerSecond);
  renderTimelineMotorSelection();
  refreshTimelineBindingHint();
  renderTimelineRuler(visualDurationMs);
  renderTimelineTracks();
  renderTimelineControls();
}

function switchPage(page) {
  if (state.busy || state.configIoBusy || state.disconnecting) return;
  const definition = PAGE_DEFINITIONS.find(({ id }) => id === page);
  if (!definition) return;
  state.activePage = definition.id;
  for (const entry of PAGE_DEFINITIONS) {
    const active = entry.id === state.activePage;
    $(entry.panelId).hidden = !active;
    $(entry.tabId).classList.toggle("active", active);
    $(entry.tabId).setAttribute("aria-selected", String(active));
    $(entry.tabId).tabIndex = active ? 0 : -1;
  }
  if (state.activePage === "motor") flushMotorStatusUiRefresh(true);
  if (state.activePage === "timeline") {
    renderTimeline();
    refreshTimelineMotionProfiles();
  }
  if (state.activePage === "namedAction" || state.activePage === "actionTimeline") {
    window.LumNamedActions.renderPage(state.activePage);
  }
}

function saveTimelineAction(updateSelected = false) {
  try {
    const draft = timelineDraftFromEditor();
    const selected = selectedTimelineAction();
    if (updateSelected && !selected) throw new Error("请先选择要更新的时间轨动作");
    const saved = updateSelected
      ? state.timeline.update(selected.actionId, draft)
      : state.timeline.add(draft);
    state.selectedTimelineActionId = saved.actionId;
    state.timelineCursorMs = saved.startMs;
    state.timelineDurationMs = Math.min(
      timelineModel.MAX_START_MS,
      Math.max(
        state.timelineDurationMs,
        Math.ceil(timelineVisualEndMs() / 1_000) * 1_000,
      ),
    );
    const savedLocally = persistState(true);
    loadTimelineActionIntoEditor(saved);
    renderTimeline();
    toast(
      savedLocally
        ? (updateSelected ? "时间轨动作已更新并保存" : "新动作已添加到时间轨并保存")
        : (updateSelected ? "动作已更新到当前会话，但本机保存失败" : "新动作已添加到当前会话，但本机保存失败"),
      savedLocally ? "info" : "error",
    );
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function deleteSelectedTimelineAction() {
  const selected = selectedTimelineAction();
  if (!selected || state.busy) return;
  state.timeline.remove(selected.actionId);
  state.selectedTimelineActionId = null;
  const savedLocally = persistState(true);
  resetTimelineEditor();
  renderTimeline();
  toast(savedLocally ? "所选时间轨动作已删除" : "动作已删除，但本机保存失败", savedLocally ? "info" : "error");
}

function clearTimeline() {
  if (state.busy) return;
  const removed = state.timeline.clear();
  state.selectedTimelineActionId = null;
  state.timelineCursorMs = 0;
  const savedLocally = persistState(true);
  resetTimelineEditor();
  renderTimeline();
  if (removed) toast(
    savedLocally ? `已清空 ${removed} 个时间轨动作` : `已清空 ${removed} 个动作，但本机保存失败`,
    savedLocally ? "info" : "error",
  );
}

function setTimelineCursorFromPointer(event, options = {}) {
  const { autoScroll = false } = options;
  if (autoScroll) {
    const scroller = $("timelineScroller");
    const bounds = scroller.getBoundingClientRect();
    const canvasStyle = getComputedStyle($("timelineCanvas"));
    const labelWidth = Number.parseFloat(canvasStyle.getPropertyValue("--track-label-width")) || 0;
    if (event.clientX < bounds.left + labelWidth + 24) {
      scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 18);
    } else if (event.clientX > bounds.right - 28) {
      scroller.scrollLeft += 18;
    }
  }
  const rect = $("timelineRuler").getBoundingClientRect();
  const milliseconds = timelineModel.millisecondsFromPixels(event.clientX - rect.left, state.timelinePixelsPerSecond);
  state.timelineCursorMs = timelineModel.snapStartMs(milliseconds, event.altKey ? 0 : state.timelineSnapMs, state.timelineDurationMs);
  $("timelineStartInput").value = String(state.timelineCursorMs);
  renderTimelineCursor();
  renderTimelineEstimate();
  $("timelinePlaceAfterButton").disabled = timelineInteractionLocked()
    || !$("timelinePlaceAfterButton").dataset.startMs;
}

function beginTimelineCursorDrag(event) {
  if (timelineInteractionLocked() || event.button !== 0 || event.isPrimary === false) return;
  event.preventDefault();
  const ruler = $("timelineRuler");
  state.timelineCursorDrag = { pointerId: event.pointerId };
  ruler.classList.add("dragging");
  $("timelinePlayhead").classList.add("dragging");
  try {
    ruler.setPointerCapture(event.pointerId);
  } catch (_) {
    state.timelineCursorDrag = null;
    ruler.classList.remove("dragging");
    $("timelinePlayhead").classList.remove("dragging");
    return;
  }
  ruler.focus({ preventScroll: true });
  setTimelineCursorFromPointer(event);
}

function moveTimelineCursorDrag(event) {
  const drag = state.timelineCursorDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (timelineInteractionLocked()) {
    finishTimelineCursorDrag(event, true);
    return;
  }
  event.preventDefault();
  setTimelineCursorFromPointer(event, { autoScroll: true });
}

function finishTimelineCursorDrag(event, canceled = false) {
  const drag = state.timelineCursorDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (!canceled && !timelineInteractionLocked()) setTimelineCursorFromPointer(event);
  state.timelineCursorDrag = null;
  const ruler = $("timelineRuler");
  ruler.classList.remove("dragging");
  $("timelinePlayhead").classList.remove("dragging");
  try {
    if (ruler.hasPointerCapture(event.pointerId)) ruler.releasePointerCapture(event.pointerId);
  } catch (_) {
    // Pointer capture may already be gone after cancel or window blur.
  }
  renderTimelineControls();
}

function moveTimelineCursorWithKeyboard(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || timelineInteractionLocked()) return;
  event.preventDefault();
  const step = state.timelineSnapMs || 50;
  if (event.key === "Home") state.timelineCursorMs = 0;
  else if (event.key === "End") state.timelineCursorMs = state.timelineDurationMs;
  else state.timelineCursorMs = Math.min(
    state.timelineDurationMs,
    Math.max(0, state.timelineCursorMs + (event.key === "ArrowLeft" ? -step : step)),
  );
  $("timelineStartInput").value = String(state.timelineCursorMs);
  renderTimelineCursor();
  renderTimelineEstimate();
  followTimelineCursor();
}

function placeTimelineActionAfterNode() {
  if (state.busy || state.configIoBusy || state.connecting || state.disconnecting) return;
  const startMs = Number($("timelinePlaceAfterButton").dataset.startMs);
  if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs > timelineModel.MAX_START_MS) return;
  $("timelineStartInput").value = String(startMs);
  state.timelineCursorMs = Math.min(startMs, state.timelineDurationMs);
  renderTimelineControls();
  renderTimelineCursor();
}

function selectTimelineClip(event) {
  const clip = event.target.closest(".timeline-clip");
  if (!clip || timelineInteractionLocked()) return;
  const action = state.timeline.get(clip.dataset.actionId);
  if (!action) return;
  state.selectedTimelineActionId = action.actionId;
  loadTimelineActionIntoEditor(action);
  renderTimeline();
  document.querySelector(`.timeline-clip[data-action-id="${CSS.escape(action.actionId)}"]`)?.focus();
}

function timelineLaneAtPoint(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY);
  return target?.closest(".timeline-track-lane, .timeline-track-label") || null;
}

function beginTimelineDrag(event) {
  const clip = event.target.closest(".timeline-clip");
  if (!clip || timelineInteractionLocked() || event.button !== 0) return;
  const action = state.timeline.get(clip.dataset.actionId);
  if (!action) return;
  event.preventDefault();
  state.selectedTimelineActionId = action.actionId;
  loadTimelineActionIntoEditor(action);
  for (const candidate of document.querySelectorAll(".timeline-clip")) {
    candidate.classList.toggle("selected", candidate === clip);
  }
  clip.setPointerCapture(event.pointerId);
  clip.classList.add("dragging");
  state.timelineDrag = {
    pointerId: event.pointerId,
    clip,
    action,
    startClientX: event.clientX,
    startScrollLeft: $("timelineScroller").scrollLeft,
    startMs: action.startMs,
    targetMotorId: action.motorId,
    previewStartMs: action.startMs,
  };
}

function moveTimelineDrag(event) {
  const drag = state.timelineDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const scroller = $("timelineScroller");
  const bounds = scroller.getBoundingClientRect();
  if (event.clientX < bounds.left + 28) scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 18);
  if (event.clientX > bounds.right - 28) scroller.scrollLeft += 18;
  if (event.clientY < bounds.top + 42) scroller.scrollTop = Math.max(0, scroller.scrollTop - 18);
  if (event.clientY > bounds.bottom - 28) scroller.scrollTop += 18;
  const pixels = event.clientX - drag.startClientX + scroller.scrollLeft - drag.startScrollLeft;
  const milliseconds = drag.startMs + timelineModel.millisecondsFromPixels(pixels, state.timelinePixelsPerSecond);
  drag.previewStartMs = timelineModel.snapStartMs(
    milliseconds,
    event.altKey ? 0 : state.timelineSnapMs,
    state.timelineDurationMs,
  );
  drag.clip.style.left = `${drag.previewStartMs / 1_000 * state.timelinePixelsPerSecond}px`;
  const lane = timelineLaneAtPoint(event.clientX, event.clientY);
  if (lane?.dataset.motorId) drag.targetMotorId = lane.dataset.motorId;
  for (const candidate of document.querySelectorAll(".timeline-track-lane")) {
    candidate.classList.toggle("drop-target", candidate.dataset.motorId === drag.targetMotorId);
  }
}

function finishTimelineDrag(event, canceled = false) {
  const drag = state.timelineDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  state.timelineDrag = null;
  try {
    if (drag.clip.hasPointerCapture(event.pointerId)) drag.clip.releasePointerCapture(event.pointerId);
  } catch (_) {
    // The element may have lost capture when the window lost focus.
  }
  if (!canceled && !timelineInteractionLocked()) {
    const nodeId = bindingNodeId(drag.targetMotorId);
    if (nodeId == null) {
      toast(`${motorById(drag.targetMotorId).label} 尚未配置 ID，动作没有移动到该轨道`, "error");
    } else {
      const updated = state.timeline.update(drag.action.actionId, {
        motorId: drag.targetMotorId,
        nodeId,
        startMs: drag.previewStartMs,
      });
      state.selectedTimelineActionId = updated.actionId;
      state.timelineCursorMs = updated.startMs;
      if (!persistState(true)) toast("动作已移动，但本机保存失败", "error");
      loadTimelineActionIntoEditor(updated);
    }
  }
  renderTimeline();
}

function positiveStepMagnitude(value) {
  if (value === null || value === "" || typeof value === "boolean") {
    throw new TypeError("步数必须是正整数");
  }
  const steps = Number(value);
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > commandModel.MAX_STEP_COUNT) {
    throw new RangeError(`步数必须为 1–${commandModel.MAX_STEP_COUNT}`);
  }
  return steps;
}

function draftIsValid(motorId) {
  const draft = state.drafts[motorId];
  try {
    commandModel.validateCommand({
      motorId,
      nodeId: bindingNodeId(motorId) ?? 1,
      signedSteps: positiveStepMagnitude(draft.steps),
      speed: draft.speed,
      acceleration: draft.acceleration,
      closed: draft.closed,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function nodeStatusIsFreshAndIdle(
  nodeId,
  minimumSeenAt = Date.now() - STATUS_FRESH_MS,
  expectedSequence = null,
) {
  const runtime = state.nodeStatus.get(nodeId);
  const statusAAt = Number(runtime?.lastStatusAAt);
  const statusDAt = Number(runtime?.lastStatusDAt);
  return Boolean(
    runtime
    && statusAAt >= minimumSeenAt
    && statusDAt >= statusAAt
    && Date.now() - statusDAt <= STATUS_FRESH_MS
    && runtime.moving === false
    && Number(runtime.queueOutstanding) === 0
    && runtime.queueActive !== true
    && runtime.handoffPending !== true
    && Number(runtime.relativeRemaining) === 0
    && !hasFault(runtime.faultFlags)
    && (!Number.isInteger(expectedSequence)
      || Number(runtime.lastMotionSequence) === expectedSequence)
  );
}

function scheduleMotorStatusUiRefresh() {
  motorStatusUiDirty = true;
  if (state.activePage !== "motor" || motorStatusRenderHandle != null) return;
  motorStatusRenderHandle = requestAnimationFrame(() => {
    motorStatusRenderHandle = null;
    if (state.activePage !== "motor" || !motorStatusUiDirty) return;
    motorStatusUiDirty = false;
    refreshMotorRows();
    renderOrigin();
  });
}

function flushMotorStatusUiRefresh(force = false) {
  if (motorStatusRenderHandle != null) cancelAnimationFrame(motorStatusRenderHandle);
  motorStatusRenderHandle = null;
  if (state.activePage !== "motor") {
    motorStatusUiDirty = true;
    return;
  }
  if (!force && !motorStatusUiDirty) return;
  motorStatusUiDirty = false;
  refreshMotorRows();
  renderOrigin();
}

function refreshMotorRows() {
  if (state.activePage !== "motor") {
    motorStatusUiDirty = true;
    return;
  }
  const positions = nodePositionSummary();
  let configured = 0;
  for (const motor of state.motors) {
    const row = motorRows.get(motor.id);
    if (!row) continue;
    const nodeId = bindingNodeId(motor.id);
    const runtime = nodeId == null ? null : state.nodeStatus.get(nodeId);
    const validDraft = draftIsValid(motor.id);
    if (nodeId != null) configured += 1;

    row.classList.toggle("bound", nodeId != null);
    row.classList.toggle("online", Boolean(runtime));
    row.classList.toggle("draft-invalid", !validDraft);
    row.querySelector(".motor-position").textContent = `累计 ${nodeId == null ? 0 : Number(positions[String(nodeId)]) || 0}`;

    const idInput = row.querySelector(".motor-id-input");
    if (document.activeElement !== idInput) idInput.value = nodeId ?? "";
    const configurationLocked = state.busy || state.configIoBusy || state.connecting || state.disconnecting;
    idInput.disabled = configurationLocked;
    row.querySelector(".motor-steps-input").disabled = configurationLocked;
    row.querySelector(".motor-speed-input").disabled = configurationLocked;
    row.querySelector(".motor-acceleration-input").disabled = configurationLocked;
    row.querySelector(".motor-loop-mode-select").disabled = configurationLocked;
    const forwardButton = row.querySelector(".motor-forward-button");
    const reverseButton = row.querySelector(".motor-reverse-button");
    forwardButton.title = `按当前参数${loopModeLabel(state.drafts[motor.id].closed)}正向转动并记录`;
    reverseButton.title = `按当前参数${loopModeLabel(state.drafts[motor.id].closed)}反向转动并记录`;
    forwardButton.disabled = !state.connected || configurationLocked || nodeId == null || !validDraft;
    reverseButton.disabled = !state.connected || configurationLocked || nodeId == null || !validDraft;

    // STOP and DISABLE remain usable while another operation is awaiting ACK.
    row.querySelector(".motor-stop-button").disabled = !state.connected || state.disconnecting || nodeId == null;
    row.querySelector(".motor-disable-button").disabled = !state.connected || state.disconnecting || nodeId == null;
    const deleteButton = row.querySelector(".motor-delete-button");
    deleteButton.disabled = motorStructureLocked();
    deleteButton.title = state.connected
      ? `请先断开 CAN，再删除 ${motor.label}`
      : `删除 ${motor.label}`;
  }
  $("configuredCount").textContent = String(configured);
  $("motorCount").textContent = String(state.motors.length);
}

function refreshGroupCatalogControls() {
  const root = $("motorRows");
  if (!root) return;
  const groupLocked = groupCatalogEditingLocked();
  for (const input of root.querySelectorAll(".group-name-input")) input.disabled = groupLocked;
  for (const button of root.querySelectorAll(".group-delete-button")) button.disabled = groupLocked;
  for (const button of root.querySelectorAll(".group-add-motor-button")) {
    button.disabled = motorStructureLocked();
    button.title = state.connected
      ? "请先断开 CAN，再向该分组添加电机"
      : "向该分组添加电机";
  }
}

function resolvePendingOriginStatus() {
  if (!state.pendingOriginNodes.size) return;
  const pending = [...state.pendingOriginNodes];
  if (!pending.every(nodeStatusIsFreshAndIdle)) return;
  state.pendingOriginNodes.clear();
  state.originCompletionMessage = "返回补偿已执行完成（本地指令累计为起点）";
  addLog("success", "回起点", state.originCompletionMessage);
}

function renderOrigin() {
  resolvePendingOriginStatus();
  if (state.activePage !== "motor") {
    motorStatusUiDirty = true;
    return;
  }
  const entries = Object.entries(nodePositionSummary()).filter(([, value]) => Number(value) !== 0);
  const total = entries.reduce((sum, [, value]) => sum + Math.abs(Number(value)), 0);
  const returnCommands = state.originReliable ? state.ledger.createReturnCommands() : [];
  const returnNodes = [...new Set(returnCommands.map(({ nodeId }) => nodeId))];
  const pendingNodes = [...state.pendingOriginNodes];
  const busyNodes = returnNodes.filter((nodeId) => !nodeStatusIsFreshAndIdle(nodeId));

  $("originSummary").textContent = !state.originReliable
    ? "当前位置未知，请确认机械安全后重新设置本地起点"
    : pendingNodes.length
      ? `补偿已入队，等待节点 ${pendingNodes.join("、")} 执行完成`
      : entries.length === 0
        ? (state.originCompletionMessage || "所有已跟踪 CAN 节点都在本地参考起点")
        : busyNodes.length
          ? `等待节点 ${busyNodes.join("、")} 的状态更新或 FIFO 清空`
          : `${entries.length} 个 CAN 节点偏离起点，共 ${total} step`;

  $("setOriginButton").disabled = !state.connected || state.disconnecting || state.busy || state.configIoBusy;
  $("returnOriginButton").disabled = !(
    state.connected
    && !state.disconnecting
    && !state.busy
    && !state.configIoBusy
    && state.originReliable
    && entries.length > 0
    && pendingNodes.length === 0
    && busyNodes.length === 0
  );
}

function commandBindingCurrent(command) {
  return hasMotor(command.motorId)
    && bindingNodeId(command.motorId) === command.nodeId;
}

function commandListsMatch(left, right) {
  return left.length === right.length && left.every((command, index) => {
    const candidate = right[index];
    return candidate
      && command.commandId === candidate.commandId
      && command.motorId === candidate.motorId
      && command.nodeId === candidate.nodeId
      && command.signedSteps === candidate.signedSteps
      && command.speed === candidate.speed
      && command.acceleration === candidate.acceleration
      && command.closed === candidate.closed;
  });
}

function renderConnection() {
  const badge = $("connectionBadge");
  badge.className = `connection-badge ${state.connected ? (state.simulate ? "simulate" : "online") : "offline"}`;
  badge.querySelector("span").textContent = state.connected
    ? (state.simulate ? "仿真已连接" : `${state.interfaceName} 已连接`)
    : "未连接";
  $("connectButton").disabled = state.connected || state.connecting || state.disconnecting || state.busy || state.configIoBusy;
  $("connectButton").textContent = state.connecting ? "连接中…" : "连接 CAN";
  $("disconnectButton").disabled = !state.connected || state.disconnecting || state.busy;
  $("disconnectButton").textContent = state.disconnecting ? "断开中…" : "断开";
  $("emergencyButton").disabled = !state.connected || state.disconnecting;
  $("interfaceInput").disabled = state.connected || state.connecting || state.disconnecting || state.busy || state.configIoBusy;
  $("simulateInput").disabled = state.connected || state.connecting || state.disconnecting || state.busy || state.configIoBusy;
  $("exportConfigButton").disabled = state.connecting || state.disconnecting || state.busy || state.configIoBusy;
  $("importConfigButton").disabled = state.connected || state.connecting || state.disconnecting || state.busy || state.configIoBusy;
  $("addGroupButton").disabled = groupCatalogEditingLocked();
  $("addMotorButton").disabled = motorStructureLocked();
  $("addMotorButton").title = state.connected
    ? "请先断开 CAN，再添加电机"
    : "添加时确定电机名称和分组；创建后不可修改";
  refreshMotorRows();
  refreshGroupCatalogControls();
  renderOrigin();
  renderProgram();
  renderTimelineControls();
  window.LumNamedActions.renderControls();
}

function buildDraft(motorId, direction) {
  if (direction !== 1 && direction !== -1) throw new RangeError("方向必须是正向或反向");
  const draft = state.drafts[motorId];
  const magnitude = positiveStepMagnitude(draft.steps);
  return commandModel.validateCommand({
    motorId,
    nodeId: bindingNodeId(motorId),
    signedSteps: direction * magnitude,
    speed: draft.speed,
    acceleration: draft.acceleration,
    closed: draft.closed,
  });
}

function recordMotorCommand(motorId, direction, preparedCommand = null) {
  try {
    const command = state.program.add(preparedCommand || buildDraft(motorId, direction));
    persistState();
    renderProgram();
    return command;
  } catch (error) {
    toast(errorMessage(error), "error");
    return null;
  }
}

function frameText(command, result) {
  const payload = commandModel.toBridgePayload(command);
  const sequence = Number.isInteger(result?.sequence) ? result.sequence : 0;
  const bytes = [
    0xAC | payload.direction,
    payload.count & 0xFF,
    payload.count >> 8 & 0xFF,
    payload.count >> 16 & 0xFF,
    payload.speedLevel,
    sequence,
    payload.accelerationLevel,
    0xC5,
  ];
  const canId = (payload.closed ? 0x280 : 0x200) | payload.nodeId;
  return `0x${canId.toString(16).toUpperCase().padStart(3, "0")}  ${bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ")}`;
}

function formatSigned(value) {
  const number = Number(value);
  return number > 0 ? `+${number}` : String(number);
}

function loopModeLabel(closed) {
  return closed === true ? "闭环" : "开环";
}

function beginOperation(label) {
  if (state.busy || state.configIoBusy || state.connecting || state.disconnecting) return null;
  state.busy = true;
  state.activeOperation = label;
  state.operationEpoch += 1;
  renderConnection();
  return state.operationEpoch;
}

function beginInterruptOperation(label) {
  state.operationEpoch += 1;
  cancelMotionAckWaiters(`${label} 已取消等待中的动作 ACK`);
  state.busy = true;
  state.activeOperation = label;
  renderConnection();
  return state.operationEpoch;
}

function finishOperation(token) {
  if (token !== state.operationEpoch) return;
  state.busy = false;
  state.activeOperation = "";
  renderConnection();
}

function motionAckKey(nodeId, sequence) {
  return `${nodeId}:${sequence}`;
}

function receiveMotionAck(data) {
  const key = motionAckKey(data.nodeId, data.sequence);
  const waiter = state.motionAckWaiters.get(key);
  if (waiter && waiter.connectionEpoch === state.connectionEpoch) {
    clearTimeout(waiter.timer);
    state.motionAckWaiters.delete(key);
    waiter.resolve(data);
    return;
  }
  state.motionAckCache.set(key, {
    data,
    connectionEpoch: state.connectionEpoch,
    expiresAt: Date.now() + MOTION_ACK_TIMEOUT_MS,
  });
}

function waitForMotionAck(nodeId, sequence) {
  const key = motionAckKey(nodeId, sequence);
  const cached = state.motionAckCache.get(key);
  if (cached) state.motionAckCache.delete(key);
  if (
    cached
    && cached.connectionEpoch === state.connectionEpoch
    && cached.expiresAt >= Date.now()
  ) return Promise.resolve(cached.data);

  const connectionEpoch = state.connectionEpoch;
  return new Promise((resolve, reject) => {
    const previous = state.motionAckWaiters.get(key);
    if (previous) {
      clearTimeout(previous.timer);
      previous.reject(new Error(`节点 ${nodeId} 的动作序号 ${sequence} 被重复使用`));
    }
    const timer = setTimeout(() => {
      const current = state.motionAckWaiters.get(key);
      if (current?.timer === timer) state.motionAckWaiters.delete(key);
      reject(new Error(`节点 ${nodeId} 的动作序号 ${sequence} 等待 ACK 超时`));
    }, MOTION_ACK_TIMEOUT_MS);
    state.motionAckWaiters.set(key, { resolve, reject, timer, connectionEpoch });
  });
}

function cancelMotionAckWaiters(reason) {
  const error = new Error(reason);
  for (const waiter of state.motionAckWaiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  state.motionAckWaiters.clear();
  state.motionAckCache.clear();
}

async function transmit(command, source, options = {}) {
  const {
    recordLedger = true,
    render = true,
    operationToken = state.operationEpoch,
    requireTimelineTrackEnabled = false,
  } = options;
  const motor = motorById(command.motorId);
  const payload = commandModel.toBridgePayload(command);
  const trackProgramStats = Boolean(
    command.commandId
    && state.program.snapshot().some(({ commandId }) => commandId === command.commandId),
  );
  if (requireTimelineTrackEnabled && !timelineTrackIsEnabled(command.motorId)) {
    const error = new Error(`${motor?.label || command.motorId} 的时间轨未使能，动作已跳过`);
    addLog("warning", source, error.message, render);
    return { ok: false, error };
  }
  const closedLoopProblem = closedLoopReadinessProblem([command]);
  if (closedLoopProblem) {
    const error = new Error(`${closedLoopProblem}，闭环指令未发送`);
    addLog("error", source, error.message, render);
    return { ok: false, error };
  }
  let motionSent = false;
  try {
    const result = await api.move(payload);
    motionSent = true;
    if (!Number.isInteger(result?.sequence)) throw new Error("桥接层没有返回动作序号");
    const ack = await waitForMotionAck(command.nodeId, result.sequence);
    if (!ack.ok) {
      throw new Error(`节点 ${command.nodeId} 拒绝动作序号 ${result.sequence}：${ack.statusName || `状态 ${ack.status}`}`);
    }
    const interrupted = operationToken !== state.operationEpoch;
    if (recordLedger && !interrupted) {
      state.ledger.recordSuccess(command);
      state.originCompletionMessage = "";
      state.pendingOriginNodes.clear();
    }
    const acceptedAt = Date.now();
    const runtime = state.nodeStatus.get(command.nodeId) || { nodeId: command.nodeId };
    const acknowledgedOutstanding = Number(ack.value);
    runtime.queueOutstanding = Number.isSafeInteger(acknowledgedOutstanding) && acknowledgedOutstanding >= 0
      ? acknowledgedOutstanding
      : Math.max(1, (Number(runtime.queueOutstanding) || 0) + 1);
    runtime.queueActive = runtime.queueOutstanding > 0;
    runtime.moving = true;
    runtime.lastSeenAt = acceptedAt;
    runtime.lastMotionAcceptedAt = acceptedAt;
    runtime.lastStatusAAt = 0;
    runtime.lastStatusDAt = 0;
    if (Number.isInteger(result?.sequence)) runtime.lastAcceptedMotionSequence = result.sequence;
    state.nodeStatus.set(command.nodeId, runtime);
    if (trackProgramStats) {
      const stats = state.programStats.get(command.commandId) || { count: 0, last: "" };
      stats.count += 1;
      stats.last = interrupted ? "已中断" : "成功";
      state.programStats.set(command.commandId, stats);
    }
    addLog(
      interrupted ? "warning" : "success",
      source,
      `${motor?.label || command.motorId} · ${loopModeLabel(command.closed)} · ${formatSigned(command.signedSteps)} step · ${frameText(command, result)}${interrupted ? " · 后续已被停止操作取消" : ""}`,
      render,
    );
    if (render) {
      refreshMotorRows();
      renderOrigin();
      renderProgram();
    }
    return { ok: true, interrupted, result, ack, acceptedAt };
  } catch (error) {
    if (motionSent && operationToken === state.operationEpoch && state.originReliable) {
      invalidateOrigin(`节点 ${command.nodeId} 的动作 ACK 未确认`);
    }
    if (trackProgramStats) {
      const stats = state.programStats.get(command.commandId) || { count: 0, last: "" };
      stats.last = "失败";
      state.programStats.set(command.commandId, stats);
    }
    addLog("error", source, `${motor?.label || command.motorId} · ${loopModeLabel(command.closed)} · ${formatSigned(command.signedSteps)} step · ${errorMessage(error)}`, render);
    if (render) renderProgram();
    return { ok: false, error };
  }
}

function timelineCommand(action) {
  return commandModel.validateCommand({
    motorId: action.motorId,
    nodeId: action.nodeId,
    signedSteps: action.signedSteps,
    speed: action.speed,
    acceleration: action.acceleration,
    closed: action.closed,
  });
}

function timelineRunIsCurrent(run) {
  return state.timelineRun === run
    && run.token === state.operationEpoch
    && state.connected;
}

function namedTimelineRun(run) {
  return run?.surface === "namedAction" || run?.surface === "actionTimeline";
}

function timelineRunSource(run) {
  return run?.sourceLabel || "时间轨";
}

function renderTimelineRunSurface(run) {
  if (namedTimelineRun(run)) window.LumNamedActions.renderPlaybackSurface(run);
  else renderTimeline();
}

function setTimelineRunStatus(run) {
  if (namedTimelineRun(run)) window.LumNamedActions.renderPlaybackStatus(run);
  else $("timelineStatus").textContent = timelineStatusText();
}

function updateTimelineRunCursor(run, elapsed) {
  if (namedTimelineRun(run)) {
    window.LumNamedActions.updatePlaybackCursor(run, elapsed);
    return;
  }
  state.timelineCursorMs = Math.min(run.durationMs, Math.round(elapsed));
  renderTimelineCursor();
  followTimelineCursor();
}

function clearTimelineRunTimer(run) {
  if (run?.timer != null) clearTimeout(run.timer);
  if (run) run.timer = null;
}

function detachTimelineRun() {
  const run = state.timelineRun;
  if (!run) return null;
  clearTimelineRunTimer(run);
  state.timelineRun = null;
  return run;
}

function finishTimelinePlayback(run) {
  if (!timelineRunIsCurrent(run)) return;
  clearTimelineRunTimer(run);
  state.timelineRun = null;
  if (namedTimelineRun(run)) window.LumNamedActions.finishPlayback(run);
  else state.timelineCursorMs = run.durationMs;
  renderLogs();
  refreshMotorRows();
  renderOrigin();
  addLog("success", timelineRunSource(run), `播放完成 · ${run.actionCount} 个电机运动 · ${run.involvedNodes.length} 个物理节点`);
  finishOperation(run.token);
  renderTimelineRunSurface(run);
  toast(`${run.completionLabel || "时间轨播放完成"}：${run.actionCount} 个电机运动`);
}

function timelineGroupQueueIssue(run, group) {
  const neededByNode = new Map();
  for (const { command } of group.items) {
    neededByNode.set(command.nodeId, (neededByNode.get(command.nodeId) || 0) + 1);
  }
  for (const [nodeId, needed] of neededByNode) {
    const runtime = state.nodeStatus.get(nodeId);
    const reportedCapacity = Number(runtime?.queueCapacity);
    const capacity = Number.isSafeInteger(reportedCapacity) && reportedCapacity > 0
      ? reportedCapacity
      : DEFAULT_NODE_QUEUE_CAPACITY;
    const outstanding = Math.max(0, Number(runtime?.queueOutstanding) || 0);
    const reserved = run.reservedByNode.get(nodeId) || 0;
    if (outstanding + reserved + needed > capacity) {
      return { nodeId, outstanding, reserved, needed, capacity };
    }
  }
  return null;
}

function updateTimelineReservations(run, group, delta) {
  for (const { command } of group.items) {
    const next = Math.max(0, (run.reservedByNode.get(command.nodeId) || 0) + delta);
    if (next) run.reservedByNode.set(command.nodeId, next);
    else run.reservedByNode.delete(command.nodeId);
  }
}

function dispatchTimelineGroup(run, group) {
  if (!timelineRunIsCurrent(run) || run.phase !== "playing") return;
  updateTimelineReservations(run, group, 1);
  run.sentCount += group.items.length;
  const dispatch = Promise.all(group.items.map(({ command }) => (
    transmit(command, timelineRunSource(run), {
      operationToken: run.token,
      render: false,
      requireTimelineTrackEnabled: run.requireTimelineTrackEnabled !== false,
    })
  )));
  run.pending.add(dispatch);
  setTimelineRunStatus(run);
  dispatch.then((outcomes) => {
    updateTimelineReservations(run, group, -1);
    run.pending.delete(dispatch);
    if (!timelineRunIsCurrent(run)) return;
    outcomes.forEach((outcome, index) => {
      if (!outcome.ok || outcome.interrupted) return;
      const nodeId = group.items[index].command.nodeId;
      const previous = run.drainFenceByNode.get(nodeId);
      if (previous && previous.startMs > group.startMs) return;
      run.drainFenceByNode.set(nodeId, {
        acceptedAt: Number(outcome.acceptedAt) || Date.now(),
        sequence: Number.isInteger(outcome.result?.sequence) ? outcome.result.sequence : null,
        startMs: group.startMs,
      });
    });
    const failed = outcomes.find((outcome) => !outcome.ok || outcome.interrupted);
    if (failed) void stopTimelinePlayback(`${timelineRunSource(run)}动作发送失败：${errorMessage(failed.error)}`, { automatic: true });
  }).catch((error) => {
    updateTimelineReservations(run, group, -1);
    run.pending.delete(dispatch);
    if (timelineRunIsCurrent(run)) void stopTimelinePlayback(`${timelineRunSource(run)}调度失败：${errorMessage(error)}`, { automatic: true });
  });
}

function timelinePlaybackTick(run) {
  if (!timelineRunIsCurrent(run)) {
    clearTimelineRunTimer(run);
    return;
  }
  const elapsed = Math.max(0, performance.now() - run.startedAt);
  updateTimelineRunCursor(run, elapsed);

  if (
    run.phase === "playing"
    && run.nextGroupIndex < run.groups.length
    && run.groups[run.nextGroupIndex].startMs <= elapsed + 2
  ) {
    const group = run.groups[run.nextGroupIndex];
    const lateness = elapsed - group.startMs;
    if (lateness > TIMELINE_MAX_LATE_MS) {
      void stopTimelinePlayback(
        `界面或系统停顿导致 ${Math.round(lateness)} ms 调度延迟，已取消逾期动作`,
        { automatic: true },
      );
      return;
    }
    const queueIssue = timelineGroupQueueIssue(run, group);
    if (queueIssue) {
      void stopTimelinePlayback(
        `节点 ${queueIssue.nodeId} 的 FIFO 水位 ${queueIssue.outstanding + queueIssue.reserved}/${queueIssue.capacity}，无法按时加入动作`,
        { automatic: true },
      );
      return;
    }
    dispatchTimelineGroup(run, group);
    run.nextGroupIndex += 1;
  }

  if (
    run.phase === "playing"
    && run.nextGroupIndex >= run.groups.length
    && elapsed >= run.durationMs
    && run.pending.size === 0
  ) {
    run.phase = "draining";
    setTimelineRunStatus(run);
    void pollStatuses();
  }

  if (
    run.phase === "draining"
    && run.involvedNodes.every((nodeId) => {
      const fence = run.drainFenceByNode.get(nodeId);
      return Boolean(fence) && nodeStatusIsFreshAndIdle(nodeId, fence.acceptedAt, fence.sequence);
    })
  ) {
    finishTimelinePlayback(run);
    return;
  }

  const nextAt = run.phase === "playing" && run.nextGroupIndex < run.groups.length
    ? run.groups[run.nextGroupIndex].startMs
    : run.durationMs;
  const delayMs = run.phase === "draining"
    ? 100
    : Math.max(8, Math.min(33, nextAt - elapsed));
  run.timer = setTimeout(() => timelinePlaybackTick(run), delayMs);
}

async function playTimeline() {
  if (!state.connected || state.busy || state.configIoBusy || state.disconnecting) return;
  const allActions = state.timeline.snapshot();
  const actions = enabledTimelineActions(allActions);
  if (!actions.length) {
    toast(allActions.length ? "没有已使能的时间轨动作，本次未播放" : "时间轨中还没有动作", "warning");
    return;
  }
  const stale = actions.find((action) => !timelineActionBindingCurrent(action));
  if (stale) {
    toast(`${motorById(stale.motorId).label} 的时间轨动作仍保存旧 ID ${stale.nodeId}，请更新动作`, "error");
    return;
  }
  const conflicts = timelineConflictsForActions(actions);
  if (conflicts.length) {
    const conflict = conflicts[0];
    toast(`${conflict.startMs} ms 的节点 ID ${conflict.nodeId} 有多个动作，物理上不能同时执行`, "error");
    return;
  }
  const revision = state.timeline.revision;
  const enableRevision = state.timelineEnableRevision;
  const groups = groupTimelineActions(actions).map((group) => ({
    startMs: group.startMs,
    items: group.actions.map((action) => ({ action, command: timelineCommand(action) })),
  }));
  const commands = groups.flatMap(({ items }) => items.map(({ command }) => command));
  const preflightEpoch = state.operationEpoch;
  if (!await requireIdleNodes(commands)) return;
  if (
    !state.connected
    || state.busy
    || state.configIoBusy
    || state.disconnecting
    || state.operationEpoch !== preflightEpoch
    || state.timeline.revision !== revision
    || state.timelineEnableRevision !== enableRevision
    || actions.some((action) => !timelineActionBindingCurrent(action))
    || actions.some((action) => !timelineTrackIsEnabled(action.motorId))
  ) {
    toast("预检期间时间轨、ID 或轨道使能状态已变化，本次未播放", "warning");
    return;
  }
  const token = beginOperation("时间轨播放");
  if (token == null) return;
  const run = {
    token,
    revision,
    enableRevision,
    phase: "playing",
    startedAt: null,
    durationMs: state.timelineDurationMs,
    groups,
    nextGroupIndex: 0,
    pending: new Set(),
    reservedByNode: new Map(),
    drainFenceByNode: new Map(),
    timer: null,
    sentCount: 0,
    actionCount: actions.length,
    skippedCount: allActions.length - actions.length,
    involvedNodes: [...new Set(commands.map(({ nodeId }) => nodeId))],
    surface: "motorTimeline",
    sourceLabel: "电机控制时间轴",
    completionLabel: "电机控制时间轴播放完成",
    requireTimelineTrackEnabled: true,
  };
  state.timelineRun = run;
  state.timelineCursorMs = 0;
  $("timelineScroller").scrollLeft = 0;
  addLog(
    "success",
    "时间轨",
    `开始播放 · ${run.actionCount} 个已使能动作${run.skippedCount ? ` · 跳过 ${run.skippedCount} 个` : ""} · 时长 ${formatTimelineTime(run.durationMs)}`,
  );
  renderTimeline();
  run.startedAt = performance.now();
  timelinePlaybackTick(run);
}

function launchNamedTimelineRun(options) {
  const token = beginOperation(options.operationLabel || "动作时间轴播放");
  if (token == null) return null;
  const commands = options.groups.flatMap(({ items }) => items.map(({ command }) => command));
  const run = {
    token,
    phase: "playing",
    startedAt: null,
    durationMs: options.durationMs,
    groups: options.groups,
    nextGroupIndex: 0,
    pending: new Set(),
    reservedByNode: new Map(),
    drainFenceByNode: new Map(),
    timer: null,
    sentCount: 0,
    actionCount: commands.length,
    involvedNodes: [...new Set(commands.map(({ nodeId }) => nodeId))],
    surface: options.surface,
    sourceLabel: options.sourceLabel,
    completionLabel: options.completionLabel,
    requireTimelineTrackEnabled: false,
    placementCount: options.placementCount || 0,
    definitionCount: options.definitionCount || 0,
  };
  state.timelineRun = run;
  window.LumNamedActions.preparePlayback(run);
  addLog(
    "success",
    timelineRunSource(run),
    `开始播放 · ${run.actionCount} 个电机运动 · ${run.involvedNodes.length} 个物理节点 · 时长 ${formatTimelineTime(run.durationMs)}`,
  );
  renderTimelineRunSurface(run);
  run.startedAt = performance.now();
  timelinePlaybackTick(run);
  return run;
}

async function stopTimelinePlayback(reason = "用户停止时间轨播放", options = {}) {
  const run = detachTimelineRun();
  if (!run) return;
  const token = beginInterruptOperation("停止时间轨");
  const connectionEpoch = state.connectionEpoch;
  addLog("warning", timelineRunSource(run), `${reason}；已取消所有尚未下发的动作，正在停止相关节点`);
  let broadcastError = null;
  try {
    await api.stop({ immediate: true, broadcast: true });
  } catch (error) {
    broadcastError = error;
    addLog("error", timelineRunSource(run), `广播 STOP 失败：${errorMessage(error)}`);
  }
  if (token !== state.operationEpoch || connectionEpoch !== state.connectionEpoch || !state.connected) return;
  const stops = await Promise.allSettled(run.involvedNodes.map((nodeId) => (
    api.stop({ nodeId, immediate: true, broadcast: false })
  )));
  if (token !== state.operationEpoch || connectionEpoch !== state.connectionEpoch || !state.connected) return;
  const failedNodes = stops
    .map((result, index) => ({ result, nodeId: run.involvedNodes[index] }))
    .filter(({ result }) => result.status === "rejected")
    .map(({ nodeId }) => nodeId);
  invalidateOrigin(reason);
  renderLogs();
  finishOperation(token);
  renderTimelineRunSurface(run);
  const failed = Boolean(broadcastError) || failedNodes.length > 0;
  const detail = failedNodes.length ? `；节点 ${failedNodes.join("、")} 停止确认失败` : "";
  toast(
    `${options.automatic ? `${timelineRunSource(run)}已保护停止` : `${timelineRunSource(run)}已停止`}${detail}`,
    failed ? "error" : "warning",
  );
}

async function testTimelineAction() {
  if (!state.connected || state.busy || state.configIoBusy || state.disconnecting) return;
  let action;
  try {
    action = timelineDraftFromEditor();
  } catch (error) {
    toast(errorMessage(error), "error");
    return;
  }
  if (!timelineTrackIsEnabled(action.motorId)) {
    toast(`${motorById(action.motorId).label} 的时间轨未使能，测试指令未发送`, "warning");
    return;
  }
  const command = timelineCommand(action);
  const preflightEpoch = state.operationEpoch;
  const enableRevision = state.timelineEnableRevision;
  if (!await requireIdleNodes([command])) return;
  if (
    !state.connected
    || state.busy
    || state.configIoBusy
    || state.disconnecting
    || state.operationEpoch !== preflightEpoch
    || state.timelineEnableRevision !== enableRevision
    || bindingNodeId(action.motorId) !== action.nodeId
    || !timelineTrackIsEnabled(action.motorId)
  ) {
    toast("测试预检期间 ID、轨道使能或连接状态已变化，本次未发送", "warning");
    return;
  }
  const token = beginOperation("测试时间轨动作");
  if (token == null) return;
  const test = {
    token,
    nodeId: command.nodeId,
    motorId: command.motorId,
    phase: "sending",
    acceptedAt: null,
    expectedSequence: null,
  };
  state.timelineTest = test;
  renderTimelineControls();
  const outcome = await transmit(command, "时间轨测试", {
    operationToken: token,
    requireTimelineTrackEnabled: true,
  });
  if (state.timelineTest !== test || token !== state.operationEpoch) return;
  if (!outcome.ok || outcome.interrupted) {
    const failure = errorMessage(outcome.error);
    await stopTimelineTest();
    toast(`测试动作发送失败：${failure}`, "error");
    return;
  }
  test.acceptedAt = Number(outcome.acceptedAt) || Date.now();
  test.expectedSequence = Number.isInteger(outcome.result?.sequence) ? outcome.result.sequence : null;
  test.phase = "draining";
  $("timelineStatus").textContent = "测试指令已接收，等待电机 FIFO 清空；可点击停止测试";
  void pollStatuses();
}

function resolveTimelineTestDrain() {
  const test = state.timelineTest;
  if (
    !test
    || test.phase !== "draining"
    || !nodeStatusIsFreshAndIdle(test.nodeId, test.acceptedAt, test.expectedSequence)
  ) return;
  state.timelineTest = null;
  finishOperation(test.token);
  renderTimeline();
  toast(`${motorById(test.motorId).label} 测试动作执行完成`);
}

async function stopTimelineTest() {
  const test = state.timelineTest;
  if (!test) return;
  state.timelineTest = null;
  const token = beginInterruptOperation("停止时间轨测试");
  const connectionEpoch = state.connectionEpoch;
  let failed = false;
  try {
    await api.stop({ nodeId: test.nodeId, immediate: true, broadcast: false });
  } catch (error) {
    failed = true;
    addLog("error", "时间轨测试", `节点 ${test.nodeId} STOP 失败：${errorMessage(error)}`);
  }
  if (token !== state.operationEpoch || connectionEpoch !== state.connectionEpoch || !state.connected) return;
  invalidateOrigin(`节点 ${test.nodeId} 的时间轨测试已停止`);
  finishOperation(token);
  renderTimeline();
  toast(failed ? `节点 ${test.nodeId} 停止确认失败` : "测试动作已立即停止", failed ? "error" : "warning");
}

async function sendMotor(motorId, direction) {
  if (!state.connected || state.busy || state.disconnecting) return;
  const nodeId = bindingNodeId(motorId);
  const runtime = nodeId == null ? null : state.nodeStatus.get(nodeId);
  if (
    runtime
    && Date.now() - Number(runtime.lastSeenAt) <= STATUS_FRESH_MS
    && Number(runtime.queueOutstanding) >= 64
  ) {
    toast(`节点 ${nodeId} 的 FIFO 已满，请等待当前动作执行`, "warning");
    return;
  }
  const directionLabel = direction === 1 ? "正向" : "反向";
  let preparedCommand;
  try {
    preparedCommand = buildDraft(motorId, direction);
  } catch (error) {
    toast(errorMessage(error), "error");
    return;
  }
  const token = beginOperation(`${directionLabel}发送`);
  if (token == null) return;
  if (!await requireClosedLoopReady([preparedCommand])) {
    finishOperation(token);
    return;
  }
  if (token !== state.operationEpoch || !state.connected) return;
  const command = recordMotorCommand(motorId, direction, preparedCommand);
  if (!command) {
    finishOperation(token);
    return;
  }
  const outcome = await transmit(command, directionLabel, { operationToken: token });
  if (!outcome.ok) {
    state.program.remove(command.commandId);
    state.programStats.delete(command.commandId);
    persistState();
  }
  finishOperation(token);
  if (token !== state.operationEpoch) return;
  toast(outcome.ok ? `${motorById(motorId).label} ${directionLabel}指令已确认接收并记录` : errorMessage(outcome.error), outcome.ok ? "info" : "error");
}

async function sendRecordedCommand(command) {
  if (!state.connected || state.busy) return;
  if (!commandBindingCurrent(command)) {
    toast("该记录保存的节点 ID 已与当前电机绑定不一致，禁止发送", "error");
    return;
  }
  const token = beginOperation("重发记录");
  if (token == null) return;
  if (!await requireClosedLoopReady([command])) {
    finishOperation(token);
    return;
  }
  if (token !== state.operationEpoch || !state.connected) return;
  const outcome = await transmit(command, "重发", { operationToken: token });
  finishOperation(token);
  if (token === state.operationEpoch && !outcome.ok) toast(errorMessage(outcome.error), "error");
}

function moreThanFifoCapacity(commands) {
  const perNode = new Map();
  for (const command of commands) perNode.set(command.nodeId, (perNode.get(command.nodeId) || 0) + 1);
  return [...perNode.entries()].find(([, count]) => count > 64) || null;
}

async function sendAllRecorded() {
  if (!state.connected || state.busy || state.disconnecting) return;
  const commands = state.program.snapshot();
  if (!commands.length) return;
  const stale = commands.find((command) => !commandBindingCurrent(command));
  if (stale) {
    toast(`${motorById(stale.motorId)?.label || stale.motorId} 的记录仍保存旧 ID ${stale.nodeId}，请删除后重新加入`, "error");
    return;
  }
  const overflow = moreThanFifoCapacity(commands);
  if (overflow) {
    toast(`节点 ${overflow[0]} 有 ${overflow[1]} 条记录，超过 MCU 64 条 FIFO 容量`, "error");
    return;
  }
  const preflightEpoch = state.operationEpoch;
  if (!await requireIdleNodes(commands)) return;
  const currentCommands = state.program.snapshot();
  if (
    state.busy
    || !state.connected
    || state.disconnecting
    || state.operationEpoch !== preflightEpoch
    || !commandListsMatch(commands, currentCommands)
    || currentCommands.some((command) => !commandBindingCurrent(command))
  ) {
    toast("预检期间 ID 或指令记录已变化，本次未发送", "warning");
    return;
  }
  const token = beginOperation("批量发送");
  if (token == null) return;
  let accepted = 0;
  for (const command of commands) {
    if (token !== state.operationEpoch) break;
    if (!await refreshClosedLoopReadinessIfStale([command])) break;
    if (token !== state.operationEpoch) break;
    const outcome = await transmit(command, "批量", { operationToken: token, render: false });
    if (!outcome.ok || outcome.interrupted) break;
    accepted += 1;
  }
  renderLogs();
  refreshMotorRows();
  renderOrigin();
  renderProgram();
  finishOperation(token);
  if (token !== state.operationEpoch) return;
  toast(
    accepted === commands.length
      ? `全部 ${accepted} 条指令已确认入队`
      : `已发送 ${accepted} / ${commands.length} 条，遇到失败后已停止`,
    accepted === commands.length ? "info" : "warning",
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requireIdleNodeIds(nodes) {
  const uniqueNodes = [...new Set(nodes.map(Number).filter(Number.isInteger))];
  const requestedAt = Date.now();
  for (let index = 0; index < uniqueNodes.length; index += 16) {
    try {
      await api.statusMany(uniqueNodes.slice(index, index + 16), 0x09);
    } catch (error) {
      toast(`无法确认节点状态：${errorMessage(error)}`, "error");
      return false;
    }
  }
  await delay(150);
  const unavailable = uniqueNodes.filter((nodeId) => !nodeStatusIsFreshAndIdle(nodeId, requestedAt));
  if (unavailable.length) {
    toast(`节点 ${unavailable.join("、")} 尚有动作、故障或未返回完整新状态，请等待并重试`, "warning");
    return false;
  }
  return true;
}

function closedLoopReadinessProblem(commands, minimumSeenAt = Date.now() - STATUS_FRESH_MS) {
  const closedNodes = [...new Set(commands
    .filter(({ closed }) => closed === true)
    .map(({ nodeId }) => Number(nodeId))
    .filter(Number.isInteger))];
  if (!closedNodes.length) return null;
  const noFreshStatus = [];
  const encoderInvalid = [];
  const calibrationInvalid = [];
  for (const nodeId of closedNodes) {
    const runtime = state.nodeStatus.get(nodeId);
    if (!runtime || Number(runtime.lastClosedReadinessAt ?? runtime.lastStatusAAt) < minimumSeenAt) {
      noFreshStatus.push(nodeId);
      continue;
    }
    if (runtime.encoderValid !== true) encoderInvalid.push(nodeId);
    if (runtime.calibrationValid !== true) calibrationInvalid.push(nodeId);
  }
  if (noFreshStatus.length) return `闭环节点 ${noFreshStatus.join("、")} 未返回新的状态 A`;
  if (encoderInvalid.length) return `闭环节点 ${encoderInvalid.join("、")} 的编码器无效`;
  if (calibrationInvalid.length) return `闭环节点 ${calibrationInvalid.join("、")} 尚未完成有效校准`;
  return null;
}

function confirmClosedLoopReady(commands, minimumSeenAt) {
  const problem = closedLoopReadinessProblem(commands, minimumSeenAt);
  if (!problem) return true;
  toast(`${problem}，闭环指令未发送`, "error");
  return false;
}

async function requireClosedLoopReady(commands) {
  const closedNodes = [...new Set(commands
    .filter(({ closed }) => closed === true)
    .map(({ nodeId }) => Number(nodeId))
    .filter(Number.isInteger))];
  if (!closedNodes.length) return true;
  const requestedAt = Date.now();
  for (let index = 0; index < closedNodes.length; index += 16) {
    try {
      await api.statusMany(closedNodes.slice(index, index + 16), 0x01);
    } catch (error) {
      toast(`无法确认闭环节点状态：${errorMessage(error)}`, "error");
      return false;
    }
  }
  await delay(150);
  return confirmClosedLoopReady(commands, requestedAt);
}

async function refreshClosedLoopReadinessIfStale(commands) {
  if (!closedLoopReadinessProblem(commands)) return true;
  return requireClosedLoopReady(commands);
}

async function requireIdleNodes(commands) {
  if (!await requireIdleNodeIds(commands.map(({ nodeId }) => nodeId))) return false;
  return confirmClosedLoopReady(commands, Date.now() - STATUS_FRESH_MS);
}

async function returnToOrigin() {
  if (!state.connected || state.busy || state.disconnecting || !state.originReliable) return;
  const commands = state.ledger.createReturnCommands();
  if (!commands.length) return;
  const overflow = moreThanFifoCapacity(commands);
  if (overflow) {
    toast(`节点 ${overflow[0]} 的返回动作需要 ${overflow[1]} 帧，超过 FIFO 容量`, "error");
    return;
  }
  const preflightEpoch = state.operationEpoch;
  if (!await requireIdleNodes(commands)) return;
  const checkedCommands = state.ledger.createReturnCommands();
  if (
    !state.connected
    || state.disconnecting
    || state.operationEpoch !== preflightEpoch
    || !state.originReliable
    || !commandListsMatch(commands, checkedCommands)
  ) {
    toast("预检期间位置或 ID 已变化，请重新执行返回起点", "warning");
    return;
  }
  const nodeTotal = new Set(commands.map(({ nodeId }) => nodeId)).size;
  const confirmed = await confirmAction(
    "全部返回起点",
    `将向 ${nodeTotal} 个偏离起点的 CAN 节点发送 ${commands.length} 条反向补偿。重复 ID 已按物理节点合并净步数。`,
    "返回起点",
  );
  const confirmedCommands = state.ledger.createReturnCommands();
  if (
    !confirmed
    || state.busy
    || !state.connected
    || state.disconnecting
    || state.operationEpoch !== preflightEpoch
    || !state.originReliable
    || !commandListsMatch(commands, confirmedCommands)
  ) return;
  const token = beginOperation("返回起点");
  if (token == null) return;
  const results = [];
  const acceptedNodes = new Set();
  for (const command of commands) {
    if (token !== state.operationEpoch) break;
    if (!await refreshClosedLoopReadinessIfStale([command])) break;
    if (token !== state.operationEpoch) break;
    const outcome = await transmit(command, "回起点", {
      recordLedger: false,
      render: false,
      operationToken: token,
    });
    results.push(outcome.ok && !outcome.interrupted);
    if (outcome.ok && !outcome.interrupted) acceptedNodes.add(command.nodeId);
    if (!outcome.ok || outcome.interrupted) break;
  }
  while (results.length < commands.length) results.push(false);
  if (token === state.operationEpoch) {
    state.ledger.markReturnResults(commands, results);
    state.pendingOriginNodes = acceptedNodes;
  }
  renderLogs();
  refreshMotorRows();
  renderOrigin();
  finishOperation(token);
  if (token !== state.operationEpoch) return;
  const returned = results.filter(Boolean).length;
  toast(
    returned === commands.length
      ? "全部返回补偿已确认入队，正在等待电机执行完成"
      : `已确认 ${returned} / ${commands.length} 条补偿，失败后已停止`,
    returned === commands.length ? "info" : "warning",
  );
}

function renderProgram() {
  const commands = state.program.snapshot();
  const hasStale = commands.some((command) => !commandBindingCurrent(command));
  $("programCount").textContent = String(commands.length);
  $("sendAllButton").disabled = !(
    state.connected
    && !state.disconnecting
    && !state.busy
    && !state.configIoBusy
    && commands.length
    && !hasStale
  );
  $("clearProgramButton").disabled = state.disconnecting || state.busy || state.configIoBusy || commands.length === 0;
  const root = $("programList");
  root.replaceChildren();
  if (!commands.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有指令记录";
    root.append(empty);
    return;
  }
  commands.forEach((command, index) => {
    const bindingCurrent = commandBindingCurrent(command);
    const row = document.createElement("div");
    row.className = `program-row ${bindingCurrent ? "" : "stale"}`;
    const number = document.createElement("span");
    number.className = "program-index";
    number.textContent = String(index + 1).padStart(2, "0");
    const motorCell = document.createElement("span");
    motorCell.className = "program-motor";
    const name = document.createElement("b");
    name.textContent = motorById(command.motorId)?.label || command.motorId;
    const meta = document.createElement("small");
    const stats = state.programStats.get(command.commandId);
    meta.textContent = bindingCurrent
      ? `ID ${command.nodeId} · ${loopModeLabel(command.closed)}${stats?.count ? ` · 已发 ${stats.count} 次` : ""}${stats?.last === "失败" ? " · 上次失败" : ""}`
      : `旧 ID ${command.nodeId} · ${loopModeLabel(command.closed)} · 当前绑定已变化，禁止发送`;
    motorCell.append(name, meta);
    const steps = document.createElement("span");
    steps.className = "program-steps";
    steps.textContent = formatSigned(command.signedSteps);
    const rate = document.createElement("span");
    rate.className = "program-rate";
    rate.textContent = `${loopModeLabel(command.closed)} · V${command.speed} / A${command.acceleration}`;
    const actions = document.createElement("span");
    actions.className = "row-actions";
    const send = document.createElement("button");
    send.type = "button";
    send.textContent = "重";
    send.title = bindingCurrent ? "重发此条" : "ID 已变化，不能重发";
    send.disabled = !state.connected || state.disconnecting || state.busy || state.configIoBusy || !bindingCurrent;
    send.addEventListener("click", () => void sendRecordedCommand(command));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "×";
    remove.title = "删除记录";
    remove.disabled = state.disconnecting || state.busy || state.configIoBusy;
    remove.addEventListener("click", () => {
      state.program.remove(command.commandId);
      state.programStats.delete(command.commandId);
      persistState();
      renderProgram();
    });
    actions.append(send, remove);
    row.append(number, motorCell, steps, rate, actions);
    root.append(row);
  });
}

function renderLogs() {
  const root = $("sendLog");
  root.replaceChildren();
  if (!state.logs.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "等待发送 CAN 指令…";
    root.append(empty);
    return;
  }
  for (const item of [...state.logs].reverse()) {
    const row = document.createElement("div");
    row.className = `log-row ${item.level}`;
    const time = document.createElement("time");
    time.textContent = new Date(item.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
    const label = document.createElement("b");
    label.textContent = item.level === "error" ? "失败" : item.level === "warning" ? "警告" : item.label;
    const message = document.createElement("span");
    message.textContent = item.message;
    row.append(time, label, message);
    root.append(row);
  }
}

function invalidateOrigin(reason) {
  state.ledger.clear();
  state.originReliable = false;
  state.pendingOriginNodes.clear();
  state.originCompletionMessage = "";
  addLog("warning", "位置", `${reason}；本地起点记录已失效`);
  refreshMotorRows();
  renderOrigin();
}

async function connectCan() {
  if (state.connected || state.connecting || state.disconnecting || state.busy) return;
  const interfaceName = $("interfaceInput").value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(interfaceName)) {
    toast("CAN 接口名不合法", "error");
    return;
  }
  state.interfaceName = interfaceName;
  state.simulate = $("simulateInput").checked;
  state.connecting = true;
  renderConnection();
  try {
    const nodeId = configuredNodeIds()[0] || 1;
    await api.connect({ interface: interfaceName, simulate: state.simulate, nodeId });
    state.connectionEpoch += 1;
    cancelMotionAckWaiters("CAN 会话已切换");
    state.connected = true;
    state.ledger.clear();
    state.originReliable = true;
    state.pendingOriginNodes.clear();
    state.originCompletionMessage = "";
    state.nodeStatus.clear();
    state.motionProfiles.clear();
    state.motionProfileLoading.clear();
    state.motionProfileErrors.clear();
    window.LumNamedActions.motionProfilesChanged();
    addLog("success", "连接", `${state.simulate ? "仿真" : interfaceName} 已连接，当前位置作为本地参考起点`);
    persistState();
    void pollStatuses();
    refreshTimelineMotionProfiles();
    window.LumNamedActions.refreshMotionProfiles();
  } catch (error) {
    toast(errorMessage(error), "error");
    addLog("error", "连接", errorMessage(error));
  } finally {
    state.connecting = false;
    renderConnection();
  }
}

async function disconnectCan() {
  if (!state.connected || state.disconnecting || state.busy) return;
  state.disconnecting = true;
  state.operationEpoch += 1;
  cancelMotionAckWaiters("CAN 正在断开");
  renderConnection();
  try {
    await api.disconnect();
  } catch (error) {
    toast(errorMessage(error), "error");
  } finally {
    state.disconnecting = false;
  }
  state.connectionEpoch += 1;
  state.connected = false;
  state.nodeStatus.clear();
  invalidateOrigin("CAN 已断开");
  renderConnection();
}

async function stopMotor(motorId) {
  const nodeId = bindingNodeId(motorId);
  if (!state.connected || nodeId == null) return;
  if (state.timelineRun) {
    await stopTimelinePlayback(`操作员从 ${motorById(motorId).label} 行停止了时间轨`);
    return;
  }
  if (state.timelineTest) {
    await stopTimelineTest();
    return;
  }
  const token = beginInterruptOperation(`停止 ${motorById(motorId).label}`);
  try {
    await api.stop({ nodeId, immediate: true, broadcast: false });
    invalidateOrigin(`节点 ${nodeId} 已立即停止`);
    toast(`${motorById(motorId).label} 已立即停止；后续批量指令已取消`, "warning");
  } catch (error) {
    toast(errorMessage(error), "error");
    addLog("error", "停止", `${motorById(motorId).label} · ${errorMessage(error)}`);
  } finally {
    finishOperation(token);
  }
}

async function disableMotor(motorId) {
  const nodeId = bindingNodeId(motorId);
  if (!state.connected || nodeId == null) return;
  if (state.timelineRun) {
    await stopTimelinePlayback(`操作员从 ${motorById(motorId).label} 行停止了时间轨`);
    try {
      await api.disable({ nodeId, broadcast: false });
    } catch (error) {
      toast(`${motorById(motorId).label} 失能失败：${errorMessage(error)}`, "error");
    }
    return;
  }
  if (state.timelineTest) await stopTimelineTest();
  const token = beginInterruptOperation(`失能 ${motorById(motorId).label}`);
  try {
    await api.disable({ nodeId, broadcast: false });
    invalidateOrigin(`节点 ${nodeId} 已失能`);
    toast(`${motorById(motorId).label} 已失能；后续批量指令已取消`, "warning");
  } catch (error) {
    toast(errorMessage(error), "error");
    addLog("error", "失能", `${motorById(motorId).label} · ${errorMessage(error)}`);
  } finally {
    finishOperation(token);
  }
}

async function emergencyStop() {
  if (!state.connected || state.disconnecting) return;
  detachTimelineRun();
  state.timelineTest = null;
  const token = beginInterruptOperation("全总线急停");
  const connectionEpoch = state.connectionEpoch;
  addLog("warning", "急停", "已取消所有尚未发送的批量指令，正在广播 STOP + DISABLE");
  try {
    await api.stop({ immediate: true, broadcast: true });
  } catch (error) {
    addLog("error", "急停", `STOP 广播失败：${errorMessage(error)}`);
  }
  if (token !== state.operationEpoch || connectionEpoch !== state.connectionEpoch || !state.connected) return;
  try {
    await api.disable({ broadcast: true });
  } catch (error) {
    addLog("error", "急停", `DISABLE 广播失败：${errorMessage(error)}`);
  }
  if (token !== state.operationEpoch || connectionEpoch !== state.connectionEpoch || !state.connected) return;
  invalidateOrigin("已执行全总线急停");
  finishOperation(token);
  toast("全总线 STOP + DISABLE 已广播", "error");
}

async function pollStatuses() {
  const timelineOwnsBusyState = Boolean(state.timelineRun || state.timelineTest);
  if (!state.connected || (state.busy && !timelineOwnsBusyState) || state.statusPolling) return;
  state.statusPolling = true;
  try {
    const nodes = configuredNodeIds();
    for (let index = 0; index < nodes.length; index += 16) {
      if (!state.connected) break;
      try {
        await api.statusMany(nodes.slice(index, index + 16), 0x09);
      } catch (_) {
        // Status is diagnostic only and must not interrupt command entry.
      }
    }
  } finally {
    state.statusPolling = false;
  }
}

function hasFault(faultFlags) {
  if (typeof faultFlags === "number") return faultFlags !== 0;
  if (Array.isArray(faultFlags)) return faultFlags.length > 0;
  if (faultFlags && typeof faultFlags === "object") return Object.values(faultFlags).some(Boolean);
  return Boolean(faultFlags);
}

function handleDriverEvent(message) {
  const event = message?.event;
  const data = message?.data || {};
  if (
    event === "ack"
    && Number.isInteger(data.nodeId)
    && (data.commandClass === 1 || data.commandClass === 2)
  ) {
    receiveMotionAck(data);
    const runtime = state.nodeStatus.get(data.nodeId) || { nodeId: data.nodeId };
    runtime.lastMotionAckAt = Date.now();
    runtime.lastMotionAckSequence = data.sequence;
    if (data.ok && Number.isSafeInteger(Number(data.value)) && Number(data.value) >= 0) {
      runtime.queueOutstanding = Number(data.value);
      runtime.queueActive = Number(data.value) > 0;
    }
    state.nodeStatus.set(data.nodeId, runtime);
    if (!data.ok) {
      const reason = `节点 ${data.nodeId} 拒绝动作序号 ${data.sequence}：${data.statusName || `状态 ${data.status}`}`;
      addLog("error", "电机 ACK", reason);
      if (state.timelineRun?.involvedNodes.includes(data.nodeId)) {
        void stopTimelinePlayback(reason, { automatic: true });
      } else if (state.timelineTest?.nodeId === data.nodeId) {
        void stopTimelineTest();
      } else if (state.originReliable) {
        invalidateOrigin(reason);
      }
    }
    resolvePendingOriginStatus();
    scheduleMotorStatusUiRefresh();
  } else if (event === "status" && Number.isInteger(data.nodeId)) {
    const runtime = state.nodeStatus.get(data.nodeId) || { nodeId: data.nodeId };
    const seenAt = Date.now();
    Object.assign(runtime, data, { lastSeenAt: seenAt });
    if (data.part === "A") {
      runtime.lastStatusAAt = seenAt;
      runtime.lastClosedReadinessAt = seenAt;
    }
    if (data.part === "D") runtime.lastStatusDAt = seenAt;
    state.nodeStatus.set(data.nodeId, runtime);
    if (data.part === "A" && hasFault(data.faultFlags)) {
      if (state.timelineRun) {
        void stopTimelinePlayback(`节点 ${data.nodeId} 报告故障`, { automatic: true });
      } else if (state.timelineTest) {
        void stopTimelineTest();
      } else if (state.originReliable) {
        invalidateOrigin(`节点 ${data.nodeId} 报告故障`);
      }
    }
    resolvePendingOriginStatus();
    resolveTimelineTestDrain();
    scheduleMotorStatusUiRefresh();
  } else if (event === "connection" && data.connected === false && state.connected) {
    detachTimelineRun();
    state.timelineTest = null;
    state.operationEpoch += 1;
    state.connectionEpoch += 1;
    cancelMotionAckWaiters("CAN 连接已中断");
    state.busy = false;
    state.activeOperation = "";
    state.connected = false;
    state.nodeStatus.clear();
    if (!state.disconnecting) {
      invalidateOrigin("CAN 连接异常中断");
      toast("CAN 连接已中断", "error");
    }
    renderConnection();
  } else if (event === "error") {
    addLog("error", "桥接", data.message || "CAN 桥接错误");
    if (state.timelineRun) void stopTimelinePlayback("CAN 桥接报告错误", { automatic: true });
    else if (state.timelineTest) void stopTimelineTest();
  }
}

function resetInvalidIdInput(input, motorId, message) {
  input.value = bindingNodeId(motorId) ?? "";
  input.classList.add("invalid");
  toast(message, "error");
  setTimeout(() => input.classList.remove("invalid"), 1_500);
}

function commitInlineNodeId(motorId, input) {
  const raw = input.value.trim();
  const previousNodeId = bindingNodeId(motorId);
  const nodeId = raw === "" ? null : Number(raw);
  if (nodeId != null && (!Number.isInteger(nodeId) || nodeId < 1 || nodeId > 127)) {
    resetInvalidIdInput(input, motorId, "节点 ID 必须是 1–127 的整数");
    return;
  }
  input.classList.remove("invalid");
  if (nodeId === previousNodeId) return;

  state.bindings[motorId] = { ...registry.defaultBinding(motorId), nodeId };
  state.nodeStatus.clear();
  if (state.connected && state.originReliable) invalidateOrigin(`${motorById(motorId).label} 的节点 ID 已修改`);
  const saved = persistState(true);
  refreshMotorRows();
  renderProgram();
  renderTimeline();
  const message = `${motorById(motorId).label} ${nodeId == null ? "已取消 ID 绑定" : `已绑定节点 ID ${nodeId}`}`;
  toast(saved ? `${message}，已保存` : `${message}，但本机保存失败`, saved ? "info" : "error");
  if (state.connected) void pollStatuses();
  if (state.connected && nodeId != null) void ensureMotionProfile(nodeId);
}

function updateDraftFromInput(motorId, input) {
  const draft = state.drafts[motorId];
  if (input.classList.contains("motor-steps-input")) draft.steps = input.value;
  if (input.classList.contains("motor-speed-input")) draft.speed = input.value;
  if (input.classList.contains("motor-acceleration-input")) draft.acceleration = input.value;
  if (input.classList.contains("motor-loop-mode-select")) draft.closed = input.value === "closed";
  persistState();
  refreshMotorRows();
}

function handleMotorBoardInput(event) {
  const input = event.target.closest(".motor-steps-input, .motor-speed-input, .motor-acceleration-input");
  const row = input?.closest(".motor-control-row");
  if (!input || !row) return;
  updateDraftFromInput(row.dataset.motorId, input);
}

function handleMotorBoardChange(event) {
  const groupInput = event.target.closest(".group-name-input");
  if (groupInput) {
    const section = groupInput.closest(".motor-group");
    if (section) commitGroupName(section.dataset.groupId, groupInput);
    return;
  }
  const input = event.target.closest(".motor-id-input, .motor-loop-mode-select");
  const row = input?.closest(".motor-control-row");
  if (!input || !row) return;
  if (input.classList.contains("motor-loop-mode-select")) {
    updateDraftFromInput(row.dataset.motorId, input);
  } else {
    commitInlineNodeId(row.dataset.motorId, input);
  }
}

function handleMotorBoardKeydown(event) {
  const input = event.target.closest(".group-name-input");
  if (!input) return;
  if (event.key === "Enter") {
    event.preventDefault();
    input.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    const groupId = input.closest(".motor-group")?.dataset.groupId;
    input.value = groupById(groupId)?.label || input.dataset.previousLabel || "";
    input.blur();
  }
}

function handleMotorBoardClick(event) {
  const button = event.target.closest("button");
  const section = button?.closest(".motor-group");
  if (button?.classList.contains("group-add-motor-button") && section) {
    const groupId = section.dataset.groupId;
    void addMotor(groupId);
    return;
  }
  if (button?.classList.contains("group-delete-button") && section) {
    void deleteGroup(section.dataset.groupId);
    return;
  }
  const row = button?.closest(".motor-control-row");
  if (!button || !row) return;
  const motorId = row.dataset.motorId;
  if (button.classList.contains("motor-forward-button")) void sendMotor(motorId, 1);
  if (button.classList.contains("motor-reverse-button")) void sendMotor(motorId, -1);
  if (button.classList.contains("motor-stop-button")) void stopMotor(motorId);
  if (button.classList.contains("motor-disable-button")) void disableMotor(motorId);
  if (button.classList.contains("motor-delete-button")) void deleteMotor(motorId);
}

async function setCurrentAsOrigin() {
  if (!state.connected || state.busy || state.disconnecting) return;
  const preflightEpoch = state.operationEpoch;
  if (!await requireIdleNodeIds(configuredNodeIds())) return;
  const confirmed = await confirmAction(
    "重新设置本地起点",
    "这不会移动电机，只会在确认所有已配置节点 FIFO 为空后，把当前物理位置定义为新的本地参考起点。",
    "设为起点",
  );
  if (
    !confirmed
    || state.busy
    || !state.connected
    || state.disconnecting
    || state.operationEpoch !== preflightEpoch
  ) return;
  state.ledger.clear();
  state.originReliable = true;
  state.pendingOriginNodes.clear();
  state.originCompletionMessage = "当前位置已设为新的本地参考起点";
  addLog("warning", "起点", state.originCompletionMessage);
  refreshMotorRows();
  renderOrigin();
  toast("当前位置已设为本地参考起点");
}

function updateTimelineDuration() {
  const seconds = Number($("timelineDurationInput").value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > timelineModel.MAX_START_MS / 1_000) {
    $("timelineDurationInput").value = String(state.timelineDurationMs / 1_000);
    toast("时间轨时长必须是 1–600 秒的整数", "error");
    return;
  }
  const nextDuration = seconds * 1_000;
  const latestActionMs = state.timeline.snapshot().reduce((latest, action) => Math.max(latest, action.startMs), 0);
  if (nextDuration < latestActionMs) {
    $("timelineDurationInput").value = String(state.timelineDurationMs / 1_000);
    toast(`时间轨中已有 ${latestActionMs} ms 的动作，时长不能再缩短`, "error");
    return;
  }
  state.timelineDurationMs = nextDuration;
  state.timelineCursorMs = Math.min(state.timelineCursorMs, nextDuration);
  persistState();
  renderTimeline();
}

function handlePageTabKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const currentIndex = Math.max(0, PAGE_DEFINITIONS.findIndex(({ tabId }) => tabId === event.currentTarget.id));
  let nextIndex = currentIndex;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = PAGE_DEFINITIONS.length - 1;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + PAGE_DEFINITIONS.length) % PAGE_DEFINITIONS.length;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % PAGE_DEFINITIONS.length;
  const next = PAGE_DEFINITIONS[nextIndex];
  switchPage(next.id);
  if (state.activePage === next.id) $(next.tabId).focus();
}

function initEvents() {
  $("exportConfigButton").addEventListener("click", () => void exportConfiguration());
  $("importConfigButton").addEventListener("click", () => void importConfiguration());
  $("addGroupButton").addEventListener("click", addGroup);
  $("addMotorButton").addEventListener("click", () => void addMotor());
  $("connectionForm").addEventListener("submit", (event) => { event.preventDefault(); void connectCan(); });
  $("disconnectButton").addEventListener("click", () => void disconnectCan());
  $("emergencyButton").addEventListener("click", () => void emergencyStop());
  $("motorRows").addEventListener("input", handleMotorBoardInput);
  $("motorRows").addEventListener("change", handleMotorBoardChange);
  $("motorRows").addEventListener("keydown", handleMotorBoardKeydown);
  $("motorRows").addEventListener("click", handleMotorBoardClick);
  $("sendAllButton").addEventListener("click", () => void sendAllRecorded());
  $("clearProgramButton").addEventListener("click", () => {
    const removed = state.program.clear();
    state.programStats.clear();
    persistState();
    renderProgram();
    if (removed) toast(`已清空 ${removed} 条指令记录`);
  });
  $("clearLogButton").addEventListener("click", () => { state.logs = []; renderLogs(); });
  $("returnOriginButton").addEventListener("click", () => void returnToOrigin());
  $("setOriginButton").addEventListener("click", () => void setCurrentAsOrigin());
  $("interfaceInput").addEventListener("change", () => { state.interfaceName = $("interfaceInput").value.trim(); persistState(); });
  $("simulateInput").addEventListener("change", () => { state.simulate = $("simulateInput").checked; persistState(); });
  $("motorControlTab").addEventListener("click", () => switchPage("motor"));
  $("timelineEditorTab").addEventListener("click", () => switchPage("timeline"));
  $("namedActionEditorTab").addEventListener("click", () => switchPage("namedAction"));
  $("actionTimelineTab").addEventListener("click", () => switchPage("actionTimeline"));
  for (const { tabId } of PAGE_DEFINITIONS) $(tabId).addEventListener("keydown", handlePageTabKeydown);
  $("timelineSaveProjectButton").addEventListener("click", saveTimelineProject);
  $("timelineImportProjectButton").addEventListener("click", () => void importTimelineProject());
  $("timelineExportProjectButton").addEventListener("click", () => void exportTimelineProject());
  $("timelinePlaceAfterButton").addEventListener("click", placeTimelineActionAfterNode);
  $("timelineDirectionButtons").addEventListener("click", (event) => {
    const button = event.target.closest(".timeline-direction-button");
    if (!button || state.busy) return;
    setTimelineDirection(Number(button.dataset.direction));
    renderTimelineControls();
  });
  $("timelineActionForm").addEventListener("submit", (event) => { event.preventDefault(); saveTimelineAction(false); });
  $("timelineActionForm").addEventListener("input", () => renderTimelineControls());
  $("timelineLoopModeSelect").addEventListener("change", () => renderTimelineControls());
  $("timelineTestButton").addEventListener("click", () => void testTimelineAction());
  $("timelineStopTestButton").addEventListener("click", () => void stopTimelineTest());
  $("timelineUpdateActionButton").addEventListener("click", () => saveTimelineAction(true));
  $("timelineDeleteActionButton").addEventListener("click", deleteSelectedTimelineAction);
  $("timelinePlayButton").addEventListener("click", () => void playTimeline());
  $("timelineStopButton").addEventListener("click", () => void stopTimelinePlayback());
  $("timelineClearButton").addEventListener("click", clearTimeline);
  $("timelineDurationInput").addEventListener("change", updateTimelineDuration);
  $("timelineSnapSelect").addEventListener("change", () => {
    const snapMs = Number($("timelineSnapSelect").value);
    if (!TIMELINE_SNAP_OPTIONS.has(snapMs)) return;
    state.timelineSnapMs = snapMs;
    persistState();
    renderTimelineControls();
  });
  $("timelineZoomInput").addEventListener("input", () => {
    const pixelsPerSecond = Number($("timelineZoomInput").value);
    if (!Number.isSafeInteger(pixelsPerSecond) || pixelsPerSecond < 50 || pixelsPerSecond > 240) return;
    state.timelinePixelsPerSecond = pixelsPerSecond;
    persistState();
    renderTimeline();
  });
  $("timelineRuler").addEventListener("pointerdown", beginTimelineCursorDrag);
  $("timelinePlayheadHandle").addEventListener("pointerdown", beginTimelineCursorDrag);
  $("timelineRuler").addEventListener("pointermove", moveTimelineCursorDrag);
  $("timelineRuler").addEventListener("pointerup", (event) => finishTimelineCursorDrag(event));
  $("timelineRuler").addEventListener("pointercancel", (event) => finishTimelineCursorDrag(event, true));
  $("timelineRuler").addEventListener("lostpointercapture", (event) => finishTimelineCursorDrag(event, true));
  $("timelineRuler").addEventListener("keydown", moveTimelineCursorWithKeyboard);
  $("timelineTracks").addEventListener("change", handleTimelineTrackEnableChange);
  $("timelineTracks").addEventListener("pointerdown", beginTimelineDrag);
  $("timelineTracks").addEventListener("click", handleTimelineTrackSelection);
  $("timelineTracks").addEventListener("click", selectTimelineClip);
  $("timelineTracks").addEventListener("pointermove", moveTimelineDrag);
  $("timelineTracks").addEventListener("pointerup", (event) => finishTimelineDrag(event));
  $("timelineTracks").addEventListener("pointercancel", (event) => finishTimelineDrag(event, true));
  $("timelineTracks").addEventListener("lostpointercapture", (event) => finishTimelineDrag(event, true));
  $("timelineScroller").addEventListener("keydown", (event) => {
    if ((event.key === "Delete" || event.key === "Backspace") && selectedTimelineAction() && !timelineInteractionLocked()) {
      event.preventDefault();
      deleteSelectedTimelineAction();
    }
  });
  window.addEventListener("blur", () => {
    const cursorDrag = state.timelineCursorDrag;
    if (cursorDrag) finishTimelineCursorDrag({ pointerId: cursorDrag.pointerId }, true);
    const drag = state.timelineDrag;
    if (drag) finishTimelineDrag({ pointerId: drag.pointerId }, true);
    window.LumNamedActions.cancelInteractions();
  });
  window.addEventListener("beforeunload", () => {
    persistState(true);
  });
  window.LumNamedActions.initEvents();
}

function initialize() {
  loadStoredState();
  $("interfaceInput").value = state.interfaceName;
  $("simulateInput").checked = state.simulate;
  buildMotorRows();
  resetTimelineEditor({ keepMotor: false });
  renderTimeline();
  window.LumNamedActions.initialize();
  persistState(true);
  if (state.localRecoveryCreated) {
    setSaveStatus("error", "检测到损坏配置，原始副本已保留");
    addLog("warning", "恢复", "本机配置有损坏项，已加载可恢复电机并保留原始恢复副本", false);
    toast("检测到损坏的本机配置；已保留恢复副本并尽量恢复有效电机", "warning");
  }
  initEvents();
  api.onDriverEvent(handleDriverEvent);
  renderConnection();
  renderProgram();
  renderLogs();
  setInterval(() => void pollStatuses(), 1_500);
}

initialize();
