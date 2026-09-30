"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const registry = require("../src/motor-registry");
const {
  MAX_ACTION_NAME_LENGTH,
  MAX_ACTION_DEFINITIONS,
  MAX_ACTION_TRACK_NAME_LENGTH,
  MAX_ACTION_TRACKS,
  MAX_MOTIONS_PER_DEFINITION,
  MAX_PLACEMENTS,
  MAX_START_MS,
  MAX_STEP_COUNT,
  ACTION_PLAYBACK_RATES,
  ActionLibrary,
  ActionTrackCatalog,
  NamedActionTimeline,
  actionPlaybackDurationMs,
  actionPlaybackStartMs,
  deriveMotionLanes,
  motionForActionPlayback,
  validateActionPlaybackSettings,
  validateActionFileMotion,
  validateActionDefinition,
  validateActionTrack,
  validateMotion,
  validatePlacement,
} = require("../src/action-library");

function motion(overrides = {}) {
  return {
    motorId: "left_upper_eyelid",
    nodeId: 10,
    startMs: 0,
    signedSteps: 1_000,
    speed: 30,
    acceleration: 20,
    closed: false,
    ...overrides,
  };
}

function definition(overrides = {}) {
  return {
    name: "眨眼",
    motions: [motion()],
    ...overrides,
  };
}

function placement(overrides = {}) {
  return {
    actionDefinitionId: "action-definition-000001",
    startMs: 500,
    ...overrides,
  };
}

function actionTrack(overrides = {}) {
  return {
    name: "表情轨道",
    ...overrides,
  };
}

test("action playback settings provide immutable defaults and accept every supported rate", () => {
  assert.deepEqual(ACTION_PLAYBACK_RATES, [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]);
  assert.ok(Object.isFrozen(ACTION_PLAYBACK_RATES));
  assert.deepEqual(validateActionPlaybackSettings(), {
    mode: "time",
    rate: 1,
    parameterTarget: "both",
  });
  assert.ok(Object.isFrozen(validateActionPlaybackSettings({})));

  for (const rate of ACTION_PLAYBACK_RATES) {
    assert.equal(validateActionPlaybackSettings({ rate }).rate, rate);
  }
  assert.deepEqual(validateActionPlaybackSettings({
    mode: "parameters",
    rate: "1.25",
    parameterTarget: "speed",
  }), {
    mode: "parameters",
    rate: 1.25,
    parameterTarget: "speed",
  });
});

test("action playback settings reject unknown fields, modes, targets, and rates", () => {
  assert.throws(() => validateActionPlaybackSettings(null), /必须是对象/);
  assert.throws(() => validateActionPlaybackSettings({ extra: true }), /未知字段/);
  assert.throws(() => validateActionPlaybackSettings({ mode: "motor" }), /播放模式/);
  assert.throws(
    () => validateActionPlaybackSettings({ parameterTarget: "steps" }),
    /参数目标/,
  );
  for (const rate of [null, "", false, 0, 0.1, 3, NaN, Infinity]) {
    assert.throws(() => validateActionPlaybackSettings({ rate }), /播放倍率/);
  }
});

test("time playback scales start times by rounding and durations by ceiling", () => {
  const expectedByRate = [
    [0.25, 404, 404],
    [0.5, 202, 202],
    [0.75, 135, 135],
    [1, 101, 101],
    [1.25, 81, 81],
    [1.5, 67, 68],
    [2, 51, 51],
  ];
  for (const [rate, expectedStartMs, expectedDurationMs] of expectedByRate) {
    assert.equal(actionPlaybackStartMs(101, { mode: "time", rate }), expectedStartMs);
    assert.equal(actionPlaybackDurationMs(101, { mode: "time", rate }), expectedDurationMs);
  }
  assert.equal(actionPlaybackDurationMs(1, { mode: "time", rate: 2 }), 1);

  assert.equal(actionPlaybackStartMs(101, { mode: "parameters", rate: 2 }), 101);
  assert.equal(actionPlaybackDurationMs(101, { mode: "parameters", rate: 2 }), 101);
  assert.equal(actionPlaybackStartMs(MAX_START_MS, { rate: 0.25 }), MAX_START_MS * 4);
  assert.equal(actionPlaybackDurationMs(MAX_START_MS, { rate: 0.25 }), MAX_START_MS * 4);
});

