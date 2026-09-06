"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const registry = require("../src/motor-registry");
const commandModel = require("../src/command-ledger");
const {
  DEFAULT_MOTION_PROFILE,
  MAX_ACTIONS,
  MAX_START_MS,
  TimelineProgram,
  estimateActionDuration,
  estimateMotionDuration,
  millisecondsFromPixels,
  motionRatesFromLevels,
  normalizeMotionProfile,
  snapStartMs,
  shiftTimelineStartMs,
  validateAction,
} = require("../src/timeline-model");

function action(overrides = {}) {
  return {
    motorId: "left_brow_outer",
    nodeId: 12,
    startMs: 500,
    signedSteps: 1000,
    speed: 20,
    acceleration: 20,
    closed: false,
    ...overrides,
  };
}

test("timeline actions normalize form values and are immutable", () => {
  const normalized = validateAction(action({
    nodeId: "127",
    startMs: "250",
    signedSteps: "-500",
    speed: "40",
    acceleration: "30",
  }));
  assert.deepEqual(normalized, action({
    nodeId: 127,
    startMs: 250,
    signedSteps: -500,
    speed: 40,
    acceleration: 30,
  }));
  assert.ok(Object.isFrozen(normalized));
});

test("timeline actions default legacy data to open loop and preserve closed-loop mode", () => {
  const legacy = action();
  delete legacy.closed;
  assert.equal(validateAction(legacy).closed, false);
  assert.equal(validateAction(action({ closed: true })).closed, true);
  for (const closed of [null, 0, 1, "true", {}]) {
    assert.throws(() => validateAction(action({ closed })), /闭环模式必须是布尔值/);
  }
});

test("timeline action validation accepts stable dynamic motor IDs and enforces ranges", () => {
  assert.equal(
    validateAction(action({ motorId: "custom_motor_42" })).motorId,
    "custom_motor_42",
  );
  for (const motorId of ["", " custom_motor_1", "CustomMotor", "custom/motor", `m${"x".repeat(64)}`]) {
    assert.throws(() => validateAction(action({ motorId })), /内部 ID/);
  }
  for (const nodeId of [0, 128]) assert.throws(() => validateAction(action({ nodeId })), /电机 ID/);
  for (const startMs of [-1, 1.5, MAX_START_MS + 1]) {
    assert.throws(() => validateAction(action({ startMs })), /开始时间/);
  }
  for (const signedSteps of [0, 0x1000000]) {
    assert.throws(() => validateAction(action({ signedSteps })), /步数/);
  }
  for (const speed of [0, 101]) assert.throws(() => validateAction(action({ speed })), /速度/);
  for (const acceleration of [0, 101]) {
    assert.throws(() => validateAction(action({ acceleration })), /加速度/);
  }
  assert.throws(() => validateAction({ ...action(), extra: true }), /未知字段/);
});

test("timeline program IDs are stable and never reused", () => {
  const program = new TimelineProgram();
  const first = program.add(action());
  const second = program.add(action({ startMs: 600 }));
  assert.equal(first.actionId, "action-000001");
  assert.equal(second.actionId, "action-000002");
  assert.equal(program.remove(first.actionId), first);
  assert.equal(program.add(action({ startMs: 700 })).actionId, "action-000003");
  assert.throws(() => program.add(action({ actionId: second.actionId })), /已存在/);
});

test("one motor can own multiple independent actions at different times", () => {
  const program = new TimelineProgram();
  const first = program.add(action({ startMs: 500, signedSteps: 1000 }));
  const second = program.add(action({ startMs: 1500, signedSteps: -700 }));
  assert.equal(program.size, 2);
  assert.notEqual(first.actionId, second.actionId);
  assert.deepEqual(program.snapshot().map(({ startMs }) => startMs), [500, 1500]);
  assert.equal(program.conflicts().length, 0);
});

test("timeline update is atomic and preserves action identity", () => {
  const program = new TimelineProgram([action({ actionId: "saved-action" })]);
  const before = program.get("saved-action");
  const updated = program.update("saved-action", { startMs: 900, signedSteps: -250 });
  assert.equal(updated.actionId, "saved-action");
  assert.equal(updated.startMs, 900);
  assert.equal(updated.signedSteps, -250);
  assert.equal(updated.closed, false);
  assert.throws(() => program.update("saved-action", { speed: 101 }), /速度/);
  assert.equal(program.get("saved-action"), updated);
  const closed = program.update("saved-action", { closed: true });
  assert.equal(closed.closed, true);
  assert.equal(program.get("saved-action"), closed);
  assert.throws(() => program.update("saved-action", { actionId: "other" }), /不能修改/);
  assert.notEqual(before, updated);
});

test("timeline groups preserve simultaneous actions and stable insertion order", () => {
  const program = new TimelineProgram();
  const late = program.add(action({ motorId: "neck", nodeId: 20, startMs: 1000 }));
  const firstAt500 = program.add(action({ startMs: 500 }));
  const secondAt500 = program.add(action({ motorId: "head_yaw", nodeId: 21, startMs: 500 }));
  const atZero = program.add(action({ motorId: "lower_jaw", nodeId: 22, startMs: 0 }));
  const groups = program.groups();
  assert.deepEqual(groups.map(({ startMs }) => startMs), [0, 500, 1000]);
  assert.deepEqual(groups[1].actions.map(({ actionId }) => actionId), [firstAt500.actionId, secondAt500.actionId]);
  assert.equal(groups[0].actions[0], atZero);
  assert.equal(groups[2].actions[0], late);
  assert.ok(Object.isFrozen(groups) && Object.isFrozen(groups[1].actions));
});

