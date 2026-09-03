"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  BridgeClient,
  MOTION_ACK_RETRY_WINDOW_MS,
  expectedAck,
} = require("../src/bridge-client");

test("servo move expects the closed motion ACK class", () => {
  assert.deepEqual(expectedAck("servo_move"), {
    commandClass: 2,
    opcode: 0,
  });
});

test("homing expects the addressed control ACK", () => {
  assert.deepEqual(expectedAck("homing_start"), {
    commandClass: 3,
    opcode: 0x0D,
  });
});

test("ACK wait is sequence-aware and has a bounded timeout", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "fixtures", "wrong_ack_bridge.py"),
  });
  context.after(async () => bridge.close());
  await assert.rejects(
    bridge.requestWithAck("ping", {}, 250),
    /等待设备 ACK 超时/,
  );
});

test("lost motion ACK is recovered by replaying the original sequence", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "fixtures", "motion_retry_bridge.py"),
  });
  context.after(async () => bridge.close());

  const motion = await bridge.requestWithAck("move", {
    closed: false,
    direction: 0,
    count: 123,
    speedLevel: 10,
    accelerationLevel: 20,
  }, 700);

  assert.equal(motion.sequence, 7);
  assert.equal(motion.nodeId, 17);
  assert.equal(motion.ack.sequence, 7);
  assert.equal(motion.ack.commandClass, 1);
  assert.equal(Object.hasOwn(motion, "replayId"), false);
});

test("lost servo ACK replays the exact motion identity and accepts class 2", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "fixtures", "motion_retry_bridge.py"),
  });
  context.after(async () => bridge.close());

  const motion = await bridge.requestWithAck("servo_move", {
    nodeId: 17,
    angle: 180,
    speedLevel: 10,
    accelerationLevel: 20,
  }, 700);

  assert.equal(motion.sequence, 7);
  assert.equal(motion.angle, 180);
  assert.equal(motion.nodeId, 17);
  assert.equal(motion.ack.sequence, 7);
  assert.equal(motion.ack.commandClass, 2);
  assert.equal(Object.hasOwn(motion, "replayId"), false);
});

test("addressed STOP cancels a pending servo replay without latching uncertain", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "fixtures", "motion_retry_bridge.py"),
  });
  context.after(async () => bridge.close());

  const pending = bridge.requestWithAck("servo_move", {
    nodeId: 17,
    angle: 359,
    speedLevel: 10,
    accelerationLevel: 20,
  }, 900);
  const cancelled = assert.rejects(pending, (error) => {
    assert.equal(error.code, "MOTION_SEND_CANCELLED");
    assert.equal(error.nodeId, 17);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await bridge.requestWithAck("stop", { nodeId: 17, immediate: true });
  await cancelled;

  const afterStop = await bridge.requestWithAck("servo_move", {
    nodeId: 17,
    angle: 180,
    speedLevel: 10,
    accelerationLevel: 20,
  }, 700);
  assert.equal(afterStop.nodeId, 17);
  assert.equal(afterStop.ack.commandClass, 2);
});

test("addressed CLEAR_FAULTS cancels pending motion replay and permits new motion", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "fixtures", "motion_retry_bridge.py"),
  });
  context.after(async () => bridge.close());

  const pending = bridge.requestWithAck("move", {
    nodeId: 17,
    closed: false,
    direction: 0,
    count: 999,
    speedLevel: 10,
    accelerationLevel: 20,
  }, 900);
  const cancelled = assert.rejects(pending, (error) => {
    assert.equal(error.code, "MOTION_SEND_CANCELLED");
    assert.equal(error.nodeId, 17);
    assert.match(error.message, /CLEAR_FAULTS.*未继续 MOVE 重放/);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const cleared = await bridge.requestWithAck("clear_faults", {
    nodeId: 17,
    mask: 0,
  });
  assert.equal(cleared.ack.opcode, 4);
  await cancelled;

  const afterClear = await bridge.requestWithAck("move", {
    nodeId: 17,
    closed: false,
    direction: 0,
    count: 123,
    speedLevel: 10,
    accelerationLevel: 20,
  }, 700);
  assert.equal(afterClear.nodeId, 17);
});

