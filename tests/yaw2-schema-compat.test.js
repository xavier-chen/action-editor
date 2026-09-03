"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const registry = require("../src/motor-registry");
const commandModel = require("../src/command-ledger");
const timelineModel = require("../src/timeline-model");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "renderer", "app.js"), "utf8");

const NEW_MOTOR_ID = "head_yaw_2";
const LEGACY_MOTOR_IDS = Object.freeze([
  "left_brow_outer",
  "left_brow_inner",
  "right_brow_inner",
  "right_brow_outer",
  "left_upper_eyelid",
  "left_lower_eyelid",
  "left_eye_horizontal",
  "left_eye_vertical",
  "right_upper_eyelid",
  "right_lower_eyelid",
  "right_eye_horizontal",
  "right_eye_vertical",
  "left_mouth_corner_a",
  "left_mouth_corner_b",
  "right_mouth_corner_a",
  "right_mouth_corner_b",
  "upper_lip_left",
  "upper_lip_right",
  "lower_lip_left",
  "lower_lip_right",
  "lower_jaw",
  "head_left_linkage",
  "head_right_linkage",
  "head_yaw",
  "neck",
]);

function rendererNormalizers() {
  const source = app.replace(
    /\ninitialize\(\);\s*$/,
    `
globalThis.__rendererTestApi = {
  configSchemaVersion: CONFIG_SCHEMA_VERSION,
  timelineSchemaVersion: TIMELINE_FILE_SCHEMA_VERSION,
  normalizeImportedConfiguration,
  normalizeImportedTimeline,
  state,
};
`,
  );
  assert.notEqual(source, app, "renderer test harness must suppress initialize()");
  const context = vm.createContext({
    window: { motorTerminal: {} },
    document: { getElementById() { return null; } },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  const registrySource = fs.readFileSync(path.join(root, "src", "motor-registry.js"), "utf8");
  vm.runInContext(registrySource, context, { filename: path.join(root, "src", "motor-registry.js") });
  context.window.FaceMotorRegistry = context.FaceMotorRegistry;
  context.window.FaceCommandLedger = commandModel;
  context.window.FaceTimelineModel = timelineModel;
  vm.runInContext(source, context, { filename: path.join(root, "renderer", "app.js") });
  return context.__rendererTestApi;
}

const normalizers = rendererNormalizers();

function motorEntry(motorId, index = 0) {
  const motor = registry.motorsById[motorId];
  return {
    motorId,
    label: motor?.label || motorId,
    nodeId: index < 2 ? 17 : ((index % 127) + 1),
    steps: 1_000 + index,
    speed: 20,
    acceleration: 30,
  };
}

function configurationDocument(schemaVersion, motorIds, options = {}) {
  const groups = options.groups || registry.DEFAULT_GROUPS;
  return {
    format: "face-robot-can-motor-config",
    schemaVersion,
    exportedAt: "2026-08-28T00:00:00.000Z",
    interfaceName: "can0",
    simulate: false,
    ...(schemaVersion >= 4 ? {
      groupCount: groups.length,
      groups: groups.map(({ id, label }) => ({ groupId: id, label })),
    } : {}),
    motorCount: motorIds.length,
    motors: motorIds.map((motorId, index) => ({
      ...motorEntry(motorId, index),
      ...(schemaVersion >= 3 ? {
        group: options.motorGroups?.[motorId]
          || registry.motorsById[motorId]?.group
          || registry.CUSTOM_GROUP_ID,
      } : {}),
      ...(schemaVersion === 5 ? {
        closed: options.closedByMotor?.[motorId] ?? false,
      } : {}),
    })),
  };
}

function action(motorId = "head_yaw", closed) {
  return {
    motorId,
    nodeId: 17,
    startMs: 500,
    signedSteps: 1_000,
    speed: 20,
    acceleration: 30,
    ...(closed === undefined ? {} : { closed }),
  };
}

function timelineDocument(schemaVersion, motorIds, options = {}) {
  const trackEnabled = options.omitTrackEnabled
    ? undefined
    : Object.fromEntries(motorIds.map((motorId) => [motorId, motorId === "head_yaw"]));
  const timeline = {
    durationMs: 10_000,
    snapMs: 100,
    pixelsPerSecond: 120,
    actions: (options.actions || [action()]).map((entry) => (
      schemaVersion === 4 && entry.closed === undefined
        ? { ...entry, closed: false }
        : entry
    )),
  };
  if (!options.omitTrackEnabled) timeline.trackEnabled = trackEnabled;
  return {
    format: "face-robot-timeline-animation",
    schemaVersion,
    exportedAt: "2026-08-28T00:00:00.000Z",
    motorCount: motorIds.length,
    ...(schemaVersion >= 3 ? {
      motors: motorIds.map((motorId) => ({
        motorId,
        label: registry.motorsById[motorId]?.label || motorId,
      })),
    } : {}),
    timeline,
  };
}

test("configuration and animation schemas advance for canonical loop mode", () => {
  assert.equal(registry.MOTOR_IDS.length, 26);
  assert.equal(normalizers.configSchemaVersion, 5);
  assert.equal(normalizers.timelineSchemaVersion, 4);
});

test("schema-1 configuration imports the exact legacy 25 axes and defaults yaw 2", () => {
  const imported = normalizers.normalizeImportedConfiguration(
    JSON.stringify(configurationDocument(1, LEGACY_MOTOR_IDS)),
  );

  assert.equal(imported.bindings.head_yaw.nodeId, LEGACY_MOTOR_IDS.indexOf("head_yaw") + 1);
  assert.equal(imported.bindings.head_yaw_2.motorId, NEW_MOTOR_ID);
  assert.equal(imported.bindings.head_yaw_2.nodeId, null);
  assert.equal(imported.drafts.head_yaw_2.steps, "1000");
  assert.equal(imported.drafts.head_yaw_2.speed, "20");
  assert.equal(imported.drafts.head_yaw_2.acceleration, "20");
  assert.equal(imported.drafts.head_yaw_2.closed, false);
  assert.ok(registry.MOTOR_IDS.every((motorId) => imported.drafts[motorId].closed === false));
  assert.equal(imported.bindings.left_brow_outer.nodeId, 17);
  assert.equal(imported.bindings.left_brow_inner.nodeId, 17, "repeated CAN IDs remain valid");

  const wrongLegacySet = [...LEGACY_MOTOR_IDS.slice(1), NEW_MOTOR_ID];
  assert.equal(wrongLegacySet.length, 25);
  assert.throws(() => normalizers.normalizeImportedConfiguration(
    JSON.stringify(configurationDocument(1, wrongLegacySet)),
  ));
});

test("schema-2 configuration strictly requires all 26 axes including yaw 2", () => {
  const current = configurationDocument(2, registry.MOTOR_IDS);
  const yaw2 = current.motors.find(({ motorId }) => motorId === NEW_MOTOR_ID);
  yaw2.nodeId = 77;
  yaw2.steps = 2_222;
  yaw2.speed = 44;
  yaw2.acceleration = 55;
  const imported = normalizers.normalizeImportedConfiguration(JSON.stringify(current));
  assert.equal(imported.bindings.head_yaw_2.nodeId, 77);
  assert.equal(imported.drafts.head_yaw_2.steps, "2222");
  assert.equal(imported.drafts.head_yaw_2.speed, "44");
  assert.equal(imported.drafts.head_yaw_2.acceleration, "55");
  assert.ok(registry.MOTOR_IDS.every((motorId) => imported.drafts[motorId].closed === false));

  assert.throws(() => normalizers.normalizeImportedConfiguration(
    JSON.stringify(configurationDocument(2, LEGACY_MOTOR_IDS)),
  ));
  assert.throws(() => normalizers.normalizeImportedConfiguration(
    JSON.stringify(configurationDocument(1, registry.MOTOR_IDS)),
  ));
});

test("schema-1 animation preserves actions and defaults the missing yaw-2 track off", () => {
  const imported = normalizers.normalizeImportedTimeline(
    JSON.stringify(timelineDocument(1, LEGACY_MOTOR_IDS)),
  );
  assert.equal(imported.trackEnabled.head_yaw, true);
  assert.equal(imported.trackEnabled.head_yaw_2, false);
  assert.equal(imported.program.size, 1);
  assert.equal(imported.program.snapshot()[0].motorId, "head_yaw");
  assert.equal(imported.program.snapshot()[0].closed, false);

  const withoutFlags = normalizers.normalizeImportedTimeline(JSON.stringify(
    timelineDocument(1, LEGACY_MOTOR_IDS, { omitTrackEnabled: true }),
  ));
  assert.ok(registry.MOTOR_IDS.every((motorId) => withoutFlags.trackEnabled[motorId] === false));
});

test("animation schemas enforce their own complete motor and track sets", () => {
  const current = timelineDocument(2, registry.MOTOR_IDS, { actions: [action(NEW_MOTOR_ID)] });
  current.timeline.trackEnabled.head_yaw_2 = true;
  const imported = normalizers.normalizeImportedTimeline(JSON.stringify(current));
  assert.equal(imported.trackEnabled.head_yaw_2, true);
  assert.equal(imported.program.snapshot()[0].motorId, NEW_MOTOR_ID);
  assert.equal(imported.program.snapshot()[0].closed, false);

  const missingCurrentFlag = timelineDocument(2, registry.MOTOR_IDS);
  delete missingCurrentFlag.timeline.trackEnabled.head_yaw_2;
  assert.throws(() => normalizers.normalizeImportedTimeline(JSON.stringify(missingCurrentFlag)));

  const legacyWithNewAction = timelineDocument(1, LEGACY_MOTOR_IDS, {
    actions: [action(NEW_MOTOR_ID)],
  });
  assert.throws(() => normalizers.normalizeImportedTimeline(JSON.stringify(legacyWithNewAction)));

  const legacyWithNewFlag = timelineDocument(1, LEGACY_MOTOR_IDS);
  legacyWithNewFlag.timeline.trackEnabled.head_yaw_2 = false;
  assert.throws(() => normalizers.normalizeImportedTimeline(JSON.stringify(legacyWithNewFlag)));

  assert.throws(() => normalizers.normalizeImportedTimeline(
    JSON.stringify(timelineDocument(2, LEGACY_MOTOR_IDS)),
  ));
  assert.throws(() => normalizers.normalizeImportedTimeline(
    JSON.stringify(timelineDocument(1, registry.MOTOR_IDS)),
  ));
});

test("schema-3 configuration accepts a dynamic catalog, preserves order, and allows repeated CAN IDs", () => {
  const ids = ["custom_motor_41", "custom_motor_42"];
  const document = configurationDocument(3, ids);
  document.motors[0].label = "左辅助电机";
  document.motors[1].label = "右辅助电机";
  document.motors[0].nodeId = 77;
  document.motors[1].nodeId = 77;

  const imported = normalizers.normalizeImportedConfiguration(JSON.stringify(document));
  assert.deepEqual(
    Array.from(imported.motors, ({ id, label }) => ({ id, label })),
    [
      { id: ids[0], label: "左辅助电机" },
      { id: ids[1], label: "右辅助电机" },
    ],
  );
  assert.equal(imported.bindings[ids[0]].nodeId, 77);
  assert.equal(imported.bindings[ids[1]].nodeId, 77);
  assert.ok(ids.every((motorId) => imported.drafts[motorId].closed === false));
});

test("schema-3 configuration rejects duplicate stable IDs and normalized duplicate names", () => {
  const duplicateId = configurationDocument(3, ["custom_motor_51", "custom_motor_52"]);
  duplicateId.motors[1].motorId = duplicateId.motors[0].motorId;
  assert.throws(
    () => normalizers.normalizeImportedConfiguration(JSON.stringify(duplicateId)),
    /重复/,
  );

  const duplicateName = configurationDocument(3, ["custom_motor_53", "custom_motor_54"]);
  duplicateName.motors[0].label = "嘴角辅助";
  duplicateName.motors[1].label = "嘴角辅助";
  assert.throws(
    () => normalizers.normalizeImportedConfiguration(JSON.stringify(duplicateName)),
    /名称重复/,
  );
});

test("schema-4 configuration round-trips dynamic groups, membership, order, and repeated CAN IDs", () => {
  const groups = [
    { id: registry.CUSTOM_GROUP_ID, label: "未分组" },
    { id: "custom_group_7", label: "眨眼联动" },
    { id: "custom_group_8", label: "嘴部联动" },
  ];
  const ids = ["custom_motor_71", "custom_motor_72", "custom_motor_73"];
  const document = configurationDocument(4, ids, {
    groups,
    motorGroups: {
      custom_motor_71: "custom_group_8",
      custom_motor_72: "custom_group_7",
      custom_motor_73: "custom_group_8",
    },
  });
  document.motors[0].label = "嘴角一";
  document.motors[1].label = "眼皮一";
  document.motors[2].label = "嘴角二";
  document.motors.forEach((entry) => { entry.nodeId = 44; });

  const imported = normalizers.normalizeImportedConfiguration(JSON.stringify(document));
  assert.deepEqual(
    Array.from(imported.groups, ({ id, label }) => ({ id, label })),
    groups,
  );
  assert.deepEqual(
    Array.from(imported.motors, ({ id, group }) => ({ id, group })),
    [
      { id: ids[0], group: "custom_group_8" },
      { id: ids[1], group: "custom_group_7" },
      { id: ids[2], group: "custom_group_8" },
    ],
  );
  assert.ok(ids.every((motorId) => imported.bindings[motorId].nodeId === 44));
  assert.ok(ids.every((motorId) => imported.drafts[motorId].closed === false));
});

test("schema-4 configuration validates group counts, uniqueness, and every motor membership", () => {
  const valid = configurationDocument(4, ["custom_motor_81"], {
    groups: [{ id: "custom_group_9", label: "辅助组" }],
    motorGroups: { custom_motor_81: "custom_group_9" },
  });

  const wrongCount = structuredClone(valid);
  wrongCount.groupCount = 2;
  assert.throws(
    () => normalizers.normalizeImportedConfiguration(JSON.stringify(wrongCount)),
    /分组.*数量|数量.*分组/,
  );

  const duplicateName = structuredClone(valid);
  duplicateName.groupCount = 2;
  duplicateName.groups.push({ groupId: "custom_group_10", label: "ＡＵＸ" });
  duplicateName.groups[0].label = "aux";
  assert.throws(
    () => normalizers.normalizeImportedConfiguration(JSON.stringify(duplicateName)),
    /分组名称重复/,
  );

  const missingGroup = structuredClone(valid);
  missingGroup.motors[0].group = "custom_group_404";
  assert.throws(
    () => normalizers.normalizeImportedConfiguration(JSON.stringify(missingGroup)),
    /未知电机分组|不存在/,
  );

  const legacyWithNewRootFields = configurationDocument(3, ["custom_motor_82"]);
  legacyWithNewRootFields.groupCount = 1;
  legacyWithNewRootFields.groups = [{ groupId: "custom", label: "自定义电机" }];
  assert.throws(
    () => normalizers.normalizeImportedConfiguration(JSON.stringify(legacyWithNewRootFields)),
    /未知字段/,
    "schema-3 remains strict and cannot silently accept schema-4 group metadata",
  );
});

test("configuration schemas 1 through 4 migrate every motor to open loop", () => {
  for (const [schemaVersion, ids] of [
    [1, LEGACY_MOTOR_IDS],
    [2, registry.MOTOR_IDS],
    [3, registry.MOTOR_IDS],
    [4, registry.MOTOR_IDS],
  ]) {
    const imported = normalizers.normalizeImportedConfiguration(
      JSON.stringify(configurationDocument(schemaVersion, ids)),
    );
    assert.ok(
      registry.MOTOR_IDS.every((motorId) => imported.drafts[motorId].closed === false),
      `schema ${schemaVersion} must migrate to open loop`,
    );
  }
});

test("schema-5 configuration requires and preserves a boolean closed field for every motor", () => {
  const valid = configurationDocument(5, registry.MOTOR_IDS, {
    closedByMotor: { head_yaw: true, head_yaw_2: false },
  });
  const imported = normalizers.normalizeImportedConfiguration(JSON.stringify(valid));
  assert.equal(imported.drafts.head_yaw.closed, true);
  assert.equal(imported.drafts.head_yaw_2.closed, false);

  const missing = structuredClone(valid);
  delete missing.motors[0].closed;
  assert.throws(
    () => normalizers.normalizeImportedConfiguration(JSON.stringify(missing)),
    /闭环模式.*布尔|布尔.*闭环模式/,
  );

  const nonBoolean = structuredClone(valid);
  nonBoolean.motors[0].closed = 1;
  assert.throws(
    () => normalizers.normalizeImportedConfiguration(JSON.stringify(nonBoolean)),
    /闭环模式.*布尔|布尔.*闭环模式/,
  );

  const legacyWithNewField = configurationDocument(4, registry.MOTOR_IDS);
  legacyWithNewField.motors[0].closed = false;
  assert.throws(
    () => normalizers.normalizeImportedConfiguration(JSON.stringify(legacyWithNewField)),
    /未知字段/,
    "schema 4 cannot silently claim schema-5 loop-mode data",
  );
});

test("timeline schemas 1 through 3 migrate actions to open loop", () => {
  for (const [schemaVersion, ids] of [
    [1, LEGACY_MOTOR_IDS],
    [2, registry.MOTOR_IDS],
    [3, registry.MOTOR_IDS],
  ]) {
    const imported = normalizers.normalizeImportedTimeline(
      JSON.stringify(timelineDocument(schemaVersion, ids)),
    );
    assert.ok(imported.program.snapshot().every(({ closed }) => closed === false),
      `timeline schema ${schemaVersion} must migrate to open loop`);
  }
});

test("timeline schema 4 requires and preserves a boolean closed field for every action", () => {
  const valid = timelineDocument(4, registry.MOTOR_IDS, {
    actions: [action("head_yaw", true), action("head_yaw_2", false)],
  });
  const imported = normalizers.normalizeImportedTimeline(JSON.stringify(valid));
  assert.deepEqual(
    Array.from(imported.program.snapshot(), ({ motorId, closed }) => ({ motorId, closed })),
    [
      { motorId: "head_yaw", closed: true },
      { motorId: "head_yaw_2", closed: false },
    ],
  );

  const missing = structuredClone(valid);
  delete missing.timeline.actions[0].closed;
  assert.throws(
    () => normalizers.normalizeImportedTimeline(JSON.stringify(missing)),
    /闭环模式.*布尔|布尔.*闭环模式/,
  );

  const nonBoolean = structuredClone(valid);
  nonBoolean.timeline.actions[0].closed = "closed";
  assert.throws(
    () => normalizers.normalizeImportedTimeline(JSON.stringify(nonBoolean)),
    /闭环模式.*布尔|布尔.*闭环模式/,
  );

  const legacyWithNewField = timelineDocument(3, registry.MOTOR_IDS);
  legacyWithNewField.timeline.actions[0].closed = false;
  assert.throws(
    () => normalizers.normalizeImportedTimeline(JSON.stringify(legacyWithNewField)),
    /未知字段/,
    "schema 3 cannot silently claim schema-4 loop-mode data",
  );
});

test("schema-3 animation ignores dormant missing tracks but rejects enabled or active missing motors", () => {
  const custom = {
    id: "custom_motor_61",
    label: "动画辅助电机",
    shortLabel: "动画辅助电机",
    group: registry.CUSTOM_GROUP_ID,
    defaultNodeId: null,
  };
  normalizers.state.motors.push(custom);
  normalizers.state.bindings[custom.id] = { motorId: custom.id, nodeId: 17 };
  normalizers.state.drafts[custom.id] = { steps: "1000", speed: "20", acceleration: "30" };
  normalizers.state.timelineTrackEnabled[custom.id] = false;

  const current = timelineDocument(3, [custom.id], {
    actions: [action(custom.id)],
  });
  current.motors[0].label = custom.label;
  current.timeline.trackEnabled[custom.id] = true;
  const imported = normalizers.normalizeImportedTimeline(JSON.stringify(current));
  assert.equal(imported.trackEnabled[custom.id], true);
  assert.equal(imported.program.snapshot()[0].motorId, custom.id);
  assert.equal(imported.program.snapshot()[0].closed, false);
  assert.equal(imported.trackEnabled.head_yaw, false, "current motors absent from the file default off");

  const dormantMissing = timelineDocument(3, ["custom_motor_999"], { actions: [] });
  const dormantImported = normalizers.normalizeImportedTimeline(JSON.stringify(dormantMissing));
  assert.equal(dormantImported.program.size, 0);
  assert.equal(Object.hasOwn(dormantImported.trackEnabled, "custom_motor_999"), false);

  const enabledMissing = structuredClone(dormantMissing);
  enabledMissing.timeline.trackEnabled.custom_motor_999 = true;
  assert.throws(
    () => normalizers.normalizeImportedTimeline(JSON.stringify(enabledMissing)),
    /当前电机配置缺少/,
  );

  const activeMissing = timelineDocument(3, ["custom_motor_999"], {
    actions: [action("custom_motor_999")],
  });
  assert.throws(
    () => normalizers.normalizeImportedTimeline(JSON.stringify(activeMissing)),
    /当前电机配置缺少/,
  );
});