test("action playback time helpers validate their source ranges", () => {
  for (const startMs of [-1, 1.5, MAX_START_MS + 1, null, ""]) {
    assert.throws(() => actionPlaybackStartMs(startMs), /开始时间/);
  }
  for (const durationMs of [0, -1, 1.5, MAX_START_MS + 1, null, ""]) {
    assert.throws(() => actionPlaybackDurationMs(durationMs), /动作时长/);
  }
});

test("parameter playback independently scales speed, acceleration, or both", () => {
  const source = motion({
    motionId: "source-motion",
    speed: 31,
    acceleration: 21,
    closed: true,
  });
  const speedOnly = motionForActionPlayback(source, {
    mode: "parameters",
    rate: 1.5,
    parameterTarget: "speed",
  });
  const accelerationOnly = motionForActionPlayback(source, {
    mode: "parameters",
    rate: 1.5,
    parameterTarget: "acceleration",
  });
  const both = motionForActionPlayback(source, {
    mode: "parameters",
    rate: 1.5,
    parameterTarget: "both",
  });

  assert.deepEqual(speedOnly, { ...source, speed: 47 });
  assert.deepEqual(accelerationOnly, { ...source, acceleration: 32 });
  assert.deepEqual(both, { ...source, speed: 47, acceleration: 32 });
  assert.ok(Object.isFrozen(speedOnly));
  assert.ok(Object.isFrozen(accelerationOnly));
  assert.ok(Object.isFrozen(both));
  assert.deepEqual(source, motion({
    motionId: "source-motion",
    speed: 31,
    acceleration: 21,
    closed: true,
  }));

  const expectedLevels = [10, 20, 30, 40, 50, 60, 80];
  ACTION_PLAYBACK_RATES.forEach((rate, index) => {
    const effective = motionForActionPlayback(motion({ speed: 40, acceleration: 40 }), {
      mode: "parameters",
      rate,
    });
    assert.equal(effective.speed, expectedLevels[index]);
    assert.equal(effective.acceleration, expectedLevels[index]);
  });
});

test("parameter playback clamps levels while time playback leaves motion parameters unchanged", () => {
  const high = motionForActionPlayback(motion({ speed: 80, acceleration: 100 }), {
    mode: "parameters",
    rate: 2,
  });
  const low = motionForActionPlayback(motion({ speed: 1, acceleration: 2 }), {
    mode: "parameters",
    rate: 0.25,
  });
  const timeScaled = motionForActionPlayback(motion({ speed: 31, acceleration: 21 }), {
    mode: "time",
    rate: 2,
    parameterTarget: "speed",
  });

  assert.equal(high.speed, 100);
  assert.equal(high.acceleration, 100);
  assert.equal(low.speed, 1);
  assert.equal(low.acceleration, 1);
  assert.equal(timeScaled.speed, 31);
  assert.equal(timeScaled.acceleration, 21);
  assert.ok(Object.isFrozen(timeScaled));
});

test("temporary playback motions never alter action-library snapshots", () => {
  const library = new ActionLibrary([definition({
    actionDefinitionId: "saved-action",
    motions: [motion({ motionId: "saved-motion", speed: 80, acceleration: 60 })],
  })]);
  const before = library.snapshot();
  const effective = motionForActionPlayback(before[0].motions[0], {
    mode: "parameters",
    rate: 2,
    parameterTarget: "both",
  });

  assert.notEqual(effective, before[0].motions[0]);
  assert.equal(effective.speed, 100);
  assert.equal(effective.acceleration, 100);
  assert.deepEqual(library.snapshot(), before);
  assert.equal(library.revision, 1);
});