test("addressed STOP cancels only that node's pending MOVE replay", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "fixtures", "motion_retry_bridge.py"),
  });
  context.after(async () => bridge.close());

  const cancelledMotion = bridge.requestWithAck("move", {
    nodeId: 17,
    closed: false,
    direction: 0,
    count: 999,
    speedLevel: 10,
    accelerationLevel: 20,
  }, 900);
  const otherNodeMotion = bridge.requestWithAck("move", {
    nodeId: 18,
    closed: false,
    direction: 0,
    count: 123,
    speedLevel: 10,
    accelerationLevel: 20,
  }, 900);
  const cancellation = assert.rejects(cancelledMotion, (error) => {
    assert.equal(error.code, "MOTION_SEND_CANCELLED");
    assert.equal(error.nodeId, 17);
    assert.match(error.message, /STOP.*未继续 MOVE 重放/);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await bridge.requestWithAck("stop", { nodeId: 17, immediate: true });
  await cancellation;
  const otherResult = await otherNodeMotion;
  assert.equal(otherResult.nodeId, 18);

  const afterStop = await bridge.requestWithAck("move", {
    nodeId: 17,
    closed: false,
    direction: 0,
    count: 123,
    speedLevel: 10,
    accelerationLevel: 20,
  }, 900);
  assert.equal(afterStop.nodeId, 17);
});

test("broadcast STOP cancels pending MOVE replay on every node without latching uncertain", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "fixtures", "motion_retry_bridge.py"),
  });
  context.after(async () => bridge.close());
  const payload = {
    closed: false,
    direction: 0,
    count: 999,
    speedLevel: 10,
    accelerationLevel: 20,
  };
  const first = bridge.requestWithAck("move", { ...payload, nodeId: 17 }, 900);
  const second = bridge.requestWithAck("move", { ...payload, nodeId: 18 }, 900);
  const cancellations = [first, second].map((motion) => (
    assert.rejects(motion, (error) => {
      assert.equal(error.code, "MOTION_SEND_CANCELLED");
      assert.match(error.message, /广播 STOP.*未继续 MOVE 重放/);
      return true;
    })
  ));
  await new Promise((resolve) => setTimeout(resolve, 60));
  await bridge.requestWithAck("stop", { broadcast: true, immediate: true });
  await Promise.all(cancellations);
  const afterBroadcast = await bridge.requestWithAck("move", {
    ...payload,
    nodeId: 18,
    count: 123,
  }, 900);
  assert.equal(afterBroadcast.nodeId, 18);
});

test("unknown motion state is isolated per node until that node is stopped", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "fixtures", "motion_retry_bridge.py"),
  });
  context.after(async () => bridge.close());
  const uncertainMotion = {
    nodeId: 17,
    closed: false,
    direction: 0,
    count: 999,
    speedLevel: 10,
    accelerationLevel: 20,
  };

  await assert.rejects(
    bridge.requestWithAck("move", uncertainMotion, 600),
    /执行状态不确定.*阻止生成新的运动序号.*STOP 或 DISABLE/,
  );
  const otherNode = await bridge.requestWithAck("move", {
    ...uncertainMotion,
    nodeId: 18,
    count: 123,
  }, 700);
  assert.equal(otherNode.nodeId, 18);

  await bridge.requestWithAck("stop", {
    nodeId: 18,
    immediate: true,
  });
  await bridge.requestWithAck("stop", {
    broadcast: true,
    immediate: true,
  });
  await assert.rejects(
    bridge.requestWithAck("move", {
      ...uncertainMotion,
      count: 1000,
    }, 600),
    /节点 17 .*执行状态不确定.*阻止生成新的运动序号/,
  );

  await bridge.requestWithAck("stop", { nodeId: 17, immediate: true });
  const afterStop = await bridge.requestWithAck("move", {
    ...uncertainMotion,
    count: 123,
  }, 700);
  assert.equal(afterStop.sequence, 9);
  assert.equal(afterStop.nodeId, 17);
  assert.ok(MOTION_ACK_RETRY_WINDOW_MS < 2000);
});

test("ACK identity includes node and rejects an old same-node CAN session", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "fixtures", "multi_node_ack_bridge.py"),
  });
  context.after(async () => bridge.close());

  await bridge.request("connect", {
    interface: "sim0",
    nodeId: 17,
    simulate: true,
  });
  await assert.rejects(
    bridge.requestWithAck("ping", {
      nodeId: 17,
      ackNodeId: 18,
      testSequence: 7,
    }, 250),
    /等待设备 ACK 超时/,
  );

  await bridge.request("connect", {
    interface: "sim0",
    nodeId: 17,
    simulate: true,
  });
  await assert.rejects(
    bridge.requestWithAck("ping", {
      nodeId: 17,
      ackSessionEpoch: 1,
      testSequence: 7,
    }, 250),
    /等待设备 ACK 超时/,
  );
});

