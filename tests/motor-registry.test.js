"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const registry = require("../src/motor-registry");

test("registry exposes exactly 26 unique motors in the five requested groups", () => {
  assert.equal(registry.GROUPS.length, 5);
  assert.equal(registry.MOTORS.length, 26);
  assert.equal(registry.MOTOR_IDS.length, 26);
  assert.equal(new Set(registry.MOTOR_IDS).size, 26);
  assert.deepEqual(
    registry.GROUPS.map(({ id }) => id),
    ["brows", "left_eye", "right_eye", "mouth", "head"],
  );
  assert.deepEqual(
    Object.fromEntries(registry.GROUPS.map(({ id }) => [
      id,
      registry.MOTORS.filter((motor) => motor.group === id).length,
    ])),
    { brows: 4, left_eye: 4, right_eye: 4, mouth: 9, head: 5 },
  );
  assert.ok(registry.MOTORS.every((motor) => (
    typeof motor.id === "string"
    && typeof motor.label === "string"
    && registry.GROUPS.some(({ id }) => id === motor.group)
  )));
});

test("runtime group catalog includes the five built-ins and the legacy custom group", () => {
  assert.equal(registry.CUSTOM_GROUP_ID, "custom");
  assert.equal(registry.GROUPS.length, 5);
  assert.equal(registry.DEFAULT_GROUPS.length, 6);
  assert.deepEqual(registry.DEFAULT_GROUPS, [
    ...registry.GROUPS,
    { id: "custom", label: "自定义电机" },
  ]);
  assert.ok(Object.isFrozen(registry.DEFAULT_GROUPS));
  assert.ok(Object.isFrozen(registry.DEFAULT_GROUPS.at(-1)));
});

test("dynamic group catalogs are normalized strictly and remain immutable", () => {
  const groups = registry.normalizeGroupCatalog([
    ...registry.DEFAULT_GROUPS,
    { id: "custom_group_1", label: "  面颊  " },
  ]);
  assert.equal(registry.MAX_GROUPS, 64);
  assert.equal(registry.MAX_GROUP_LABEL_LENGTH, 32);
  assert.deepEqual(groups.at(-1), { id: "custom_group_1", label: "面颊" });
  assert.ok(Object.isFrozen(groups));
  assert.ok(Object.isFrozen(groups.at(-1)));
  assert.throws(() => { groups.at(-1).label = "changed"; }, TypeError);

  assert.throws(
    () => registry.normalizeGroupCatalog([
      { id: "custom_group_1", label: "甲" },
      { id: "custom_group_1", label: "乙" },
    ]),
    /内部 ID 重复/,
  );
  assert.throws(
    () => registry.normalizeGroupCatalog([
      { id: "custom_group_1", label: "Face" },
      { id: "custom_group_2", label: "ｆａｃｅ" },
    ]),
    /名称重复/,
  );
  assert.throws(
    () => registry.normalizeGroupCatalog([{ id: "Bad Group", label: "甲" }]),
    /分组内部 ID/,
  );
  assert.throws(
    () => registry.normalizeGroupCatalog([{ id: "valid_group", label: "" }]),
    /1–32/,
  );
  assert.throws(
    () => registry.normalizeGroupCatalog([{ id: "valid_group", label: "甲".repeat(33) }]),
    /1–32/,
  );
  assert.throws(
    () => registry.normalizeGroupCatalog([{ id: "valid_group", label: "甲", extra: true }]),
    /未知字段/,
  );
});

test("custom group helpers allocate stable IDs and reject duplicate names or overflow", () => {
  assert.equal(registry.nextCustomGroupId(registry.DEFAULT_GROUPS), "custom_group_1");
  assert.equal(registry.nextCustomGroupId([
    ...registry.DEFAULT_GROUPS,
    { id: "custom_group_2" },
    { id: "custom_group_9" },
  ]), "custom_group_10");

  const first = registry.createCustomGroup("  面颊  ");
  assert.deepEqual(first, { id: "custom_group_1", label: "面颊" });
  assert.ok(Object.isFrozen(first));
  assert.throws(() => registry.createCustomGroup("眉毛"), /名称重复/);

  const fullCatalog = Array.from({ length: registry.MAX_GROUPS }, (_, index) => ({
    id: `group_${index + 1}`,
    label: `分组 ${index + 1}`,
  }));
  assert.throws(
    () => registry.createCustomGroup("再加一组", fullCatalog),
    new RegExp(String(registry.MAX_GROUPS)),
  );
  assert.throws(
    () => registry.normalizeGroupCatalog([...fullCatalog, {
      id: "group_overflow",
      label: "溢出",
    }]),
    new RegExp(String(registry.MAX_GROUPS)),
  );
});