test("motions normalize form values, freeze output, and default legacy mode to open loop", () => {
  const legacy = motion({
    motionId: "saved-motion",
    nodeId: "127",
    startMs: "250",
    signedSteps: "-500",
    speed: "40",
    acceleration: "30",
  });
  delete legacy.closed;
  const normalized = validateMotion(legacy);
  assert.deepEqual(normalized, {
    motionId: "saved-motion",
    motorId: "left_upper_eyelid",
    nodeId: 127,
    startMs: 250,
    signedSteps: -500,
    speed: 40,
    acceleration: 30,
    closed: false,
  });
  assert.ok(Object.isFrozen(normalized));
  assert.equal(validateMotion(motion({ closed: true })).closed, true);
  for (const closed of [null, 0, 1, "true", {}]) {
    assert.throws(() => validateMotion(motion({ closed })), /闭环模式必须是布尔值/);
  }
});

test("motion validation enforces all protocol ranges and rejects unknown fields", () => {
  for (const nodeId of [0, 128]) assert.throws(() => validateMotion(motion({ nodeId })), /电机 ID/);
  for (const startMs of [-1, 1.5, MAX_START_MS + 1]) {
    assert.throws(() => validateMotion(motion({ startMs })), /开始时间/);
  }
  for (const signedSteps of [0, -MAX_STEP_COUNT - 1, MAX_STEP_COUNT + 1]) {
    assert.throws(() => validateMotion(motion({ signedSteps })), /步数/);
  }
  for (const speed of [0, 101]) assert.throws(() => validateMotion(motion({ speed })), /速度/);
  for (const acceleration of [0, 101]) {
    assert.throws(() => validateMotion(motion({ acceleration })), /加速度/);
  }
  assert.throws(() => validateMotion(motion({ motorId: "Bad Motor" })), /内部 ID/);
  assert.throws(() => validateMotion({ ...motion(), extra: true }), /未知字段/);
});

test("action-file motions require native JSON integers and an explicit loop mode", () => {
  assert.deepEqual(validateActionFileMotion(motion()), validateMotion(motion()));
  for (const field of ["nodeId", "startMs", "signedSteps", "speed", "acceleration"]) {
    assert.throws(
      () => validateActionFileMotion(motion({ [field]: String(motion()[field]) })),
      /JSON 整数/,
    );
    assert.throws(
      () => validateActionFileMotion(motion({ [field]: [motion()[field]] })),
      /JSON 整数/,
    );
  }
  assert.throws(() => validateActionFileMotion({ ...motion(), closed: "false" }), /布尔值/);
  const withoutMode = motion();
  delete withoutMode.closed;
  assert.throws(() => validateActionFileMotion(withoutMode), /布尔值/);
});

test("named definitions enforce Unicode names, motion counts, and immutable nested arrays", () => {
  const normalized = validateActionDefinition(definition({ name: "  微笑😀  " }));
  assert.equal(normalized.name, "微笑😀");
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.motions));
  assert.throws(() => validateActionDefinition(definition({ name: " " })), /动作名称长度/);
  assert.throws(
    () => validateActionDefinition(definition({ name: "面".repeat(MAX_ACTION_NAME_LENGTH + 1) })),
    /动作名称长度/,
  );
  assert.throws(() => validateActionDefinition(definition({ motions: [] })), /1–128/);
  assert.throws(
    () => validateActionDefinition(definition({
      motions: Array.from({ length: MAX_MOTIONS_PER_DEFINITION + 1 }, () => motion()),
    })),
    /1–128/,
  );
  assert.throws(() => validateActionDefinition({ ...definition(), extra: true }), /未知字段/);
});

