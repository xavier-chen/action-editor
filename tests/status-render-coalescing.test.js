"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");

function functionSource(name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = declaration.exec(app);
  assert.ok(match, `${name} must exist in renderer/app.js`);
  const remainder = app.slice(match.index + match[0].length);
  const next = remainder.search(/\n(?:async\s+)?function\s+\w+\s*\(/);
  return app.slice(match.index, next < 0 ? app.length : match.index + match[0].length + next);
}

test("CAN status and ACK bursts share one animation-frame UI refresh", () => {
  const schedule = functionSource("scheduleMotorStatusUiRefresh");
  assert.match(schedule, /motorStatusRenderHandle\s*!=\s*null/);
  assert.match(schedule, /requestAnimationFrame\s*\(/);
  assert.equal((schedule.match(/requestAnimationFrame\s*\(/g) || []).length, 1);
  assert.match(schedule, /state\.activePage\s*===\s*["']motor["'][\s\S]*refreshMotorRows\s*\(\s*\)/);
  assert.match(schedule, /renderOrigin\s*\(\s*\)/);
  assert.ok(
    schedule.indexOf("renderOrigin()") > schedule.indexOf("refreshMotorRows()"),
    "shared origin buttons update after the optional motor-only row refresh",
  );

  const events = functionSource("handleDriverEvent");
  assert.match(events, /resolvePendingOriginStatus\s*\(\s*\)/);
  assert.match(events, /resolveTimelineTestDrain\s*\(\s*\)/);
  assert.ok(
    (events.match(/scheduleMotorStatusUiRefresh\s*\(\s*\)/g) || []).length >= 2,
    "ACK and status branches must both schedule the shared refresh",
  );
  assert.doesNotMatch(events, /refreshMotorRows\s*\(\s*\)|renderOrigin\s*\(\s*\)/);
});

test("coalescing UI work preserves immediate CAN safety transitions", () => {
  const events = functionSource("handleDriverEvent");
  for (const pattern of [
    /runtime\.lastMotionAckSequence\s*=\s*data\.sequence/,
    /stopTimelinePlayback\s*\(/,
    /stopTimelineTest\s*\(/,
    /invalidateOrigin\s*\(/,
    /resolveTimelineTestDrain\s*\(\s*\)/,
  ]) assert.match(events, pattern);

  const ackUpdate = events.indexOf("state.nodeStatus.set(data.nodeId, runtime)");
  const scheduled = events.indexOf("scheduleMotorStatusUiRefresh()");
  assert.ok(ackUpdate >= 0 && scheduled > ackUpdate, "state must update before scheduling paint");
});

test("hidden motor rows stay dirty while shared origin controls refresh on every page", () => {
  const rows = functionSource("refreshMotorRows");
  const origin = functionSource("renderOrigin");
  const buttons = functionSource("renderOriginReturnButtons");
  const switchPage = functionSource("switchPage");
  assert.match(rows, /state\.activePage\s*!==\s*["']motor["'][\s\S]*motorStatusUiDirty\s*=\s*true[\s\S]*return/);
  const sharedRender = origin.indexOf("renderOriginReturnButtons(view)");
  const motorOnlyGate = origin.search(/state\.activePage\s*!==\s*["']motor["']/);
  assert.ok(sharedRender >= 0 && motorOnlyGate > sharedRender,
    "timeline buttons must update before motor-only summary rendering returns");
  assert.match(buttons, /returnOriginButton[\s\S]*timelineReturnOriginButton[\s\S]*actionTimelineReturnOriginButton/);
  assert.match(buttons, /button\.disabled\s*=\s*!view\.canReturn/);
  assert.match(buttons, /button\.title\s*=\s*view\.returnTitle/);
  assert.match(switchPage, /state\.activePage\s*===\s*["']motor["'][\s\S]*flushMotorStatusUiRefresh\s*\(true\)/);
  assert.match(switchPage, /renderOrigin\s*\(\s*\)\s*;/,
    "switching to either timeline must immediately synchronize its origin button");
});

test("one origin view model gates all recovery entries from shared connection state", () => {
  const view = functionSource("originViewState");
  assert.match(view, /Object\.entries\(nodePositionSummary\(\)\)/);
  assert.match(view, /state\.ledger\.createReturnCommands\(\)/);
  assert.match(view, /returnNodes\.filter\(\(nodeId\)\s*=>\s*!nodeStatusIsFreshAndIdle\(nodeId\)\)/);
  for (const gate of [
    "connected", "connecting", "disconnecting", "busy", "configIoBusy", "originReturnPreparing", "originSetPreparing", "originReliable",
  ]) assert.match(view, new RegExp(`state\\.${gate}`), `${gate} must participate in the shared origin view`);
  assert.match(view, /entries\.length/);
  assert.match(view, /!pendingNodes\.length/);
  assert.match(view, /!busyNodes\.length/);
  assert.match(view, /return\s*\{[^}]*summary[^}]*canReturn[^}]*returnTitle[^}]*\}/);
});
