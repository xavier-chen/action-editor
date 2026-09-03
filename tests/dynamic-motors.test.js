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
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");

function functionSource(name) {
  const start = app.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const remainder = app.slice(start + 1);
  const next = remainder.search(/\n(?:async\s+)?function\s+\w+\s*\(/);
  return app.slice(start, next < 0 ? app.length : start + 1 + next);
}

function rendererHarness(options = {}) {
  const { storedRaw = null, confirmResult = true, motorDetails = [] } = options;
  const instrumented = app.replace(
    /\ninitialize\(\);\s*$/,
    `
buildMotorRows = () => { globalThis.__calls.buildRows += 1; };
updateMotorRowLabelMetadata = (row, motor) => { globalThis.__calls.labelMetadata.push({ row, motor }); };
requestNewMotorDetails = async (groups, preferredGroupId) => {
  globalThis.__calls.motorDetails.push({ groups, preferredGroupId });
  if (globalThis.__motorDetails.length) return globalThis.__motorDetails.shift();
  return { label: nextNewMotorLabel(), groupId: preferredGroupId || groups[0].id };
};
persistState = () => { globalThis.__calls.persist += 1; return true; };
refreshMotorRows = () => {};
renderProgram = () => {};
renderTimeline = () => {};
resetTimelineEditor = () => {};
renderConnection = () => {};
syncConfigurationInputs = () => {};
renderOrigin = () => {};
toast = (message, type = "info") => globalThis.__messages.push({ message: String(message), type });
confirmAction = async (...args) => { globalThis.__calls.confirm.push(args); return globalThis.__confirmResult; };
globalThis.__dynamicMotorTestApi = {
  state,
  addGroup,
  commitGroupName,
  deleteGroup,
  addMotor,
  deleteMotor,
  installMotorCatalog,
  importConfiguration,
  loadStoredState,
  persistedStateDocument,
  normalizeImportedConfiguration,
  hasMotor,
  recoveryStorageKey: RECOVERY_STORAGE_KEY,
};
`,
  );
  assert.notEqual(instrumented, app, "renderer harness must suppress initialize()");

  const terminal = {};
  const storage = new Map();
  if (storedRaw !== null) storage.set("lumface-can-terminal-v1", storedRaw);
  const namedActionState = {
    namedActions: { schemaVersion: 1, definitions: [] },
    actionTimeline: {
      schemaVersion: 1,
      durationMs: 10_000,
      snapMs: 100,
      pixelsPerSecond: 120,
      placements: [],
    },
  };
  const namedActions = {
    loadStoredState(stored) {
      if (stored?.namedActions) namedActionState.namedActions = stored.namedActions;
      if (stored?.actionTimeline) namedActionState.actionTimeline = stored.actionTimeline;
    },
    persistedStateFields() { return namedActionState; },
    motorCatalogRemovalImpact() {
      return { removedDefinitions: 0, removedNamedMotions: 0, removedPlacements: 0 };
    },
    reconcileMotorCatalog() {
      return { removedDefinitions: 0, removedNamedMotions: 0, removedPlacements: 0 };
    },
    renderAll() {},
  };
  const context = vm.createContext({
    window: { motorTerminal: terminal, LumNamedActions: namedActions },
    document: { getElementById() { return null; } },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
  __messages: [],
    __calls: { buildRows: 0, labelMetadata: [], persist: 0, confirm: [], motorDetails: [] },
    __motorDetails: motorDetails,
    __confirmResult: confirmResult,
    requestAnimationFrame(callback) { callback(); return 1; },
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
  });
  const registrySource = fs.readFileSync(path.join(root, "src", "motor-registry.js"), "utf8");
  vm.runInContext(registrySource, context, { filename: path.join(root, "src", "motor-registry.js") });
  context.window.FaceMotorRegistry = context.FaceMotorRegistry;
  context.window.FaceCommandLedger = commandModel;
  context.window.FaceTimelineModel = timelineModel;
  vm.runInContext(instrumented, context, { filename: path.join(root, "renderer", "app.js") });
  return {
    api: context.__dynamicMotorTestApi,
    calls: context.__calls,
    messages: context.__messages,
    motorDetails: context.__motorDetails,
    storage,
    terminal,
  };
}

function nameInput(value, row = null) {
  return {
    value,
    dataset: {},
    closest() { return row; },
    classList: { add() {}, remove() {} },
  };
}

test("dynamic motor controls collect a name before creation and expose no post-creation rename entry point", () => {
  assert.match(html, /id="addMotorButton"[^>]*>＋\s*添加电机</);
  for (const id of ["motorCreateModal", "motorCreateNameInput", "motorCreateGroupSelect"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(functionSource("requestNewMotorDetails"), /normalizeMotorLabel\(nameInput\.value\)/);
  assert.match(functionSource("createMotorControlRow"), /motor-name-label[\s\S]*motor-delete-button/);
  assert.doesNotMatch(functionSource("createMotorControlRow"), /motor-name-input/);
  assert.match(functionSource("initEvents"), /addMotorButton["']\)\.addEventListener\(["']click["'],\s*\(\)\s*=>\s*void\s+addMotor\(\)\)/);
  assert.doesNotMatch(functionSource("handleMotorBoardChange"), /motor-name-input|commitMotorName/);
  assert.doesNotMatch(functionSource("handleMotorBoardKeydown"), /motor-name-input/);
  assert.doesNotMatch(app, /function\s+commitMotorName\s*\(/);
  assert.match(functionSource("handleMotorBoardClick"), /motor-delete-button[\s\S]*deleteMotor\(motorId\)/);

  const install = functionSource("installMotorCatalog");
  assert.match(install, /keptCommands\s*=\s*previousCommands\.filter/);
  assert.match(install, /keptActions\s*=\s*previousActions\.filter/);
  assert.match(install, /new commandModel\.CommandProgram\(keptCommands\)/);
  assert.match(install, /new timelineModel\.TimelineProgram\(keptActions\)/);
});

test("groups can be edited while connected, motors are created in a target group, and nonempty groups cannot be deleted", async () => {
  const { api, calls, messages } = rendererHarness();
  api.state.connected = true;
  const groupCount = api.state.groups.length;
  api.addGroup();
  assert.equal(api.state.groups.length, groupCount + 1, "connected CAN must not lock UI-only grouping");
  const groupId = api.state.groups.at(-1).id;
  assert.equal(groupId, "custom_group_1");

  const groupNameInput = nameInput("眨眼联动");
  api.commitGroupName(groupId, groupNameInput);
  assert.equal(api.state.groups.at(-1).label, "眨眼联动");
  assert.equal(groupNameInput.dataset.previousLabel, "眨眼联动");

  api.state.connected = false;
  await api.addMotor(groupId);
  const motorId = api.state.motors.at(-1).id;
  assert.equal(api.state.motors.at(-1).group, groupId, "group-local creation fixes initial membership");
  api.state.bindings[motorId].nodeId = 23;
  api.state.drafts[motorId] = { steps: "4321", speed: "31", acceleration: "41", closed: true };
  api.state.timelineTrackEnabled[motorId] = true;
  api.state.program.add({
    motorId,
    nodeId: 23,
    signedSteps: 500,
    speed: 31,
    acceleration: 41,
    closed: true,
  });
  api.state.timeline.add({
    motorId,
    nodeId: 23,
    startMs: 100,
    signedSteps: -200,
    speed: 31,
    acceleration: 41,
    closed: true,
  });
  const commandBefore = api.state.program.snapshot()[0];
  const actionBefore = api.state.timeline.snapshot()[0];
  const groupsBeforeDelete = JSON.stringify(api.state.groups);
  const motorsBeforeDelete = JSON.stringify(api.state.motors);

  await api.deleteGroup(groupId);
  assert.equal(JSON.stringify(api.state.groups), groupsBeforeDelete);
  assert.equal(JSON.stringify(api.state.motors), motorsBeforeDelete);
  assert.equal(api.state.bindings[motorId].nodeId, 23);
  assert.deepEqual(
    { ...api.state.drafts[motorId] },
    { steps: "4321", speed: "31", acceleration: "41", closed: true },
  );
  assert.equal(api.state.timelineTrackEnabled[motorId], true);
  assert.deepEqual(api.state.program.snapshot()[0], commandBefore);
  assert.deepEqual(api.state.timeline.snapshot()[0], actionBefore);
  assert.equal(calls.confirm.length, 0);
  assert.ok(messages.some(({ message }) => /先逐个删除电机|先删除组内电机|非空/.test(message)));

  api.addGroup();
  const secondGroupId = api.state.groups.at(-1).id;
  const secondGroupLabel = api.state.groups.at(-1).label;
  api.commitGroupName(secondGroupId, nameInput("眉毛"));
  assert.equal(api.state.groups.at(-1).label, secondGroupLabel, "duplicate group names are rejected atomically");
  assert.ok(messages.some(({ message }) => /分组名称重复/.test(message)));
  assert.ok(messages.every(({ message }) => !/请先断开 CAN/.test(message)));
});

test("group deletion blocks the sole nonempty group but allows the final empty group", async () => {
  const blocked = rendererHarness();
  blocked.api.state.groups = [{ id: "brows", label: "眉毛" }];
  blocked.api.state.motors = blocked.api.state.motors
    .filter(({ group }) => group === "brows");
  await blocked.api.deleteGroup("brows");
  assert.deepEqual(Array.from(blocked.api.state.groups, ({ id }) => id), ["brows"]);
  assert.ok(blocked.messages.some(({ message }) => /先逐个删除电机|先删除组内电机|非空/.test(message)));
  assert.equal(blocked.calls.confirm.length, 0);

  const empty = rendererHarness();
  empty.api.state.groups = [{ id: "custom_group_99", label: "最后空组" }];
  empty.api.state.motors = [];
  empty.api.state.bindings = {};
  empty.api.state.drafts = {};
  empty.api.state.timelineTrackEnabled = {};
  await empty.api.deleteGroup("custom_group_99");
  assert.equal(empty.api.state.groups.length, 0);
  assert.equal(empty.calls.confirm.length, 0);
});

test("busy and configuration-I/O states atomically lock every group catalog edit", async () => {
  const { api } = rendererHarness();
  api.addGroup();
  const groupId = api.state.groups.at(-1).id;
  const originalGroups = JSON.stringify(api.state.groups);
  const originalMotorGroup = api.state.motors[0].group;
  api.state.busy = true;

  api.addGroup();
  api.commitGroupName(groupId, nameInput("不应生效"));
  await api.deleteGroup(groupId);

  assert.equal(JSON.stringify(api.state.groups), originalGroups);
  assert.equal(api.state.motors[0].group, originalMotorGroup);
});

test("schema-12 restart restores loop mode, groups, and motor membership before allocating the next stable group ID", async () => {
  const first = rendererHarness();
  first.api.addGroup();
  const groupId = first.api.state.groups.at(-1).id;
  first.api.commitGroupName(groupId, nameInput("闭眼动作组"));
  await first.api.addMotor(groupId);
  const motorId = first.api.state.motors.at(-1).id;
  assert.equal(first.api.state.motors.at(-1).group, groupId);
  first.api.state.bindings[motorId].nodeId = 61;
  first.api.state.drafts[motorId] = { steps: "1600", speed: "26", acceleration: "36", closed: true };
  first.api.state.timelineTrackEnabled[motorId] = true;
  first.api.state.program.add({
    motorId,
    nodeId: 61,
    signedSteps: 1600,
    speed: 26,
    acceleration: 36,
    closed: true,
  });
  first.api.state.timeline.add({
    motorId,
    nodeId: 61,
    startMs: 500,
    signedSteps: -1600,
    speed: 26,
    acceleration: 36,
    closed: true,
  });
  const stored = first.api.persistedStateDocument();
  assert.equal(stored.schemaVersion, 12);
  assert.equal(stored.nextCustomGroupNumber, 2);
  assert.equal(stored.groups.find(({ id }) => id === groupId).label, "闭眼动作组");

  const second = rendererHarness({ storedRaw: JSON.stringify(stored) });
  second.api.loadStoredState();
  assert.equal(second.api.state.groups.find(({ id }) => id === groupId).label, "闭眼动作组");
  assert.equal(second.api.state.motors.find(({ id }) => id === motorId).group, groupId);
  assert.equal(second.api.state.bindings[motorId].nodeId, 61);
  assert.deepEqual(
    { ...second.api.state.drafts[motorId] },
    { steps: "1600", speed: "26", acceleration: "36", closed: true },
  );
  assert.equal(second.api.state.timelineTrackEnabled[motorId], true);
  assert.equal(second.api.state.program.snapshot()[0].motorId, motorId);
  assert.equal(second.api.state.program.snapshot()[0].closed, true);
  assert.equal(second.api.state.timeline.snapshot()[0].motorId, motorId);
  assert.equal(second.api.state.timeline.snapshot()[0].closed, true);

  second.api.state.program.clear();
  second.api.state.timeline.clear();
  await second.api.deleteMotor(motorId);
  await second.api.deleteGroup(groupId);
  second.api.addGroup();
  assert.equal(second.api.state.groups.at(-1).id, "custom_group_2");
});

test("create-time naming, duplicate-name rejection, delete cleanup, and non-reused IDs work end to end", async () => {
  const { api, messages, motorDetails } = rendererHarness();
  api.installMotorCatalog({ motors: [], bindings: {}, drafts: {} });
  assert.equal(api.state.motors.length, 0);

  const targetGroupId = api.state.groups[0].id;
  motorDetails.push({ label: "眨眼同步电机", groupId: targetGroupId });
  await api.addMotor();
  assert.equal(api.state.motors.length, 1);
  const firstId = api.state.motors[0].id;
  assert.equal(firstId, "custom_motor_1");
  assert.equal(api.state.motors[0].label, "眨眼同步电机");
  api.state.bindings[firstId].nodeId = 23;
  api.state.program.add({
    motorId: firstId,
    nodeId: 23,
    signedSteps: 500,
    speed: 20,
    acceleration: 30,
    closed: false,
  });
  api.state.timeline.add({
    motorId: firstId,
    nodeId: 23,
    startMs: 100,
    signedSteps: -200,
    speed: 25,
    acceleration: 35,
    closed: false,
  });

  motorDetails.push({ label: "眨眼同步电机", groupId: targetGroupId });
  await api.addMotor();
  assert.equal(api.state.motors.length, 1, "duplicate display names are rejected atomically");
  assert.ok(messages.some(({ message }) => /名称重复/.test(message)));

  motorDetails.push({ label: "闭眼辅助电机", groupId: targetGroupId });
  await api.addMotor();
  const secondId = api.state.motors[1].id;
  assert.equal(secondId, "custom_motor_2");
  assert.equal(api.state.motors[1].label, "闭眼辅助电机");

  api.state.bindings[secondId].nodeId = 23;
  assert.equal(api.state.bindings[firstId].nodeId, api.state.bindings[secondId].nodeId, "CAN IDs may repeat");

  await api.deleteMotor(firstId);
  assert.equal(api.hasMotor(firstId), false);
  assert.equal(api.state.program.snapshot().some(({ motorId }) => motorId === firstId), false);
  assert.equal(api.state.timeline.snapshot().some(({ motorId }) => motorId === firstId), false);
  assert.equal(api.hasMotor(secondId), true);

  motorDetails.push({ label: "重新建立的电机", groupId: targetGroupId });
  await api.addMotor();
  assert.equal(api.state.motors.at(-1).id, "custom_motor_3", "deleted internal IDs are never reused");
});

test("canceling a destructive configuration import leaves motors, commands, and actions unchanged", async () => {
  const { api, calls, terminal } = rendererHarness({ confirmResult: false });
  const referencedMotorId = "head_yaw_2";
  api.state.bindings[referencedMotorId].nodeId = 17;
  api.state.program.add({
    motorId: referencedMotorId,
    nodeId: 17,
    signedSteps: 400,
    speed: 20,
    acceleration: 30,
    closed: false,
  });
  api.state.timeline.add({
    motorId: referencedMotorId,
    nodeId: 17,
    startMs: 200,
    signedSteps: 300,
    speed: 20,
    acceleration: 30,
    closed: false,
  });
  const before = JSON.stringify(api.persistedStateDocument());
  const importedDocument = {
    format: "face-robot-can-motor-config",
    schemaVersion: 3,
    exportedAt: "2026-08-31T00:00:00.000Z",
    interfaceName: "can9",
    simulate: true,
    motorCount: 1,
    motors: [{
      motorId: "custom_motor_90",
      label: "导入候选电机",
      group: registry.CUSTOM_GROUP_ID,
      nodeId: 90,
      steps: 1000,
      speed: 20,
      acceleration: 30,
    }],
  };
  terminal.importConfigFile = async () => ({
    canceled: false,
    fileName: "candidate.json",
    content: JSON.stringify(importedDocument),
  });

  await api.importConfiguration();
  assert.equal(calls.confirm.length, 1);
  assert.match(
    calls.confirm[0][1],
    /1 条指令记录、1 个电机时间轴动作、0 个命名动作和 0 个动作时间轴实例/,
  );
  assert.equal(JSON.stringify(api.persistedStateDocument()), before);
  assert.equal(calls.persist, 0);
});

test("damaged local motor catalogs are backed up and recover every independently valid item", () => {
  const rawState = JSON.stringify({
    schemaVersion: 9,
    interfaceName: "can0",
    simulate: false,
    nextCustomMotorNumber: 8,
    motors: [
      {
        id: "custom_motor_7",
        label: "可恢复电机",
        shortLabel: "可恢复电机",
        group: registry.CUSTOM_GROUP_ID,
      },
      {
        id: "INVALID MOTOR ID",
        label: "损坏电机",
        shortLabel: "损坏电机",
        group: registry.CUSTOM_GROUP_ID,
      },
    ],
    bindings: { custom_motor_7: { motorId: "custom_motor_7", nodeId: 44 } },
    drafts: { custom_motor_7: { steps: "700", speed: "21", acceleration: "31" } },
    program: [],
    timeline: { durationMs: 10000, snapMs: 100, pixelsPerSecond: 120, trackEnabled: {}, actions: [] },
  });
  const { api, storage } = rendererHarness({ storedRaw: rawState });
  api.loadStoredState();

  assert.equal(api.state.localRecoveryCreated, true);
  assert.equal(storage.get(api.recoveryStorageKey), rawState);
  assert.deepEqual(Array.from(api.state.motors, ({ id }) => id), ["custom_motor_7"]);
  assert.equal(api.state.bindings.custom_motor_7.nodeId, 44);
  assert.deepEqual(
    { ...api.state.drafts.custom_motor_7 },
    { steps: "700", speed: "21", acceleration: "31", closed: false },
  );
  assert.equal(api.state.nextCustomMotorNumber, 8);
  assert.deepEqual(
    Array.from(api.state.groups, ({ id, label }) => ({ id, label })),
    registry.DEFAULT_GROUPS.map(({ id, label }) => ({ id, label })),
    "schema-9 state without a group catalog migrates to the default groups",
  );
  assert.equal(api.persistedStateDocument().schemaVersion, 12);
});

test("damaged local groups recover independently without discarding motors in valid groups", () => {
  const rawState = JSON.stringify({
    schemaVersion: 10,
    interfaceName: "can0",
    simulate: false,
    nextCustomGroupNumber: 9,
    groups: [
      { id: "custom_group_7", label: "可恢复分组" },
      { id: "INVALID GROUP", label: "损坏分组" },
    ],
    nextCustomMotorNumber: 10,
    motors: [
      {
        id: "custom_motor_8",
        label: "可恢复电机",
        shortLabel: "可恢复电机",
        group: "custom_group_7",
      },
      {
        id: "custom_motor_9",
        label: "悬空电机",
        shortLabel: "悬空电机",
        group: "missing_group",
      },
    ],
    bindings: { custom_motor_8: { motorId: "custom_motor_8", nodeId: 55 } },
    drafts: { custom_motor_8: { steps: "888", speed: "28", acceleration: "38" } },
    program: [],
    timeline: {
      durationMs: 10000,
      snapMs: 100,
      pixelsPerSecond: 120,
      trackEnabled: { custom_motor_8: true },
      actions: [],
    },
  });
  const { api, storage } = rendererHarness({ storedRaw: rawState });
  api.loadStoredState();

  assert.equal(storage.get(api.recoveryStorageKey), rawState);
  assert.deepEqual(Array.from(api.state.groups, ({ id }) => id), ["custom_group_7"]);
  assert.deepEqual(Array.from(api.state.motors, ({ id }) => id), ["custom_motor_8"]);
  assert.equal(api.state.motors[0].group, "custom_group_7");
  assert.equal(api.state.bindings.custom_motor_8.nodeId, 55);
  assert.deepEqual(
    { ...api.state.drafts.custom_motor_8 },
    { steps: "888", speed: "28", acceleration: "38", closed: false },
  );
  assert.equal(api.state.timelineTrackEnabled.custom_motor_8, true);
  assert.equal(api.state.nextCustomGroupNumber, 9);
});

test("schema-3 VM normalizer accepts repeated CAN IDs but rejects duplicate names and IDs", () => {
  const { api } = rendererHarness();
  const document = {
    format: "face-robot-can-motor-config",
    schemaVersion: 3,
    exportedAt: "2026-08-31T00:00:00.000Z",
    interfaceName: "can0",
    simulate: false,
    motorCount: 2,
    motors: [
      {
        motorId: "custom_motor_11",
        label: "眼皮同步一",
        group: registry.CUSTOM_GROUP_ID,
        nodeId: 31,
        steps: 1000,
        speed: 20,
        acceleration: 30,
      },
      {
        motorId: "custom_motor_12",
        label: "眼皮同步二",
        group: registry.CUSTOM_GROUP_ID,
        nodeId: 31,
        steps: 1000,
        speed: 20,
        acceleration: 30,
      },
    ],
  };
  const normalized = api.normalizeImportedConfiguration(JSON.stringify(document));
  assert.equal(normalized.bindings.custom_motor_11.nodeId, 31);
  assert.equal(normalized.bindings.custom_motor_12.nodeId, 31);

  const duplicateName = structuredClone(document);
  duplicateName.motors[1].label = duplicateName.motors[0].label;
  assert.throws(
    () => api.normalizeImportedConfiguration(JSON.stringify(duplicateName)),
    /名称重复/,
  );

  const duplicateId = structuredClone(document);
  duplicateId.motors[1].motorId = duplicateId.motors[0].motorId;
  assert.throws(
    () => api.normalizeImportedConfiguration(JSON.stringify(duplicateId)),
    /重复/,
  );
});