test("same-time actions conflict only when they target the same physical node", () => {
  const program = new TimelineProgram([
    action({ actionId: "a", motorId: "left_brow_outer", nodeId: 7, startMs: 500 }),
    action({ actionId: "b", motorId: "neck", nodeId: 7, startMs: 500 }),
    action({ actionId: "c", motorId: "head_yaw", nodeId: 8, startMs: 500 }),
    action({ actionId: "d", motorId: "lower_jaw", nodeId: 7, startMs: 600 }),
  ]);
  const conflicts = program.conflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].nodeId, 7);
  assert.equal(conflicts[0].startMs, 500);
  assert.deepEqual(conflicts[0].actions.map(({ actionId }) => actionId), ["a", "b"]);
});

test("snap and drag conversion use bounded absolute milliseconds", () => {
  assert.equal(snapStartMs(-40, 100, 1000), 0);
  assert.equal(snapStartMs(149, 100, 1000), 100);
  assert.equal(snapStartMs(150, 100, 1000), 200);
  assert.equal(snapStartMs(1200, 100, 1000), 1000);
  assert.equal(snapStartMs(149.4, 0, 1000), 149);
  assert.equal(millisecondsFromPixels(120, 120), 1000);
  assert.equal(millisecondsFromPixels(-30, 60), -500);
  assert.equal(shiftTimelineStartMs(1_200, 100, 10, 110, 100, 10_000), 2_200);
  assert.equal(shiftTimelineStartMs(1_200, -220, 0, 110, 100, 10_000), 0);
  assert.equal(shiftTimelineStartMs(9_900, 22, 0, 110, 100, 10_000), 10_000);
  assert.equal(shiftTimelineStartMs(1_200, 5.5, 0, 110, 0, 10_000), 1_250);
  assert.throws(() => shiftTimelineStartMs(1_200, Number.NaN, 0, 110), /拖拽位移/);
});

test("duration estimate follows the firmware quadratic level mapping and S-curve", () => {
  const level10 = motionRatesFromLevels(10, 10, DEFAULT_MOTION_PROFILE);
  const level20 = motionRatesFromLevels(20, 20, DEFAULT_MOTION_PROFILE);
  assert.equal(level10.actualSpeed, 12_800);
  assert.equal(level20.actualSpeed, 51_200);
  assert.equal(level20.actualSpeed, level10.actualSpeed * 4);

  const shortMove = estimateMotionDuration({
    count: 1_000,
    speedLevel: 20,
    accelerationLevel: 20,
  });
  assert.equal(shortMove.profileType, "s-curve");
  assert.equal(shortMove.durationMs, 154);
  assert.ok(Math.abs(shortMove.rawDurationMs - 153.093) < 0.01);
  assert.equal(shortMove.actualSpeed, 51_200);
  assert.equal(shortMove.actualAcceleration, 341_333);

  const longMove = estimateMotionDuration({
    count: 1_000_000,
    speedLevel: 20,
    accelerationLevel: 20,
  });
  assert.equal(longMove.profileType, "s-curve-cruise");
  assert.ok(longMove.durationMs > shortMove.durationMs);
  assert.ok(longMove.cruiseDistance > 0);
});

test("duration estimate uses action magnitude and the supplied motor profile", () => {
  const positive = estimateActionDuration(action({ signedSteps: 8_000 }));
  const negative = estimateActionDuration(action({ signedSteps: -8_000 }));
  assert.equal(negative.durationMs, positive.durationMs);

  const slowerProfile = normalizeMotionProfile({
    ...DEFAULT_MOTION_PROFILE,
    speedLimitRpm: 300,
    accelerationLimitRpmS: 2_000,
  });
  const slower = estimateActionDuration(action({ signedSteps: 8_000 }), slowerProfile);
  assert.ok(slower.durationMs > positive.durationMs);
  assert.ok(Object.isFrozen(slowerProfile));
  assert.throws(
    () => normalizeMotionProfile({ ...DEFAULT_MOTION_PROFILE, microsteps: 3 }),
    /微步细分/,
  );
});

test("timeline snapshots round-trip, cap size, and do not share arrays", () => {
  const program = new TimelineProgram([action({ actionId: "saved" })]);
  const snapshot = program.snapshot();
  assert.notEqual(snapshot, program.snapshot());
  assert.deepEqual(new TimelineProgram(snapshot).snapshot(), snapshot);
  assert.throws(() => new TimelineProgram([
    action({ actionId: "same" }),
    action({ actionId: "same", startMs: 600 }),
  ]), /已存在/);

  const capped = new TimelineProgram();
  for (let index = 0; index < MAX_ACTIONS; index += 1) {
    capped.add(action({ startMs: index }));
  }
  assert.throws(() => capped.add(action()), new RegExp(String(MAX_ACTIONS)));
  assert.equal(capped.clear(), MAX_ACTIONS);
  assert.equal(capped.size, 0);
});

test("UMD build exposes the timeline model to a browser global", () => {
  const filename = path.join(__dirname, "..", "src", "timeline-model.js");
  const source = fs.readFileSync(filename, "utf8");
  const context = vm.createContext({
    FaceMotorRegistry: registry,
    FaceCommandLedger: commandModel,
  });
  vm.runInContext(source, context, { filename });
  assert.equal(typeof context.FaceTimelineModel.TimelineProgram, "function");
  assert.equal(typeof context.FaceTimelineModel.shiftTimelineStartMs, "function");
  assert.ok(Object.isFrozen(context.FaceTimelineModel));
});