test("an action definition can combine motors and multiple times", () => {
  const library = new ActionLibrary();
  const blink = library.add(definition({
    motions: [
      motion({ motorId: "left_upper_eyelid", nodeId: 10, startMs: 0, signedSteps: 900 }),
      motion({ motorId: "right_upper_eyelid", nodeId: 11, startMs: 0, signedSteps: 900 }),
      motion({ motorId: "left_upper_eyelid", nodeId: 10, startMs: 180, signedSteps: -900 }),
      motion({ motorId: "right_upper_eyelid", nodeId: 11, startMs: 180, signedSteps: -900 }),
    ],
  }));
  assert.equal(blink.motions.length, 4);
  assert.deepEqual(blink.motions.map(({ startMs }) => startMs), [0, 0, 180, 180]);
  assert.equal(new Set(blink.motions.map(({ motionId }) => motionId)).size, 4);
  assert.ok(blink.motions.every(({ motionId }) => motionId.startsWith("motion-")));
});

test("motion lanes group the same logical motor and keep different motors separate", () => {
  const lanes = deriveMotionLanes([
    motion({ motionId: "left-late", motorId: "left_upper_eyelid", nodeId: 42, startMs: 300 }),
    motion({ motionId: "right-now", motorId: "right_upper_eyelid", nodeId: 42, startMs: 0 }),
    motion({ motionId: "left-now", motorId: "left_upper_eyelid", nodeId: 42, startMs: 0 }),
  ], ["right_upper_eyelid", "left_upper_eyelid"]);

  assert.equal(lanes.length, 2, "a repeated CAN ID must not merge different logical motors");
  assert.deepEqual(lanes.map(({ motorId }) => motorId), [
    "right_upper_eyelid",
    "left_upper_eyelid",
  ]);
  assert.deepEqual(lanes[0].entries.map(({ index }) => index), [1]);
  assert.deepEqual(lanes[1].entries.map(({ index }) => index), [2, 0]);
  assert.deepEqual(lanes[1].entries.map(({ motion: entry }) => entry.motionId), [
    "left-now",
    "left-late",
  ]);
  assert.ok(Object.isFrozen(lanes));
  assert.ok(Object.isFrozen(lanes[1]));
  assert.ok(Object.isFrozen(lanes[1].entries));
});

test("motion lane derivation validates inputs without adding persisted fields", () => {
  const source = [motion({ motionId: "saved-motion", startMs: 250 })];
  const [lane] = deriveMotionLanes(source);
  assert.deepEqual(Object.keys(lane).sort(), ["entries", "motorId"]);
  assert.deepEqual(Object.keys(lane.entries[0]).sort(), ["index", "motion"]);
  assert.deepEqual(lane.entries[0].motion, validateMotion(source[0]));
  assert.throws(() => deriveMotionLanes({}), /动作运动片段必须是数组/);
  assert.throws(() => deriveMotionLanes(source, {}), /电机顺序必须是数组/);
});

test("legacy named-action snapshots round-trip before deriving independent lanes", () => {
  const legacySnapshot = [{
    actionDefinitionId: "saved-blink",
    name: "眨眼",
    motions: [
      motion({ motionId: "left-close", motorId: "left_upper_eyelid", nodeId: 42, startMs: 0 }),
      motion({ motionId: "right-close", motorId: "right_upper_eyelid", nodeId: 42, startMs: 0 }),
      motion({ motionId: "left-open", motorId: "left_upper_eyelid", nodeId: 42, startMs: 250 }),
    ],
  }];
  const roundTripped = new ActionLibrary(legacySnapshot).snapshot();

  assert.deepEqual(roundTripped, legacySnapshot);
  assert.deepEqual(
    deriveMotionLanes(roundTripped[0].motions).map((lane) => ({
      motorId: lane.motorId,
      motionIds: lane.entries.map(({ motion: entry }) => entry.motionId),
    })),
    [
      { motorId: "left_upper_eyelid", motionIds: ["left-close", "left-open"] },
      { motorId: "right_upper_eyelid", motionIds: ["right-close"] },
    ],
  );
  assert.equal(JSON.stringify(roundTripped).includes("lanes"), false,
    "derived lane metadata must never enter saved or exported definitions");
});

