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
  assert.match(schedule, /refreshMotorRows\s*\(\s*\)/);
  assert.match(schedule, /renderOrigin\s*\(\s*\)/);

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
    /receiveMotionAck\s*\(data\)/,
    /stopTimelinePlayback\s*\(/,
    /stopTimelineTest\s*\(/,
    /invalidateOrigin\s*\(/,
    /resolveTimelineTestDrain\s*\(\s*\)/,
  ]) assert.match(events, pattern);

  const ackUpdate = events.indexOf("state.nodeStatus.set(data.nodeId, runtime)");
  const scheduled = events.indexOf("scheduleMotorStatusUiRefresh()");
  assert.ok(ackUpdate >= 0 && scheduled > ackUpdate, "state must update before scheduling paint");
});

test("hidden motor controls stay dirty and receive one full refresh when reopened", () => {
  const rows = functionSource("refreshMotorRows");
  const origin = functionSource("renderOrigin");
  const switchPage = functionSource("switchPage");
  assert.match(rows, /state\.activePage\s*!==\s*["']motor["'][\s\S]*motorStatusUiDirty\s*=\s*true[\s\S]*return/);
  assert.match(origin, /resolvePendingOriginStatus\s*\(\s*\)[\s\S]*state\.activePage\s*!==\s*["']motor["']/);
  assert.match(switchPage, /state\.activePage\s*===\s*["']motor["'][\s\S]*flushMotorStatusUiRefresh\s*\(true\)/);
});
