"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const {
  MAX_PROGRAM_COMMANDS,
  MAX_STEP_COUNT,
  CommandLedger,
  CommandProgram,
  toBridgePayload,
  validateCommand,
} = require("../src/command-ledger");

const command = (overrides = {}) => ({
  motorId: "left_brow_outer",
  nodeId: 12,
  signedSteps: 800,
  speed: 25,
  acceleration: 30,
  ...overrides,
});

test("validateCommand normalizes numeric form values and preserves commandId", () => {
  assert.deepEqual(validateCommand(command({
    commandId: "manual-1",
    nodeId: "127",
    signedSteps: "-16777215",
    speed: "1",
    acceleration: "100",
  })), {
    commandId: "manual-1",
    motorId: "left_brow_outer",
    nodeId: 127,
    signedSteps: -MAX_STEP_COUNT,
    speed: 1,
    acceleration: 100,
    closed: false,
  });
});

test("validateCommand defaults legacy commands to open loop and validates closed-loop mode", () => {
  assert.equal(validateCommand(command()).closed, false);
  assert.equal(validateCommand(command({ closed: true })).closed, true);
  for (const closed of [null, 0, 1, "true", {}]) {
    assert.throws(() => validateCommand(command({ closed })), /闭环模式必须是布尔值/);
  }
});

test("validateCommand enforces node, signed step, speed and acceleration bounds", () => {
  for (const value of [0, MAX_STEP_COUNT + 1, -(MAX_STEP_COUNT + 1)]) {
    assert.throws(() => validateCommand(command({ signedSteps: value })), /步数/);
  }
  for (const value of [null, "", true, 1.5, Number.NaN]) {
    assert.throws(() => validateCommand(command({ signedSteps: value })), /步数/);
  }
  for (const nodeId of [0, 128, 2.5, false, ""]) {
    assert.throws(() => validateCommand(command({ nodeId })), /电机 ID/);
  }
  for (const field of ["speed", "acceleration"]) {
    for (const value of [0, 101, 3.5, false, ""]) {
      assert.throws(() => validateCommand(command({ [field]: value })));
    }
  }
  assert.throws(() => validateCommand(command({ motorId: "  " })), /电机位置/);
  assert.throws(() => validateCommand(null), /对象/);
});

test("toBridgePayload separates sign into protocol direction and count", () => {
  assert.deepEqual(toBridgePayload(command({ signedSteps: 321 })), {
    nodeId: 12,
    direction: 0,
    count: 321,
    speedLevel: 25,
    accelerationLevel: 30,
    closed: false,
  });
  assert.deepEqual(toBridgePayload(command({ signedSteps: -321, closed: true })), {
    nodeId: 12,
    direction: 1,
    count: 321,
    speedLevel: 25,
    accelerationLevel: 30,
    closed: true,
  });
});

test("CommandProgram assigns stable IDs and snapshots without sharing its array", () => {
  const program = new CommandProgram();
  const first = program.add(command());
  const second = program.add(command({ motorId: "neck", nodeId: 24 }));
  assert.equal(first.commandId, "command-000001");
  assert.equal(second.commandId, "command-000002");
  assert.equal(program.size, 2);

  const beforeReplay = program.snapshot();
  assert.ok(Object.isFrozen(beforeReplay));
  assert.notEqual(beforeReplay, program.snapshot());
  assert.deepEqual(program.snapshot().map(({ commandId }) => commandId), [
    "command-000001",
    "command-000002",
  ]);

  // Replaying a fixed snapshot records actual motion only; it never appends a
  // second copy to the saved program and therefore cannot grow recursively.
  const ledger = new CommandLedger();
  for (const saved of beforeReplay) ledger.recordSuccess(saved);
  assert.equal(program.size, 2);
  assert.equal(ledger.size, 2);
  assert.deepEqual(program.snapshot(), beforeReplay);
});

test("CommandProgram removes and clears commands without reusing generated IDs", () => {
  const program = new CommandProgram();
  const first = program.add(command());
  assert.equal(program.remove(first.commandId), first);
  assert.equal(program.remove(first.commandId), null);
  const second = program.add(command());
  assert.equal(second.commandId, "command-000002");
  assert.equal(program.clear(), 1);
  assert.equal(program.size, 0);
  assert.equal(program.add(command()).commandId, "command-000003");
});