test("action names are unique after trimming and Unicode normalization", () => {
  const library = new ActionLibrary([definition({ name: "抬眉" })]);
  assert.throws(() => library.add(definition({ name: " 抬眉 " })), /动作名称已存在/);
  library.add(definition({ name: "e\u0301" }));
  assert.throws(() => library.add(definition({ name: "é" })), /动作名称已存在/);
});

test("definition and motion IDs remain stable and are never reused", () => {
  const library = new ActionLibrary();
  const first = library.add(definition());
  assert.equal(first.actionDefinitionId, "action-definition-000001");
  assert.equal(first.motions[0].motionId, "motion-000001");

  const updated = library.update(first.actionDefinitionId, { name: "快速眨眼" });
  assert.equal(updated.actionDefinitionId, first.actionDefinitionId);
  assert.equal(updated.motions[0].motionId, first.motions[0].motionId);

  assert.equal(library.remove(first.actionDefinitionId), updated);
  const second = library.add(definition({ name: "微笑" }));
  assert.equal(second.actionDefinitionId, "action-definition-000002");
  assert.equal(second.motions[0].motionId, "motion-000002");
  assert.throws(
    () => library.add(definition({ actionDefinitionId: first.actionDefinitionId, name: "旧动作" })),
    /已使用/,
  );
});

test("updating motions preserves retained IDs and never resurrects removed IDs", () => {
  const library = new ActionLibrary();
  const created = library.add(definition({
    motions: [motion(), motion({ motorId: "right_upper_eyelid", nodeId: 11 })],
  }));
  const retained = created.motions[0];
  const removedId = created.motions[1].motionId;
  const updated = library.update(created.actionDefinitionId, {
    motions: [retained, motion({ motorId: "neck", nodeId: 12 })],
  });
  assert.equal(updated.motions[0].motionId, retained.motionId);
  assert.equal(updated.motions[1].motionId, "motion-000003");
  assert.throws(
    () => library.update(created.actionDefinitionId, {
      motions: [retained, motion({ motionId: removedId, motorId: "neck", nodeId: 12 })],
    }),
    /motionId 已使用/,
  );
  assert.equal(library.get(created.actionDefinitionId), updated);
  assert.throws(
    () => library.update(created.actionDefinitionId, { actionDefinitionId: "other" }),
    /不能修改/,
  );
});

test("library snapshots round-trip through import and failed imports are atomic", () => {
  const source = new ActionLibrary([
    definition({ actionDefinitionId: "saved-a", name: "眨眼", motions: [motion({ motionId: "saved-m1" })] }),
    definition({
      actionDefinitionId: "saved-b",
      name: "点头",
      motions: [motion({ motionId: "saved-m2", motorId: "neck", nodeId: 20 })],
    }),
  ]);
  const snapshot = source.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.notEqual(snapshot, source.snapshot());

  const imported = new ActionLibrary();
  assert.deepEqual(imported.import(snapshot), snapshot);
  assert.deepEqual(imported.snapshot(), snapshot);
  const before = imported.snapshot();
  assert.throws(() => imported.import([
    definition({ actionDefinitionId: "new-a", name: "重复" }),
    definition({ actionDefinitionId: "new-b", name: "重复" }),
  ]), /动作名称已存在/);
  assert.deepEqual(imported.snapshot(), before);
});

test("library import replaces active data without permitting retired ID reuse", () => {
  const library = new ActionLibrary();
  const retired = library.add(definition());
  library.import([]);
  assert.equal(library.size, 0);
  assert.throws(() => library.import([retired]), /已使用/);
  assert.equal(library.size, 0);
  assert.equal(library.add(definition({ name: "新动作" })).actionDefinitionId, "action-definition-000002");
});