test("motor catalogs validate membership against a supplied dynamic group catalog", () => {
  const groups = registry.normalizeGroupCatalog([
    ...registry.DEFAULT_GROUPS,
    { id: "custom_group_1", label: "面颊" },
  ]);
  const motors = registry.normalizeMotorCatalog([
    { id: "cheek_motor", label: "面颊电机", group: "custom_group_1" },
  ], groups);
  assert.equal(motors[0].group, "custom_group_1");
  assert.throws(
    () => registry.normalizeMotorCatalog(motors),
    /未知电机分组/,
  );
  assert.throws(
    () => registry.normalizeMotorCatalog([
      { id: "orphan_motor", label: "孤立电机", group: "missing_group" },
    ], groups),
    /未知电机分组/,
  );

  const created = registry.createCustomMotor("附加电机", motors, groups);
  assert.equal(created.group, registry.CUSTOM_GROUP_ID);
});

test("registry contains every requested mechanical position", () => {
  assert.deepEqual(registry.MOTOR_IDS, [
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
    "head_yaw_2",
    "neck",
  ]);
  assert.equal(registry.motorsById.head_left_linkage.label, "头部左连杆");
  assert.deepEqual(
    {
      label: registry.motorsById.head_yaw_2.label,
      shortLabel: registry.motorsById.head_yaw_2.shortLabel,
      group: registry.motorsById.head_yaw_2.group,
      defaultNodeId: registry.motorsById.head_yaw_2.defaultNodeId,
    },
    { label: "扭头2", shortLabel: "扭头2", group: "head", defaultNodeId: null },
  );
  assert.equal(registry.motorsById.neck.label, "颈部");
  assert.equal(registry.motorsById.lower_jaw.id, "lower_jaw");
  assert.equal(registry.motorsById.lower_jaw.label, "下颚");
  assert.equal(registry.motorsById.lower_jaw.group, "mouth");
  assert.equal(registry.motorsById.lower_jaw.defaultNodeId, null);
});

test("all bindings begin with an explicitly unassigned node ID", () => {
  assert.ok(registry.MOTORS.every(({ defaultNodeId }) => defaultNodeId === null));
  const bindings = registry.defaultBindings();
  assert.deepEqual(Object.keys(bindings), registry.MOTOR_IDS);
  for (const motorId of registry.MOTOR_IDS) {
    assert.deepEqual(bindings[motorId], { motorId, nodeId: null });
  }

  bindings.left_brow_outer.nodeId = 12;
  assert.equal(registry.defaultBindings().left_brow_outer.nodeId, null);
  assert.deepEqual(registry.defaultBinding("custom_motor_42"), {
    motorId: "custom_motor_42",
    nodeId: null,
  });
  assert.deepEqual(registry.defaultBindings(["head_yaw", "custom_motor_42"]), {
    head_yaw: { motorId: "head_yaw", nodeId: null },
    custom_motor_42: { motorId: "custom_motor_42", nodeId: null },
  });
  assert.throws(() => registry.defaultBinding("Bad ID"), /内部 ID/);
  assert.throws(
    () => registry.defaultBindings(["custom_motor_1", "custom_motor_1"]),
    /不能重复/,
  );
});

