"use strict";

(function exposeMotorRegistry(root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  if (root) root.FaceMotorRegistry = value;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const CUSTOM_GROUP_ID = "custom";
  const MAX_GROUPS = 64;
  const MAX_MOTORS = 128;
  const MAX_GROUP_ID_LENGTH = 64;
  const MAX_GROUP_LABEL_LENGTH = 32;
  const MAX_MOTOR_ID_LENGTH = 64;
  const MAX_MOTOR_LABEL_LENGTH = 32;
  const GROUP_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
  const CUSTOM_GROUP_ID_PATTERN = /^custom_group_(\d+)$/;
  const MOTOR_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
  const CUSTOM_MOTOR_ID_PATTERN = /^custom_motor_(\d+)$/;
  const group = (id, label) => Object.freeze({ id, label });
  const motor = (id, label, shortLabel, groupId) => Object.freeze({
    id,
    label,
    shortLabel,
    group: groupId,
    // A registry entry describes a mechanical location, not one installation.
    // Node IDs therefore always start unbound.
    defaultNodeId: null,
  });

  const GROUPS = Object.freeze([
    group("brows", "眉毛"),
    group("left_eye", "左眼"),
    group("right_eye", "右眼"),
    group("mouth", "嘴部"),
    group("head", "头部与颈部"),
  ]);

  // GROUPS remains the five built-in mechanical categories for compatibility.
  // Runtime catalogs use DEFAULT_GROUPS, which also exposes the catch-all group
  // used by motors created before user-defined groups were available.
  const DEFAULT_GROUPS = Object.freeze([
    ...GROUPS,
    group(CUSTOM_GROUP_ID, "自定义电机"),
  ]);

  const MOTORS = Object.freeze([
    motor("left_brow_outer", "左眉外侧", "左眉外", "brows"),
    motor("left_brow_inner", "左眉内侧", "左眉内", "brows"),
    motor("right_brow_inner", "右眉内侧", "右眉内", "brows"),
    motor("right_brow_outer", "右眉外侧", "右眉外", "brows"),

    motor("left_upper_eyelid", "左眼上眼皮", "左上睑", "left_eye"),
    motor("left_lower_eyelid", "左眼下眼皮", "左下睑", "left_eye"),
    motor("left_eye_horizontal", "左眼球左右", "左眼左右", "left_eye"),
    motor("left_eye_vertical", "左眼球上下", "左眼上下", "left_eye"),

    motor("right_upper_eyelid", "右眼上眼皮", "右上睑", "right_eye"),
    motor("right_lower_eyelid", "右眼下眼皮", "右下睑", "right_eye"),
    motor("right_eye_horizontal", "右眼球左右", "右眼左右", "right_eye"),
    motor("right_eye_vertical", "右眼球上下", "右眼上下", "right_eye"),

    motor("left_mouth_corner_a", "左嘴角 A", "左嘴角 A", "mouth"),
    motor("left_mouth_corner_b", "左嘴角 B", "左嘴角 B", "mouth"),
    motor("right_mouth_corner_a", "右嘴角 A", "右嘴角 A", "mouth"),
    motor("right_mouth_corner_b", "右嘴角 B", "右嘴角 B", "mouth"),
    motor("upper_lip_left", "上嘴唇左", "上唇左", "mouth"),
    motor("upper_lip_right", "上嘴唇右", "上唇右", "mouth"),
    motor("lower_lip_left", "下嘴唇左", "下唇左", "mouth"),
    motor("lower_lip_right", "下嘴唇右", "下唇右", "mouth"),
    motor("lower_jaw", "下颚", "下颚", "mouth"),

    motor("head_left_linkage", "头部左连杆", "左连杆", "head"),
    motor("head_right_linkage", "头部右连杆", "右连杆", "head"),
    motor("head_yaw", "扭头", "扭头", "head"),
    motor("head_yaw_2", "扭头2", "扭头2", "head"),
    motor("neck", "颈部", "颈部", "head"),
  ]);

  const MOTOR_IDS = Object.freeze(MOTORS.map(({ id }) => id));
  const motorsById = Object.freeze(Object.fromEntries(
    MOTORS.map((entry) => [entry.id, entry]),
  ));

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

  function normalizeMotorId(value) {
    if (
      typeof value !== "string"
      || value.length < 1
      || value.length > MAX_MOTOR_ID_LENGTH
      || value !== value.trim()
      || !MOTOR_ID_PATTERN.test(value)
    ) {
      throw new TypeError(
        `电机内部 ID 必须是 1–${MAX_MOTOR_ID_LENGTH} 位小写字母、数字、下划线或连字符，且以字母开头`,
      );
    }
    return value;
  }

  function normalizeMotorLabel(value, fieldName = "电机名称") {
    if (typeof value !== "string") throw new TypeError(`${fieldName}必须是字符串`);
    const label = value.trim();
    const length = [...label].length;
    if (length < 1 || length > MAX_MOTOR_LABEL_LENGTH) {
      throw new RangeError(`${fieldName}长度必须为 1–${MAX_MOTOR_LABEL_LENGTH} 个字符`);
    }
    return label;
  }

  function normalizeGroupId(value) {
    if (
      typeof value !== "string"
      || value.length < 1
      || value.length > MAX_GROUP_ID_LENGTH
      || value !== value.trim()
      || !GROUP_ID_PATTERN.test(value)
    ) {
      throw new TypeError(
        `分组内部 ID 必须是 1–${MAX_GROUP_ID_LENGTH} 位小写字母、数字、下划线或连字符，且以字母开头`,
      );
    }
    return value;
  }

  function normalizeGroupLabel(value, fieldName = "分组名称") {
    if (typeof value !== "string") throw new TypeError(`${fieldName}必须是字符串`);
    const label = value.trim();
    const length = [...label].length;
    if (length < 1 || length > MAX_GROUP_LABEL_LENGTH) {
      throw new RangeError(`${fieldName}长度必须为 1–${MAX_GROUP_LABEL_LENGTH} 个字符`);
    }
    return label;
  }

  function comparableLabel(value) {
    return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
  }

  function normalizeGroupCatalog(value) {
    if (!Array.isArray(value)) throw new TypeError("分组目录必须是数组");
    if (value.length > MAX_GROUPS) {
      throw new RangeError(`分组目录最多包含 ${MAX_GROUPS} 个分组`);
    }
    const usedIds = new Set();
    const usedLabels = new Set();
    const normalized = value.map((rawEntry, index) => {
      const entry = plainRecord(rawEntry, `第 ${index + 1} 个分组`);
      onlyKeys(entry, new Set(["id", "label"]), `第 ${index + 1} 个分组`);
      const id = normalizeGroupId(entry.id);
      if (usedIds.has(id)) throw new RangeError(`分组内部 ID 重复: ${id}`);
      usedIds.add(id);
      const label = normalizeGroupLabel(entry.label);
      const labelKey = comparableLabel(label);
      if (usedLabels.has(labelKey)) throw new RangeError(`分组名称重复: ${label}`);
      usedLabels.add(labelKey);
      return group(id, label);
    });
    return Object.freeze(normalized);
  }

  function normalizeMotorCatalog(value, groups = DEFAULT_GROUPS) {
    if (!Array.isArray(value)) throw new TypeError("电机目录必须是数组");
    if (value.length > MAX_MOTORS) {
      throw new RangeError(`电机目录最多包含 ${MAX_MOTORS} 个电机`);
    }
    const validGroupIds = new Set(
      normalizeGroupCatalog(groups).map(({ id }) => id),
    );
    const usedIds = new Set();
    const usedLabels = new Set();
    const normalized = value.map((rawEntry, index) => {
      const entry = plainRecord(rawEntry, `第 ${index + 1} 个电机`);
      onlyKeys(
        entry,
        new Set(["id", "label", "shortLabel", "group", "defaultNodeId"]),
        `第 ${index + 1} 个电机`,
      );
      const id = normalizeMotorId(entry.id);
      if (usedIds.has(id)) throw new RangeError(`电机内部 ID 重复: ${id}`);
      usedIds.add(id);
      const label = normalizeMotorLabel(entry.label);
      const labelKey = comparableLabel(label);
      if (usedLabels.has(labelKey)) throw new RangeError(`电机名称重复: ${label}`);
      usedLabels.add(labelKey);
      const shortLabel = entry.shortLabel === undefined
        ? label
        : normalizeMotorLabel(entry.shortLabel, "电机短名称");
      const groupId = normalizeGroupId(entry.group);
      if (!validGroupIds.has(groupId)) {
        throw new RangeError(`未知电机分组: ${groupId}`);
      }
      if (entry.defaultNodeId !== undefined && entry.defaultNodeId !== null) {
        throw new TypeError("电机目录不能预设 CAN 节点 ID");
      }
      return motor(id, label, shortLabel, groupId);
    });
    return Object.freeze(normalized);
  }

  function motorIdsFrom(value) {
    if (!Array.isArray(value)) throw new TypeError("电机列表必须是数组");
    if (value.length > MAX_MOTORS) {
      throw new RangeError(`电机列表最多包含 ${MAX_MOTORS} 个电机`);
    }
    const ids = value.map((entry) => normalizeMotorId(
      typeof entry === "string" ? entry : plainRecord(entry, "电机").id,
    ));
    if (new Set(ids).size !== ids.length) throw new RangeError("电机内部 ID 不能重复");
    return ids;
  }

  function groupIdsFrom(value) {
    if (!Array.isArray(value)) throw new TypeError("分组列表必须是数组");
    if (value.length > MAX_GROUPS) {
      throw new RangeError(`分组列表最多包含 ${MAX_GROUPS} 个分组`);
    }
    const ids = value.map((entry) => normalizeGroupId(
      typeof entry === "string" ? entry : plainRecord(entry, "分组").id,
    ));
    if (new Set(ids).size !== ids.length) throw new RangeError("分组内部 ID 不能重复");
    return ids;
  }

  function nextCustomGroupId(catalog = DEFAULT_GROUPS) {
    const ids = groupIdsFrom(catalog);
    let highest = 0;
    for (const id of ids) {
      const match = CUSTOM_GROUP_ID_PATTERN.exec(id);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    let sequence = highest + 1;
    let candidate = `custom_group_${sequence}`;
    const usedIds = new Set(ids);
    while (usedIds.has(candidate)) {
      sequence += 1;
      candidate = `custom_group_${sequence}`;
    }
    return normalizeGroupId(candidate);
  }

  function createCustomGroup(label, catalog = DEFAULT_GROUPS) {
    const normalizedCatalog = normalizeGroupCatalog(catalog);
    if (normalizedCatalog.length >= MAX_GROUPS) {
      throw new RangeError(`分组目录最多包含 ${MAX_GROUPS} 个分组`);
    }
    const normalizedLabel = normalizeGroupLabel(label);
    const labelKey = comparableLabel(normalizedLabel);
    if (normalizedCatalog.some((entry) => comparableLabel(entry.label) === labelKey)) {
      throw new RangeError(`分组名称重复: ${normalizedLabel}`);
    }
    return group(nextCustomGroupId(normalizedCatalog), normalizedLabel);
  }

  function nextCustomMotorId(catalog = MOTORS) {
    const ids = motorIdsFrom(catalog);
    let highest = 0;
    for (const id of ids) {
      const match = CUSTOM_MOTOR_ID_PATTERN.exec(id);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    let sequence = highest + 1;
    let candidate = `custom_motor_${sequence}`;
    const usedIds = new Set(ids);
    while (usedIds.has(candidate)) {
      sequence += 1;
      candidate = `custom_motor_${sequence}`;
    }
    return normalizeMotorId(candidate);
  }

  function createCustomMotor(label, catalog = MOTORS, groups = DEFAULT_GROUPS) {
    const normalizedCatalog = normalizeMotorCatalog(catalog, groups);
    if (normalizedCatalog.length >= MAX_MOTORS) {
      throw new RangeError(`电机目录最多包含 ${MAX_MOTORS} 个电机`);
    }
    const normalizedLabel = normalizeMotorLabel(label);
    const labelKey = comparableLabel(normalizedLabel);
    if (normalizedCatalog.some((entry) => comparableLabel(entry.label) === labelKey)) {
      throw new RangeError(`电机名称重复: ${normalizedLabel}`);
    }
    return motor(
      nextCustomMotorId(normalizedCatalog),
      normalizedLabel,
      normalizedLabel,
      CUSTOM_GROUP_ID,
    );
  }

  function defaultBinding(motorId) {
    const normalizedMotorId = normalizeMotorId(motorId);
    return {
      motorId: normalizedMotorId,
      nodeId: null,
    };
  }

  function defaultBindings(catalog = MOTOR_IDS) {
    return Object.fromEntries(motorIdsFrom(catalog).map((motorId) => [
      motorId,
      defaultBinding(motorId),
    ]));
  }

  return Object.freeze({
    CUSTOM_GROUP_ID,
    MAX_GROUPS,
    MAX_MOTORS,
    MAX_GROUP_ID_LENGTH,
    MAX_GROUP_LABEL_LENGTH,
    MAX_MOTOR_ID_LENGTH,
    MAX_MOTOR_LABEL_LENGTH,
    GROUPS,
    DEFAULT_GROUPS,
    MOTORS,
    MOTOR_IDS,
    motorsById,
    normalizeGroupId,
    normalizeGroupLabel,
    normalizeGroupCatalog,
    nextCustomGroupId,
    createCustomGroup,
    normalizeMotorId,
    normalizeMotorLabel,
    normalizeMotorCatalog,
    nextCustomMotorId,
    createCustomMotor,
    defaultBinding,
    defaultBindings,
  });
}));