test("action-library append imports are atomic, additive, and allocate fresh local IDs", () => {
  const library = new ActionLibrary();
  const existing = library.add(definition({
    actionDefinitionId: "source-action",
    name: "眨眼",
    motions: [motion({ motionId: "source-motion" })],
  }));
  const retired = library.add(definition({ name: "已删除" }));
  library.remove(retired.actionDefinitionId);
  const revisionBefore = library.revision;

  const result = library.appendAsNew([
    definition({
      actionDefinitionId: existing.actionDefinitionId,
      name: "微笑",
      motions: [motion({ motionId: existing.motions[0].motionId, motorId: "neck", nodeId: 12 })],
    }),
  ]);

  assert.equal(result.added.length, 1);
  assert.equal(result.skipped, 0);
  assert.equal(library.size, 2);
  assert.equal(library.revision, revisionBefore + 1);
  assert.equal(library.snapshot()[0], existing, "existing definitions and IDs must remain untouched");
  assert.notEqual(result.added[0].actionDefinitionId, existing.actionDefinitionId);
  assert.notEqual(result.added[0].actionDefinitionId, retired.actionDefinitionId);
  assert.notEqual(result.added[0].motions[0].motionId, existing.motions[0].motionId);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.added));
});

test("action-library append skips exact repeats and rejects conflicting names without partial changes", () => {
  const library = new ActionLibrary([
    definition({
      actionDefinitionId: "saved-blink",
      name: "眨眼",
      motions: [motion({ motionId: "saved-blink-motion" })],
    }),
  ]);
  const before = library.snapshot();
  const revisionBefore = library.revision;
  const repeated = library.appendAsNew([
    definition({
      actionDefinitionId: "foreign-blink",
      name: "眨眼",
      motions: [motion({ motionId: "foreign-blink-motion" })],
    }),
  ]);
  assert.equal(repeated.added.length, 0);
  assert.equal(repeated.skipped, 1);
  assert.deepEqual(library.snapshot(), before);
  assert.equal(library.revision, revisionBefore);

  assert.throws(() => library.appendAsNew([
    definition({
      actionDefinitionId: "foreign-smile",
      name: "微笑",
      motions: [motion({ motionId: "foreign-smile-motion", motorId: "neck", nodeId: 12 })],
    }),
    definition({
      actionDefinitionId: "changed-blink",
      name: "眨眼",
      motions: [motion({ motionId: "changed-blink-motion", signedSteps: -200 })],
    }),
  ]), /名称已存在但内容不同/);
  assert.deepEqual(library.snapshot(), before, "a later conflict must roll back the complete append batch");
  assert.equal(library.revision, revisionBefore);
});

test("named action library is capped at 128 definitions", () => {
  assert.equal(MAX_ACTION_DEFINITIONS, 128);
  const library = new ActionLibrary();
  for (let index = 0; index < MAX_ACTION_DEFINITIONS; index += 1) {
    library.add(definition({ name: `动作 ${index + 1}` }));
  }
  assert.throws(() => library.add(definition({ name: "超出上限" })), /最多可以保存 128 个命名动作/);
  assert.equal(library.size, MAX_ACTION_DEFINITIONS);
});

test("named action timeline allows repeated and overlapping placements", () => {
  const timeline = new NamedActionTimeline();
  const first = timeline.add(placement({ startMs: 1_000 }));
  const repeated = timeline.add(placement({ startMs: 1_000 }));
  const overlapping = timeline.add(placement({
    actionDefinitionId: "action-definition-000002",
    startMs: 1_000,
  }));
  assert.equal(timeline.size, 3);
  assert.notEqual(first.placementId, repeated.placementId);
  assert.deepEqual(
    timeline.snapshot().map(({ actionDefinitionId, startMs }) => [actionDefinitionId, startMs]),
    [
      ["action-definition-000001", 1_000],
      ["action-definition-000001", 1_000],
      ["action-definition-000002", 1_000],
    ],
  );
  assert.ok(Object.isFrozen(overlapping));
});