test("CommandProgram preserves imported IDs, rejects duplicates and caps at 256", () => {
  const program = new CommandProgram([
    command({ commandId: "saved-command", closed: true }),
  ]);
  assert.equal(program.snapshot()[0].commandId, "saved-command");
  assert.equal(program.snapshot()[0].closed, true);
  assert.throws(
    () => program.add(command({ commandId: "saved-command" })),
    /commandId 已存在/,
  );
  while (program.size < MAX_PROGRAM_COMMANDS) {
    program.add(command({ signedSteps: program.size + 1 }));
  }
  assert.equal(program.size, 256);
  assert.throws(() => program.add(command()), /最多 256 条/);
});

test("ledger records only explicitly successful motion and summarizes net position", () => {
  const ledger = new CommandLedger();
  const closedEntry = ledger.recordSuccess(command({ signedSteps: 400, closed: true }));
  assert.equal(closedEntry.closed, true);
  ledger.recordSuccess(command({ signedSteps: -125 }));
  ledger.recordSuccess(command({ motorId: "neck", nodeId: 20, signedSteps: -70 }));
  assert.deepEqual(ledger.positionSummary(), {
    left_brow_outer: 275,
    neck: -70,
  });
  assert.equal(ledger.size, 3);

  const actual = ledger.recordSuccess(command({
    motorId: "head_yaw",
    nodeId: 21,
    signedSteps: 100,
  }), { actualSignedSteps: 65 });
  assert.equal(actual.signedSteps, 65);
  assert.equal(ledger.positionSummary().head_yaw, 65);
  assert.equal(ledger.recordSuccess(command(), { actualSignedSteps: 0 }), null);
});

test("return commands aggregate per physical node in reverse activity order with recent rates and loop mode", () => {
  const ledger = new CommandLedger();
  ledger.recordSuccess(command({ signedSteps: 100, speed: 10, acceleration: 11 }));
  ledger.recordSuccess(command({
    motorId: "neck",
    nodeId: 22,
    signedSteps: -50,
    speed: 20,
    acceleration: 21,
  }));
  ledger.recordSuccess(command({ signedSteps: 25, speed: 30, acceleration: 31, closed: true }));

  const returns = ledger.createReturnCommands();
  assert.equal(returns.length, 2);
  assert.deepEqual(returns.map((item) => ({
    motorId: item.motorId,
    nodeId: item.nodeId,
    signedSteps: item.signedSteps,
    speed: item.speed,
    acceleration: item.acceleration,
    closed: item.closed,
  })), [
    {
      motorId: "left_brow_outer",
      nodeId: 12,
      signedSteps: -125,
      speed: 30,
      acceleration: 31,
      closed: true,
    },
    {
      motorId: "neck",
      nodeId: 22,
      signedSteps: 50,
      speed: 20,
      acceleration: 21,
      closed: false,
    },
  ]);
  assert.ok(returns.every(({ commandId }) => commandId.startsWith("return-")));
  assert.deepEqual(ledger.createReturnCommands(), returns, "unchanged ledger has stable return IDs");
});

test("return commands merge repeated bindings by physical CAN node", () => {
  const ledger = new CommandLedger();
  ledger.recordSuccess(command({
    motorId: "left_brow_outer",
    nodeId: 7,
    signedSteps: 100,
    speed: 10,
    acceleration: 11,
  }));
  ledger.recordSuccess(command({
    motorId: "neck",
    nodeId: 7,
    signedSteps: 40,
    speed: 20,
    acceleration: 21,
  }));

  assert.deepEqual(ledger.nodePositionSummary(), { 7: 140 });
  const returns = ledger.createReturnCommands();
  assert.equal(returns.length, 1);
  assert.deepEqual({
    motorId: returns[0].motorId,
    nodeId: returns[0].nodeId,
    signedSteps: returns[0].signedSteps,
    speed: returns[0].speed,
    acceleration: returns[0].acceleration,
  }, {
    motorId: "neck",
    nodeId: 7,
    signedSteps: -140,
    speed: 20,
    acceleration: 21,
  });
  assert.equal(ledger.markReturnResults(returns, [true]).cleared, true);
  assert.deepEqual(ledger.nodePositionSummary(), {});
});