test("dynamic catalogs are normalized strictly and remain immutable", () => {
  const catalog = registry.normalizeMotorCatalog([
    ...registry.MOTORS,
    {
      id: "custom_motor_1",
      label: "  眼神辅助  ",
      group: registry.CUSTOM_GROUP_ID,
    },
  ]);
  const custom = catalog.at(-1);
  assert.equal(registry.CUSTOM_GROUP_ID, "custom");
  assert.equal(registry.MAX_MOTORS, 128);
  assert.equal(registry.MAX_MOTOR_LABEL_LENGTH, 32);
  assert.equal(custom.id, "custom_motor_1");
  assert.equal(custom.label, "眼神辅助");
  assert.equal(custom.shortLabel, "眼神辅助");
  assert.equal(custom.group, "custom");
  assert.equal(custom.defaultNodeId, null);
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(custom));
  assert.throws(() => { custom.label = "changed"; }, TypeError);

  assert.throws(
    () => registry.normalizeMotorCatalog([
      { id: "custom_motor_1", label: "甲", group: "custom" },
      { id: "custom_motor_1", label: "乙", group: "custom" },
    ]),
    /内部 ID 重复/,
  );
  assert.throws(
    () => registry.normalizeMotorCatalog([
      { id: "custom_motor_1", label: "Motor A", group: "custom" },
      { id: "custom_motor_2", label: "ｍｏｔｏｒ ａ", group: "custom" },
    ]),
    /名称重复/,
  );
  assert.throws(
    () => registry.normalizeMotorCatalog([
      { id: "Custom Motor", label: "甲", group: "custom" },
    ]),
    /内部 ID/,
  );
  assert.throws(
    () => registry.normalizeMotorCatalog([
      { id: "custom_motor_1", label: "", group: "custom" },
    ]),
    /1–32/,
  );
  assert.throws(
    () => registry.normalizeMotorCatalog([
      { id: "custom_motor_1", label: "甲".repeat(33), group: "custom" },
    ]),
    /1–32/,
  );
  assert.throws(
    () => registry.normalizeMotorCatalog([
      { id: "custom_motor_1", label: "甲", group: "unknown" },
    ]),
    /未知电机分组/,
  );
  assert.throws(
    () => registry.normalizeMotorCatalog([
      { id: "custom_motor_1", label: "甲", group: "custom", nodeId: 1 },
    ]),
    /未知字段/,
  );
});

test("custom motor helpers allocate stable IDs and reject duplicate names or overflow", () => {
  assert.equal(registry.nextCustomMotorId(registry.MOTORS), "custom_motor_1");
  assert.equal(registry.nextCustomMotorId([
    ...registry.MOTORS,
    { id: "custom_motor_1" },
    { id: "custom_motor_7" },
  ]), "custom_motor_8");

  const first = registry.createCustomMotor("  下巴辅助  ", registry.MOTORS);
  assert.deepEqual(first, {
    id: "custom_motor_1",
    label: "下巴辅助",
    shortLabel: "下巴辅助",
    group: registry.CUSTOM_GROUP_ID,
    defaultNodeId: null,
  });
  assert.ok(Object.isFrozen(first));
  const renamed = registry.normalizeMotorCatalog([
    { ...first, label: "下巴辅助二", shortLabel: "下巴辅助二" },
  ])[0];
  assert.equal(renamed.id, first.id);
  assert.equal(renamed.label, "下巴辅助二");
  assert.throws(
    () => registry.createCustomMotor("左眉外侧", registry.MOTORS),
    /名称重复/,
  );

  const fullCatalog = Array.from({ length: registry.MAX_MOTORS }, (_, index) => ({
    id: `motor_${index + 1}`,
    label: `电机 ${index + 1}`,
    group: registry.CUSTOM_GROUP_ID,
  }));
  assert.throws(
    () => registry.createCustomMotor("再加一个", fullCatalog),
    new RegExp(String(registry.MAX_MOTORS)),
  );
  assert.throws(
    () => registry.normalizeMotorCatalog([...fullCatalog, {
      id: "motor_overflow",
      label: "溢出",
      group: registry.CUSTOM_GROUP_ID,
    }]),
    new RegExp(String(registry.MAX_MOTORS)),
  );
});

test("static catalog data is immutable", () => {
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.GROUPS));
  assert.ok(Object.isFrozen(registry.MOTORS));
  assert.ok(Object.isFrozen(registry.MOTORS[0]));
  assert.throws(() => {
    registry.MOTORS[0].label = "changed";
  }, TypeError);
  assert.equal(registry.normalizeMotorCatalog(registry.MOTORS).length, 26);
});

test("UMD build exposes the same catalog to a browser global", () => {
  const filename = path.join(__dirname, "..", "src", "motor-registry.js");
  const source = fs.readFileSync(filename, "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename });
  assert.equal(context.FaceMotorRegistry.MOTORS.length, 26);
  assert.equal(context.FaceMotorRegistry.defaultBinding("head_yaw").nodeId, null);
  assert.equal(context.FaceMotorRegistry.defaultBinding("head_yaw_2").nodeId, null);
  assert.equal(context.FaceMotorRegistry.createCustomMotor("附加电机").id, "custom_motor_1");
});