test("status_many returns without waiting for an ACK", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "fixtures", "multi_node_ack_bridge.py"),
  });
  context.after(async () => bridge.close());

  const result = await bridge.requestWithAck("status_many", {
    nodeIds: [17, 18, 42],
    flags: 7,
  }, 250);
  assert.deepEqual(result, { nodeIds: [17, 18, 42], flags: 7 });
});

test("pre-send motion validation errors do not latch an unknown state", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "..", "bridge", "lumdriver_bridge.py"),
  });
  context.after(async () => bridge.close());
  await bridge.request("connect", {
    interface: "sim0",
    nodeId: 17,
    simulate: true,
  });

  await assert.rejects(
    bridge.requestWithAck("move", {
      closed: false,
      direction: 0,
      count: 0,
      speedLevel: 10,
      accelerationLevel: 20,
    }),
    /微步数/,
  );
  const valid = await bridge.requestWithAck("move", {
    closed: false,
    direction: 0,
    count: 1,
    speedLevel: 10,
    accelerationLevel: 20,
  });
  assert.equal(valid.sequence, 0);
  assert.equal(valid.ack.ok, true);
});

test("invalid servo fields are validation errors and do not latch motion uncertainty", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "..", "bridge", "lumdriver_bridge.py"),
  });
  context.after(async () => bridge.close());
  await bridge.request("connect", {
    interface: "sim0",
    nodeId: 17,
    simulate: true,
  });
  await bridge.requestWithAck("calibration_start", {
    currentMa: 250,
    persist: false,
  });
  const base = {
    angle: 180,
    speedLevel: 10,
    accelerationLevel: 20,
  };
  for (const params of [
    { ...base, angle: -1 },
    { ...base, angle: 360 },
    { ...base, angle: true },
    { ...base, speedLevel: 0 },
    { ...base, accelerationLevel: 101 },
  ]) {
    await assert.rejects(
      bridge.requestWithAck("servo_move", params),
      (error) => {
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.equal(error.motionStateUncertain, undefined);
        return true;
      },
    );
  }
  const valid = await bridge.requestWithAck("servo_move", base);
  assert.equal(valid.sequence, 0);
  assert.equal(valid.angle, 180);
  assert.equal(valid.ack.commandClass, 2);
  assert.equal(valid.ack.ok, true);
});