test("action tracks can be added, renamed, removed, and round-trip through snapshots", () => {
  const tracks = new ActionTrackCatalog();
  const face = tracks.add(actionTrack());
  const head = tracks.add(actionTrack({ name: "头部轨道" }));
  assert.notEqual(face.trackId, head.trackId);
  assert.equal(tracks.size, 2);

  const renamed = tracks.update(face.trackId, { name: "眼部轨道" });
  assert.equal(renamed.trackId, face.trackId);
  assert.equal(renamed.name, "眼部轨道");
  assert.throws(() => tracks.update(head.trackId, { name: "  眼部轨道  " }), /名称已存在/);

  const snapshot = tracks.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.deepEqual(new ActionTrackCatalog(snapshot).snapshot(), snapshot);
  assert.equal(tracks.remove(face.trackId), renamed);
  assert.equal(tracks.get(face.trackId), null);
  assert.equal(tracks.size, 1);
  assert.throws(() => tracks.add(actionTrack({ trackId: face.trackId })), /已使用/);
});

test("action track imports are atomic and do not reuse retired stable IDs", () => {
  const tracks = new ActionTrackCatalog([
    actionTrack({ trackId: "saved-eyes", name: "眼部轨道" }),
    actionTrack({ trackId: "saved-mouth", name: "嘴部轨道" }),
  ]);
  const before = tracks.snapshot();
  assert.throws(() => tracks.import([
    actionTrack({ trackId: "incoming-1", name: "重复轨道" }),
    actionTrack({ trackId: "incoming-2", name: "  重复轨道  " }),
  ]), /名称已存在/);
  assert.deepEqual(tracks.snapshot(), before);

  tracks.import([before[1]]);
  assert.deepEqual(tracks.snapshot(), [before[1]]);
  assert.throws(() => tracks.import(before), /trackId 已使用/);
  assert.deepEqual(tracks.snapshot(), [before[1]]);
});

test("action track validation normalizes names and enforces field and catalog limits", () => {
  assert.equal(MAX_ACTION_TRACK_NAME_LENGTH, 24);
  assert.equal(MAX_ACTION_TRACKS, 128);
  assert.deepEqual(validateActionTrack({ trackId: " saved-track ", name: "  嘴部轨道  " }), {
    trackId: "saved-track",
    name: "嘴部轨道",
  });
  assert.throws(() => validateActionTrack({ name: "" }), /名称/);
  assert.throws(
    () => validateActionTrack({ name: "轨".repeat(MAX_ACTION_TRACK_NAME_LENGTH + 1) }),
    /名称长度/,
  );
  assert.throws(() => validateActionTrack({ name: "轨道", extra: true }), /未知字段/);

  const tracks = new ActionTrackCatalog();
  for (let index = 0; index < MAX_ACTION_TRACKS; index += 1) {
    tracks.add(actionTrack({ name: `轨道 ${index + 1}` }));
  }
  assert.throws(() => tracks.add(actionTrack({ name: "超出上限" })), /最多.*128.*轨道/);
  assert.equal(tracks.size, MAX_ACTION_TRACKS);
});

test("same-time placements on different action tracks are preserved for parallel playback", () => {
  const timeline = new NamedActionTimeline();
  const blink = timeline.add(placement({
    placementId: "blink-placement",
    trackId: "track-eyes",
    startMs: 1_000,
  }));
  const smile = timeline.add(placement({
    placementId: "smile-placement",
    actionDefinitionId: "action-definition-000002",
    trackId: "track-mouth",
    startMs: 1_000,
  }));
  assert.deepEqual(
    timeline.snapshot().map(({ placementId, trackId, startMs }) => ({ placementId, trackId, startMs })),
    [
      { placementId: blink.placementId, trackId: "track-eyes", startMs: 1_000 },
      { placementId: smile.placementId, trackId: "track-mouth", startMs: 1_000 },
    ],
  );

  const moved = timeline.update(blink.placementId, { trackId: "track-mouth", startMs: 1_200 });
  assert.equal(moved.trackId, "track-mouth");
  assert.equal(moved.startMs, 1_200);
});