test("opposite movements through repeated bindings do not create a needless return", () => {
  const ledger = new CommandLedger();
  ledger.recordSuccess(command({ motorId: "left_brow_outer", nodeId: 7, signedSteps: 100 }));
  ledger.recordSuccess(command({ motorId: "neck", nodeId: 7, signedSteps: -100 }));

  assert.deepEqual(ledger.nodePositionSummary(), {});
  assert.deepEqual(ledger.createReturnCommands(), []);
});

test("return plan splits a net displacement that exceeds one protocol frame", () => {
  const ledger = new CommandLedger();
  ledger.recordSuccess(command({ signedSteps: MAX_STEP_COUNT }));
  ledger.recordSuccess(command({ signedSteps: 9 }));
  assert.deepEqual(
    ledger.createReturnCommands().map(({ signedSteps }) => signedSteps),
    [-MAX_STEP_COUNT, -9],
  );
});

test("partial return success compensates only successful motors before retry", () => {
  const ledger = new CommandLedger();
  ledger.recordSuccess(command({ signedSteps: 80 }));
  ledger.recordSuccess(command({
    motorId: "neck",
    nodeId: 22,
    signedSteps: -45,
    speed: 44,
    acceleration: 55,
  }));
  const firstAttempt = ledger.createReturnCommands();
  assert.deepEqual(firstAttempt.map(({ motorId }) => motorId), ["neck", "left_brow_outer"]);

  const outcome = ledger.markReturnResults(firstAttempt, [{ ok: true }, { ok: false }]);
  assert.equal(outcome.allSucceeded, false);
  assert.equal(outcome.cleared, false);
  assert.deepEqual(outcome.remainingPositions, { left_brow_outer: 80 });
  assert.deepEqual(ledger.positionSummary(), { left_brow_outer: 80 });

  const retry = ledger.createReturnCommands();
  assert.equal(retry.length, 1);
  assert.equal(retry[0].motorId, "left_brow_outer");
  assert.equal(retry[0].signedSteps, -80);
  assert.notEqual(retry[0].commandId, firstAttempt[1].commandId);

  const completed = ledger.markReturnResults(retry, [true]);
  assert.equal(completed.allSucceeded, true);
  assert.equal(completed.cleared, true);
  assert.deepEqual(completed.remainingPositions, {});
  assert.equal(ledger.size, 0);
});

test("ledger clears only after every issued return succeeds and reaches origin", () => {
  const ledger = new CommandLedger();
  ledger.recordSuccess(command({ signedSteps: 90 }));
  const returns = ledger.createReturnCommands();
  assert.equal(ledger.markReturnResults(returns, [false]).cleared, false);
  assert.equal(ledger.size, 1);

  const succeeded = ledger.markReturnResults(returns, [{ success: true }]);
  assert.equal(succeeded.cleared, true);
  assert.deepEqual(ledger.positionSummary(), {});
  assert.deepEqual(ledger.snapshot(), []);
});

test("return result validation rejects mismatched arrays", () => {
  const ledger = new CommandLedger();
  ledger.recordSuccess(command());
  const returns = ledger.createReturnCommands();
  assert.throws(() => ledger.markReturnResults(returns, []), /数量必须一致/);
  assert.throws(() => ledger.markReturnResults(null, null), /必须是数组/);
});

test("UMD build exposes validation and classes to a browser global", () => {
  const filename = path.join(__dirname, "..", "src", "command-ledger.js");
  const source = fs.readFileSync(filename, "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename });
  const api = context.FaceCommandLedger;
  assert.equal(api.MAX_STEP_COUNT, MAX_STEP_COUNT);
  assert.equal(new api.CommandProgram().size, 0);
  assert.equal(api.toBridgePayload(command({ signedSteps: -2 })).direction, 1);
});