test("Python bridge simulation exercises V2.6 status D and format 6 FIFO motion", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "..", "bridge", "lumdriver_bridge.py"),
  });
  context.after(async () => bridge.close());
  const events = [];
  bridge.on("event", (event) => events.push(event));

  const connected = await bridge.request("connect", {
    interface: "sim0",
    nodeId: 17,
    simulate: true,
  });
  assert.deepEqual(connected, { connected: true, nodeId: 17, simulate: true });
  const pingRequest = await bridge.requestWithAck("ping");
  assert.equal(pingRequest.ack.sequence, pingRequest.sequence);
  assert.equal(pingRequest.ack.commandClass, 3);
  assert.equal(pingRequest.ack.opcode, 1);
  await bridge.requestWithAck("status", { flags: 31 });
  await bridge.requestWithAck("param_get", { parameterId: 0x11 });
  const motion = await bridge.requestWithAck("move", {
    closed: false,
    direction: 0,
    count: 123,
    speedLevel: 10,
    accelerationLevel: 20,
  });
  const secondMotion = await bridge.requestWithAck("move", {
    closed: false,
    direction: 1,
    count: 50,
    speedLevel: 11,
    accelerationLevel: 21,
  });
  const thirdMotion = await bridge.requestWithAck("move", {
    closed: false,
    direction: 0,
    count: 25,
    speedLevel: 12,
    accelerationLevel: 22,
  });
  await bridge.requestWithAck("status", { flags: 8 });
  await assert.rejects(
    bridge.request("move", {
      closed: false,
      direction: 0,
      count: 0,
      speedLevel: 10,
      accelerationLevel: 20,
    }),
    /微步数/,
  );

  const ping = events.find((event) => (
    event.event === "ack" && event.data.firmwareVersion === "3.2.1"
  ));
  assert.ok(ping);
  assert.equal(ping.data.hardwareProductId, 1);
  assert.equal(ping.data.hardwareModel, "分离式驱动板");
  assert.deepEqual(
    events.filter((event) => event.event === "status").map((event) => event.data.part),
    ["A", "B", "C", "D", "E", "D"],
  );
  const limits = events.find((event) => (
    event.event === "status" && event.data.part === "E"
  ));
  assert.deepEqual({
    present: limits.data.limitSwitchPresentMask,
    active: limits.data.limitSwitchActiveMask,
    format: limits.data.limitSwitchFormatVersion,
    homingSupported: limits.data.homingSupported,
    homingState: limits.data.homingState,
    homingLimit: limits.data.homingLimitSwitch,
    homingDirection: limits.data.homingDirection,
    homingSpeed: limits.data.homingSpeedLevel,
  }, {
    present: 3,
    active: 0,
    format: 2,
    homingSupported: true,
    homingState: 0,
    homingLimit: 1,
    homingDirection: 1,
    homingSpeed: 10,
  });
  const parameter = events.find((event) => (
    event.event === "ack" && event.data.parameterId === 0x11
  ));
  assert.equal(parameter.data.value, 128);
  assert.deepEqual(motion, {
    sequence: 0,
    speedLevel: 10,
    accelerationLevel: 20,
    nodeId: 17,
    ack: motion.ack,
  });
  assert.equal(motion.ack.value, 1);
  assert.equal(secondMotion.sequence, 1);
  assert.equal(secondMotion.ack.value, 2);
  assert.equal(thirdMotion.sequence, 2);
  assert.equal(thirdMotion.ack.value, 3);
  assert.equal(motion.ack.sequence, motion.sequence);
  assert.equal(motion.ack.commandClass, 1);
  const motionFrame = events.find((event) => (
    event.event === "frame"
    && event.data.direction === "tx"
    && event.data.arbitrationId === 0x211
  ));
  assert.equal(
    motionFrame.data.dataHex,
    "AC 7B 00 00 0A 00 14 C5",
  );
  const motionAck = events.find((event) => (
    event.event === "ack"
    && event.data.commandClass === 1
    && event.data.sequence === 0
  ));
  assert.equal(motionAck.data.ok, true);
  const queueStatus = events.filter(
    (event) => event.event === "status" && event.data.part === "D",
  ).at(-1);
  assert.equal(queueStatus.data.queueOutstanding, 3);
  assert.equal(queueStatus.data.queueCapacity, 64);
  assert.equal(queueStatus.data.activeSequence, 0);
  assert.equal(queueStatus.data.queueActive, true);
  assert.equal(queueStatus.data.handoffPending, false);
  assert.equal(queueStatus.data.relativeRemaining, 98);
  await bridge.requestWithAck("status", { flags: 8 });
  const negativeQueueStatus = events.filter(
    (event) => event.event === "status" && event.data.part === "D",
  ).at(-1);
  assert.equal(negativeQueueStatus.data.queueOutstanding, 2);
  assert.equal(negativeQueueStatus.data.activeSequence, 1);
  assert.equal(negativeQueueStatus.data.relativeRemaining, -25);
  await bridge.requestWithAck("stop", { immediate: false });
  await bridge.requestWithAck("status", { flags: 8 });
  const stoppedQueue = events.filter(
    (event) => event.event === "status" && event.data.part === "D",
  ).at(-1);
  assert.equal(stoppedQueue.data.queueOutstanding, 0);
  assert.equal(stoppedQueue.data.activeSequence, null);
  assert.equal(stoppedQueue.data.relativeRemaining, 0);
  assert.equal(events.filter((event) => event.event === "error").length, 0);
});