test("named action timeline is capped at 512 placements", () => {
  assert.equal(MAX_PLACEMENTS, 512);
  const timeline = new NamedActionTimeline();
  for (let index = 0; index < MAX_PLACEMENTS; index += 1) {
    timeline.add(placement({ startMs: index }));
  }
  assert.throws(() => timeline.add(placement()), /最多可以放置 512 个动作/);
  assert.equal(timeline.size, MAX_PLACEMENTS);
});

test("placement validation and updates enforce identity and bounded time", () => {
  assert.deepEqual(validatePlacement(placement({ placementId: "saved", startMs: "600" })), {
    placementId: "saved",
    actionDefinitionId: "action-definition-000001",
    startMs: 600,
  });
  for (const startMs of [-1, 1.5, MAX_START_MS + 1]) {
    assert.throws(() => validatePlacement(placement({ startMs })), /开始时间/);
  }
  assert.throws(() => validatePlacement({ ...placement(), extra: true }), /未知字段/);
  assert.equal(validatePlacement(placement({ trackId: " selected-track " })).trackId, "selected-track");
  assert.throws(() => validatePlacement(placement({ trackId: " " })), /trackId/);

  const timeline = new NamedActionTimeline();
  const created = timeline.add(placement());
  const updated = timeline.update(created.placementId, {
    actionDefinitionId: "action-definition-000002",
    startMs: 900,
  });
  assert.equal(updated.placementId, created.placementId);
  assert.equal(updated.actionDefinitionId, "action-definition-000002");
  assert.equal(updated.startMs, 900);
  assert.throws(
    () => timeline.update(created.placementId, { placementId: "other" }),
    /不能修改/,
  );
});

test("placement IDs are never reused by add or import", () => {
  const timeline = new NamedActionTimeline();
  const first = timeline.add(placement());
  assert.equal(first.placementId, "placement-000001");
  assert.equal(timeline.remove(first.placementId), first);
  assert.equal(timeline.add(placement({ startMs: 600 })).placementId, "placement-000002");
  assert.throws(() => timeline.add(placement({ placementId: first.placementId })), /已使用/);

  const before = timeline.snapshot();
  assert.throws(() => timeline.import([
    placement({ placementId: "duplicate" }),
    placement({ placementId: "duplicate", startMs: 700 }),
  ]), /重复/);
  assert.deepEqual(timeline.snapshot(), before);
});

test("timeline snapshots round-trip and import retires removed placement IDs", () => {
  const source = new NamedActionTimeline([
    placement({ placementId: "saved-1", startMs: 100 }),
    placement({ placementId: "saved-2", startMs: 100 }),
  ]);
  const snapshot = source.snapshot();
  assert.deepEqual(new NamedActionTimeline(snapshot).snapshot(), snapshot);
  assert.ok(Object.isFrozen(snapshot));

  source.import([snapshot[1]]);
  assert.equal(source.size, 1);
  assert.throws(() => source.import(snapshot), /placementId 已使用/);
  assert.deepEqual(source.snapshot(), [snapshot[1]]);
});

test("UMD build exposes action library, placement timeline, and track catalog models", () => {
  const filename = path.join(__dirname, "..", "src", "action-library.js");
  const source = fs.readFileSync(filename, "utf8");
  const context = vm.createContext({ FaceMotorRegistry: registry });
  vm.runInContext(source, context, { filename });
  assert.equal(typeof context.FaceActionLibrary.ActionLibrary, "function");
  assert.equal(typeof context.FaceActionLibrary.NamedActionTimeline, "function");
  assert.equal(typeof context.FaceActionLibrary.ActionTrackCatalog, "function");
  assert.equal(typeof context.FaceActionLibrary.deriveMotionLanes, "function");
  assert.equal(typeof context.FaceActionLibrary.validateActionPlaybackSettings, "function");
  assert.equal(typeof context.FaceActionLibrary.actionPlaybackStartMs, "function");
  assert.equal(typeof context.FaceActionLibrary.actionPlaybackDurationMs, "function");
  assert.equal(typeof context.FaceActionLibrary.motionForActionPlayback, "function");
  assert.ok(Object.isFrozen(context.FaceActionLibrary));
});