test("Protocol 6 simulation locks position and requires explicit unlock", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "..", "bridge", "lumdriver_bridge.py"),
  });
  context.after(async () => bridge.close());
  const events = [];
  bridge.on("event", (event) => events.push(event));

  await bridge.request("connect", {
    interface: "sim0",
    nodeId: 17,
    simulate: true,
  });
  await bridge.requestWithAck("calibration_start", {
    currentMa: 250,
    persist: true,
  });
  const locked = await bridge.requestWithAck("position_lock");
  assert.equal(locked.ack.opcode, 0x0B);
  assert.equal(locked.ack.commandClass, 3);
  await bridge.requestWithAck("status", { flags: 7 });

  const lockedStatus = events.filter(
    (event) => event.event === "status" && event.data.part === "A",
  ).at(-1);
  assert.equal(lockedStatus.data.positionLockActive, true);
  assert.equal(lockedStatus.data.closedLoopActive, true);
  const positionStatus = events.filter(
    (event) => event.event === "status" && event.data.part === "C",
  ).at(-1);
  assert.equal(positionStatus.data.positionError, 0);
  assert.equal(positionStatus.data.appliedCurrentMa, 200);
  assert.equal(Object.hasOwn(positionStatus.data, "followingError"), false);

  const lockFrame = events.find((event) => (
    event.event === "frame"
    && event.data.direction === "tx"
    && event.data.data[0] === 0x0B
  ));
  assert.ok(lockFrame);
  assert.deepEqual(lockFrame.data.data.slice(2), [0, 0, 0, 0, 0, 0]);
  await assert.rejects(
    bridge.requestWithAck("move", {
      closed: true,
      direction: 0,
      count: 100,
      speedLevel: 10,
      accelerationLevel: 10,
    }),
    /当前状态不允许/,
  );

  const unlocked = await bridge.requestWithAck("position_unlock");
  assert.equal(unlocked.ack.opcode, 0x0C);
  await bridge.requestWithAck("status", { flags: 1 });
  const unlockedStatus = events.filter(
    (event) => event.event === "status" && event.data.part === "A",
  ).at(-1);
  assert.equal(unlockedStatus.data.positionLockActive, false);

  await bridge.requestWithAck("position_lock");
  await bridge.requestWithAck("stop", { immediate: true });
  await bridge.requestWithAck("status", { flags: 1 });
  const stoppedStatus = events.filter(
    (event) => event.event === "status" && event.data.part === "A",
  ).at(-1);
  assert.equal(stoppedStatus.data.positionLockActive, false);
});

test("simulation CLEAR_FAULTS mirrors the MCU actuator cancellation boundary", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "..", "bridge", "lumdriver_bridge.py"),
  });
  context.after(async () => bridge.close());
  const events = [];
  bridge.on("event", (event) => events.push(event));

  await bridge.request("connect", {
    interface: "sim0",
    nodeId: 17,
    simulate: true,
  });
  await bridge.requestWithAck("move", {
    nodeId: 17,
    closed: false,
    direction: 0,
    count: 200,
    speedLevel: 10,
    accelerationLevel: 20,
  });
  const cleared = await bridge.requestWithAck("clear_faults", {
    nodeId: 17,
    mask: 0,
  });
  assert.equal(cleared.ack.opcode, 4);
  await bridge.requestWithAck("status", { nodeId: 17, flags: 9 });

  const statusA = events.filter(
    (event) => event.event === "status" && event.data.part === "A",
  ).at(-1);
  const statusD = events.filter(
    (event) => event.event === "status" && event.data.part === "D",
  ).at(-1);
  assert.equal(statusA.data.runState, 2);
  assert.equal(statusA.data.moving, false);
  assert.equal(statusD.data.queueOutstanding, 0);
  assert.equal(statusD.data.queueActive, false);
});

test("simulation pairing requires a physical-equivalent window", async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
    script: path.join(__dirname, "..", "bridge", "lumdriver_bridge.py"),
  });
  context.after(async () => bridge.close());
  const pairs = [];
  bridge.on("event", (event) => {
    if (event.event === "pair") pairs.push(event.data);
  });
  await bridge.request("connect", {
    interface: "sim0",
    nodeId: 0,
    simulate: true,
  });
  await bridge.request("pair_discover", { uidHash: 0 });
  assert.equal(pairs.length, 0);
  await bridge.request("sim_pair_window");
  await bridge.request("pair_discover", { uidHash: 0 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].nodeId, 0);
  await bridge.request("pair_assign", {
    uidHash: pairs[0].uidHash,
    nodeId: 42,
    persist: true,
  });
  assert.equal(pairs.at(-1).nodeId, 42);
  const pingResult = await bridge.request("ping");
  assert.equal(typeof pingResult.sequence, "number");
});

test("external script STOP can cancel host motion replay for one node", () => {
  const bridge = new BridgeClient();
  assert.doesNotThrow(() => bridge.cancelMotionForNode(7, "script stop"));
  assert.throws(() => bridge.cancelMotionForNode(0), /1–127/);
  assert.throws(() => bridge.cancelMotionForNode(128), /1–127/);
});
