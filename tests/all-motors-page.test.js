"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "renderer", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "renderer", "styles.css"), "utf8");
const registry = require("../src/motor-registry");

function sourceNear(source, needle, radius = 700) {
  const index = source.indexOf(needle);
  assert.ok(index >= 0, `${needle} must exist in renderer/app.js`);
  return source.slice(Math.max(0, index - radius), index + needle.length + radius);
}

function functionSource(name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = declaration.exec(app);
  assert.ok(match, `${name} must exist in renderer/app.js`);
  const remainder = app.slice(match.index + match[0].length);
  const next = remainder.search(/\n(?:async\s+)?function\s+\w+\s*\(/);
  return app.slice(match.index, next < 0 ? app.length : match.index + match[0].length + next);
}

function styleRules(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules = Array.from(
    styles.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g")),
    (match) => match[1],
  );
  assert.ok(rules.length, `${selector} must have a CSS rule`);
  return rules;
}

function styleRule(selector) {
  return styleRules(selector)[0];
}

test("the default catalog and every dynamically configured motor render in one control surface", () => {
  assert.equal(registry.MOTORS.length, 26);
  assert.match(html, /id="motorRows"/);
  assert.match(app, /motors:\s*\[\.\.\.registry\.MOTORS\]/);
  assert.match(functionSource("buildMotorRows"), /for\s*\(\s*const motor of state\.motors\s*\)/);
  assert.match(app, /row\.dataset\.motorId\s*=\s*motor\.id/);
  assert.match(styles, /\.motor-control-row\b/);
});

test("motor control creates motors inside a chosen group without exposing post-creation reassignment", () => {
  assert.match(html, /id="addGroupButton"[^>]*>＋\s*添加分组</);
  assert.match(app, /addGroupButton["']\)\.addEventListener\(["']click["'],\s*addGroup\)/);
  for (const functionName of ["addGroup", "commitGroupName", "deleteGroup"]) {
    assert.match(app, new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`));
  }
  assert.doesNotMatch(app, /function\s+moveMotorToGroup\s*\(/);

  const row = functionSource("createMotorControlRow");
  assert.doesNotMatch(row, /motor-group-select|groupSelect/);
  assert.match(row, /motor-loop-mode-select/);

  const board = functionSource("buildMotorRows");
  assert.match(board, /for\s*\(const\s+\[groupIndex,\s*group\]\s+of\s+state\.groups\.entries\(\)\)/);
  assert.match(board, /Array\.from\(\{\s*length:\s*columnCount\s*\}/);
  assert.match(board, /banks\[bankIndex\]\.append\(section\)/);
  assert.match(board, /for\s*\(const bank of banks\)\s*root\.append\(bank\)/);
  assert.match(board, /group-name-input/);
  assert.match(board, /group-add-motor-button/);
  assert.match(board, /group-delete-button/);
  const clickHandler = functionSource("handleMotorBoardClick");
  assert.match(clickHandler, /group-add-motor-button/);
  assert.match(clickHandler, /addMotor\((?:groupId|section\.dataset\.groupId)\)/);
  assert.match(styles, /\.group-name-input\b/);
  assert.doesNotMatch(styles, /\.motor-group-select\b/);
  assert.doesNotMatch(html, /行内换组/);
});

test("motor names are immutable text after creation and can only be replaced by deleting the motor", () => {
  const row = functionSource("createMotorControlRow");
  assert.match(row, /motor-name-label/);
  assert.match(row, /textContent\s*=\s*motor\.label/);
  assert.doesNotMatch(row, /motor-name-input|const\s+label\s*=\s*document\.createElement\(["']input["']\)/);
  assert.doesNotMatch(app, /function\s+commitMotorName\s*\(/);
  assert.doesNotMatch(functionSource("handleMotorBoardChange"), /motor-name-input|commitMotorName/);
  assert.doesNotMatch(functionSource("handleMotorBoardKeydown"), /motor-name-input/);
  assert.match(functionSource("handleMotorBoardClick"), /motor-delete-button[\s\S]*deleteMotor\(motorId\)/);
});

test("motor groups form two tight vertical banks without row gaps or card margins", () => {
  const boardRules = styleRules(".motor-board");
  assert.match(boardRules[0], /column-gap\s*:\s*\d+(?:\.\d+)?px\s*;/);
  assert.match(boardRules[0], /row-gap\s*:\s*0(?:px)?\s*;/);
  for (const board of boardRules) {
    if (/row-gap\s*:/.test(board)) assert.match(board, /row-gap\s*:\s*0(?:px)?\s*;/);
    assert.doesNotMatch(board, /(?:^|;)\s*gap\s*:\s*(?!0(?:px)?\s*;)/);
  }

  const bank = styleRule(".motor-bank");
  assert.match(bank, /gap\s*:\s*0(?:px)?\s*;/);
  assert.match(bank, /margin\s*:\s*0(?:px)?\s*;/);

  const group = styleRule(".motor-group");
  assert.match(group, /margin\s*:\s*0(?:px)?\s*;/);
  assert.match(styles, /\.motor-bank\s+\.motor-group\s*\+\s*\.motor-group\s*\{[^}]*margin-top\s*:\s*-1px\s*;/);
});

test("software title and motor count are dynamic instead of advertising a fixed axis count", () => {
  assert.match(html, /<title>Action Editor<\/title>/);
  assert.match(
    html,
    /<span\s+id="configuredCount">0<\/span>\s*\/\s*<span\s+id="motorCount">0<\/span>\s*已配置\s*ID/,
  );
  assert.match(html, /id="motorRows"[^>]*aria-label="电机控制列表"/);
  assert.doesNotMatch(html, /\/\s*26\s*已配置|aria-label="26\s*个电机控制行"/);
  assert.match(functionSource("buildMotorRows"), /motorCount"\)\.textContent\s*=\s*String\(state\.motors\.length\)/);
});

test("every motor row owns positive motion fields and direct direction actions", () => {
  const rowFactoryStart = app.indexOf("function createMotorControlRow");
  const rowFactoryEnd = app.indexOf("\nfunction ", rowFactoryStart + 1);
  assert.ok(rowFactoryStart >= 0 && rowFactoryEnd > rowFactoryStart, "createMotorControlRow must exist");
  const rowFactory = app.slice(rowFactoryStart, rowFactoryEnd);

  for (const className of [
    "motor-name-label",
    "motor-id-input",
    "motor-steps-input",
    "motor-speed-input",
    "motor-acceleration-input",
    "motor-loop-mode-select",
    "motor-forward-button",
    "motor-reverse-button",
    "motor-stop-button",
    "motor-disable-button",
    "motor-delete-button",
  ]) {
    assert.match(app, new RegExp(`\\b${className}\\b`));
  }
  assert.doesNotMatch(app, /\bmotor-send-button\b/);
  assert.match(html, /id="addMotorButton"[^>]*>＋\s*添加电机</);
  assert.match(app, /addMotorButton["']\)\.addEventListener\(["']click["'],\s*\(\)\s*=>\s*void\s+addMotor\(\)\)/);

  const idField = sourceNear(rowFactory, "motor-id-input");
  assert.match(idField, /type\s*=\s*["']number["']/);
  assert.match(idField, /min\s*=\s*["']?1["']?/);
  assert.match(idField, /max\s*=\s*["']?127["']?/);

  const stepsField = sourceNear(rowFactory, "motor-steps-input");
  assert.match(stepsField, /min\s*=\s*["']?1["']?/);
  assert.match(stepsField, /max\s*=\s*["']?16777215["']?/);
  assert.match(stepsField, /step\s*=\s*["']?1["']?/);

  for (const className of ["motor-speed-input", "motor-acceleration-input"]) {
    const field = sourceNear(rowFactory, className);
    assert.match(field, /min\s*=\s*["']?1["']?/);
    assert.match(field, /max\s*=\s*["']?100["']?/);
  }
});

test("motor control rows do not contain the timeline enable switches", () => {
  const rowFactory = functionSource("createMotorControlRow");
  assert.doesNotMatch(rowFactory, /motor-enable|timeline-track-enable|type\s*=\s*["']checkbox["']|发送使能/);
  assert.match(rowFactory, /row\.append\([\s\S]*accelerationInput[\s\S]*forwardButton[\s\S]*reverseButton[\s\S]*deleteButton/);

  const header = functionSource("createColumnHeader");
  assert.doesNotMatch(header, /["']使能["']/);
  assert.doesNotMatch(html, /id=["']enabledCount["']/);
  assert.doesNotMatch(styles, /\.motor-enable-(?:control|input)\b/);
});

test("row motion buttons depend on CAN readiness and ID, not timeline track enable", () => {
  const refresh = functionSource("refreshMotorRows");
  const forwardAssignment = refresh.match(/forwardButton\.disabled\s*=\s*([^;]+);/);
  const reverseAssignment = refresh.match(/reverseButton\.disabled\s*=\s*([^;]+);/);
  assert.ok(forwardAssignment && reverseAssignment, "direct motion button guards must exist");
  for (const assignment of [forwardAssignment[1], reverseAssignment[1]]) {
    assert.match(assignment, /state\.connected/);
    assert.match(assignment, /nodeId/);
    assert.doesNotMatch(assignment, /timelineTrackIsEnabled|timelineTrackEnabled|positionEnabled/);
  }

  const stopAssignment = refresh.match(/motor-stop-button["']\)\.disabled\s*=\s*([^;]+);/);
  const disableAssignment = refresh.match(/motor-disable-button["']\)\.disabled\s*=\s*([^;]+);/);
  assert.ok(stopAssignment && disableAssignment, "STOP and DISABLE button guards must exist");
  assert.doesNotMatch(stopAssignment[1], /timelineTrackIsEnabled|timelineTrackEnabled/);
  assert.doesNotMatch(disableAssignment[1], /timelineTrackIsEnabled|timelineTrackEnabled/);
});

test("row actions are routed by motor identity instead of a selected motor", () => {
  assert.doesNotMatch(app, /selectedMotorId|selectMotor\s*\(|renderSelectedMotor\s*\(/);
  assert.match(app, /dataset\.motorId/);
  assert.match(app, /\$\("motorRows"\)\.addEventListener/);
  assert.match(app, /closest\(["']\.motor-control-row["']\)/);
  assert.match(app, /motor-forward-button[\s\S]{0,200}sendMotor\(motorId,\s*1\)/);
  assert.match(app, /motor-reverse-button[\s\S]{0,200}sendMotor\(motorId,\s*-1\)/);
});

test("direction buttons create signed commands and both send-and-record automatically", () => {
  const buildDraft = sourceNear(app, "function buildDraft", 900);
  assert.match(buildDraft, /function\s+buildDraft\s*\(\s*motorId\s*,\s*direction/);
  assert.doesNotMatch(buildDraft, /Math\.abs\s*\(/, "negative step input must be rejected, not silently normalized");

  const positiveSteps = sourceNear(app, "function positiveStepMagnitude", 500);
  assert.doesNotMatch(positiveSteps, /Math\.abs\s*\(/);
  const stepDeclaration = positiveSteps.match(/const\s+(\w+)\s*=\s*Number\(value\)/);
  assert.ok(stepDeclaration, "step magnitude must be parsed before direction is applied");
  const stepName = stepDeclaration[1];
  assert.match(positiveSteps, new RegExp(`Number\\.is(?:Safe)?Integer\\(${stepName}\\)`));
  assert.match(positiveSteps, new RegExp(`${stepName}\\s*(?:<\\s*1|<=\\s*0)`));
  assert.match(positiveSteps, new RegExp(`${stepName}\\s*>\\s*(?:commandModel\\.)?MAX_STEP_COUNT`));

  const magnitudeDeclaration = buildDraft.match(/const\s+(\w+)\s*=\s*positiveStepMagnitude\(draft\.steps\)/);
  assert.ok(magnitudeDeclaration, "buildDraft must validate a positive magnitude before applying direction");
  const magnitudeName = magnitudeDeclaration[1];
  assert.match(
    buildDraft,
    new RegExp(`signedSteps\\s*:\\s*(?:direction\\s*\\*\\s*${magnitudeName}|${magnitudeName}\\s*\\*\\s*direction)`),
  );

  const recorder = functionSource("recordMotorCommand");
  assert.match(recorder, /state\.program\.add\(preparedCommand\s*\|\|\s*buildDraft\(motorId,\s*direction\)\)/);
  const send = functionSource("sendMotor");
  const prepared = send.indexOf("buildDraft(motorId, direction)");
  const preflight = send.indexOf("await requireClosedLoopReady([preparedCommand])");
  const recorded = send.indexOf("recordMotorCommand(motorId, direction, preparedCommand)");
  const transmitted = send.indexOf("transmit(command");
  assert.ok(prepared >= 0 && preflight > prepared && recorded > preflight && transmitted > recorded,
    "direct motion must be validated, closed-loop preflighted, recorded, then transmitted");
});

test("status refreshes do not rebuild the editable dynamic rows", () => {
  assert.match(app, /function\s+(?:refreshMotorRows|refreshAllMotorRows)\s*\(/);
  const refreshStart = app.indexOf("function refreshMotorRows");
  const refreshEnd = app.indexOf("\nfunction ", refreshStart + 1);
  const refresh = app.slice(refreshStart, refreshEnd);
  assert.doesNotMatch(refresh, /replaceChildren\s*\(|buildMotorRows\s*\(/);
  for (const structuralFunction of ["addMotor", "deleteMotor", "importConfiguration"]) {
    assert.match(functionSource(structuralFunction), /buildMotorRows\s*\(\s*\)/);
  }
});

test("legacy motor picker and ID configuration modal cannot return", () => {
  for (const legacyId of [
    "motorList",
    "openIdConfigButton",
    "selectedMotorName",
    "selectedIdTag",
    "commandForm",
    "idConfigModal",
    "idConfigRows",
    "saveIdConfigButton",
  ]) {
    assert.doesNotMatch(html, new RegExp(`id=[\"']${legacyId}[\"']`));
  }
  assert.doesNotMatch(html, /SELECTED MOTOR|配置电机 ID/);
});

test("inline IDs remain range-checked while duplicate node IDs are allowed", () => {
  assert.match(app, /nodeId[\s\S]{0,500}(?:>=\s*1|<\s*1)[\s\S]{0,500}(?:<=\s*127|>\s*127)/);
  const commitStart = app.indexOf("function commitInlineNodeId");
  const commitEnd = app.indexOf("\nfunction ", commitStart + 1);
  assert.ok(commitStart >= 0 && commitEnd > commitStart, "commitInlineNodeId must exist");
  const commit = app.slice(commitStart, commitEnd);
  assert.doesNotMatch(commit, /find\([^)]*bindingNodeId|(?:不能重复|重复使用|duplicate)/i);
  assert.match(html, /ID 可重复|<span>ID<\/span>\s*<span>可重复<\/span>/);
});

test("saved commands with an old inline ID are visibly stale and cannot be sent", () => {
  assert.match(
    app,
    /function\s+commandBindingCurrent\s*\([^)]*\)[\s\S]{0,350}bindingNodeId\(command\.motorId\)\s*===\s*command\.nodeId/,
  );
  const resend = functionSource("sendRecordedCommand");
  const staleGate = resend.indexOf("!commandBindingCurrent(command)");
  const resendTransmit = resend.indexOf("transmit(command");
  assert.ok(staleGate >= 0 && resendTransmit > staleGate, "individual resend must reject a stale binding before transmit");
  assert.match(resend.slice(staleGate, resendTransmit), /(?:禁止|return)/);

  const sendAll = functionSource("sendAllRecorded");
  const staleSearch = sendAll.search(/commands\.find\([^\n]*!commandBindingCurrent\(command\)/);
  const preflight = sendAll.indexOf("requireIdleNodes(commands)");
  assert.ok(staleSearch >= 0 && preflight > staleSearch, "batch send must reject a stale binding before preflight");
  assert.match(sendAll.slice(staleSearch, preflight), /return/);
  assert.match(app, /program-row\s+\$\{bindingCurrent \? "" : "stale"\}/);
});

test("sending all recorded commands starts directly without a confirmation dialog", () => {
  const sendAllStart = app.indexOf("async function sendAllRecorded");
  const sendAllEnd = app.indexOf("\nasync function ", sendAllStart + 1);
  assert.ok(sendAllStart >= 0, "sendAllRecorded must exist");
  const sendAllSource = app.slice(sendAllStart, sendAllEnd);

  assert.doesNotMatch(sendAllSource, /\bconfirmAction\s*\(/);
  assert.match(sendAllSource, /beginOperation\(["']批量发送["']\)/);
  assert.match(app, /sendAllButton["']\)\.addEventListener\(["']click["'],\s*\(\)\s*=>\s*void sendAllRecorded\(\)\)/);
});

test("clearing recorded commands happens directly without a confirmation dialog", () => {
  const clearStart = app.indexOf('$("clearProgramButton").addEventListener');
  const clearEnd = app.indexOf('$("clearLogButton").addEventListener', clearStart + 1);
  assert.ok(clearStart >= 0, "clearProgramButton click handler must exist");
  assert.ok(clearEnd > clearStart, "clearProgramButton click handler must have a bounded source section");
  const clearSource = app.slice(clearStart, clearEnd);

  assert.doesNotMatch(clearSource, /\bconfirmAction\s*\(/);
  assert.match(clearSource, /state\.program\.clear\(\)/);
  assert.match(clearSource, /state\.programStats\.clear\(\)/);
  assert.match(clearSource, /persistState\(\)/);
  assert.match(clearSource, /renderProgram\(\)/);
});

test("STOP and DISABLE can cancel an in-progress batch instead of waiting behind it", () => {
  assert.match(app, /operationEpoch/);
  assert.match(app, /for \(const command of commands\)[\s\S]{0,180}token !== state\.operationEpoch[\s\S]{0,80}break/);
  for (const functionName of ["stopMotor", "disableMotor", "emergencyStop"]) {
    const start = app.indexOf(`async function ${functionName}`);
    const end = app.indexOf("\nasync function ", start + 1);
    assert.ok(start >= 0 && end > start, `${functionName} must exist`);
    assert.match(app.slice(start, end), /beginInterruptOperation/);
  }
  assert.match(app, /motor-stop-button"\)\.disabled\s*=\s*!state\.connected\s*\|\|\s*state\.disconnecting\s*\|\|\s*nodeId\s*==\s*null/);
  assert.match(app, /motor-disable-button"\)\.disabled\s*=\s*!state\.connected\s*\|\|\s*state\.disconnecting\s*\|\|\s*nodeId\s*==\s*null/);
});

test("the final motion transmitter defaults to normal sends and gates only timeline callers", () => {
  const transmit = functionSource("transmit");
  const defaultOff = transmit.indexOf("requireTimelineTrackEnabled = false");
  const optionalGate = transmit.indexOf("requireTimelineTrackEnabled && !timelineTrackIsEnabled(command.motorId)");
  const bridgeMove = transmit.indexOf("await api.move(payload)");
  assert.ok(defaultOff >= 0, "ordinary motor commands must not require timeline-track enable");
  assert.ok(optionalGate > defaultOff && bridgeMove > optionalGate, "timeline callers must get a final enable check before CAN transmission");
});

test("direct send records and transmits without consulting timeline track enable", () => {
  const send = functionSource("sendMotor");
  const record = send.indexOf("recordMotorCommand(motorId, direction, preparedCommand)");
  const transmit = send.indexOf("await transmit(command");
  assert.ok(record >= 0 && transmit > record, "direct motion must still record before transmit");
  assert.doesNotMatch(send, /timelineTrackIsEnabled|timelineTrackEnabled|enabledTimelineActions/);
});

test("motor and timeline editors expose an explicit open or closed loop mode", () => {
  const row = functionSource("createMotorControlRow");
  assert.match(row, /createElement\(["']select["']\)/);
  assert.match(row, /loopModeSelect\.className\s*=\s*["']motor-loop-mode-select["']/);
  assert.match(row, /\[\["open", "开"\], \["closed", "闭"\]\]/);
  assert.match(row, /state\.drafts\[motor\.id\]\.closed\s*\?\s*["']closed["']\s*:\s*["']open["']/);
  assert.match(functionSource("handleMotorBoardChange"), /motor-loop-mode-select[\s\S]*updateDraftFromInput/);
  assert.match(functionSource("updateDraftFromInput"), /draft\.closed\s*=\s*input\.value\s*===\s*["']closed["']/);

  assert.match(html, /id="timelineLoopModeSelect"[\s\S]*value="open"[^>]*selected[^>]*>开环<[\s\S]*value="closed"[^>]*>闭环</);
  assert.match(functionSource("timelineDraftFromEditor"), /closed:\s*\$\("timelineLoopModeSelect"\)\.value\s*===\s*["']closed["']/);
  assert.match(functionSource("loadTimelineActionIntoEditor"), /action\.closed\s*\?\s*["']closed["']\s*:\s*["']open["']/);
});

test("open and closed commands use distinct protocol CAN identifiers", () => {
  const draft = functionSource("buildDraft");
  const timelineCommand = functionSource("timelineCommand");
  const frame = functionSource("frameText");
  assert.match(draft, /closed:\s*draft\.closed/);
  assert.match(timelineCommand, /closed:\s*action\.closed/);
  assert.match(frame, /const canId\s*=\s*\(payload\.closed\s*\?\s*0x280\s*:\s*0x200\)\s*\|\s*payload\.nodeId/);
  assert.match(functionSource("transmit"), /commandModel\.toBridgePayload\(command\)[\s\S]*await api\.move\(payload\)/);
});

test("closed-loop transmission is gated by fresh encoder and calibration validity", () => {
  const problem = functionSource("closedLoopReadinessProblem");
  assert.match(problem, /filter\(\(\{ closed \}\)\s*=>\s*closed\s*===\s*true\)/);
  assert.match(problem, /runtime\.encoderValid\s*!==\s*true/);
  assert.match(problem, /runtime\.calibrationValid\s*!==\s*true/);
  assert.match(problem, /lastClosedReadinessAt\s*\?\?\s*runtime\.lastStatusAAt/);

  const preflight = functionSource("requireClosedLoopReady");
  assert.match(preflight, /api\.statusMany\(closedNodes\.slice\(index, index \+ 16\), 0x01\)/);
  assert.match(preflight, /confirmClosedLoopReady\(commands, requestedAt\)/);

  const transmit = functionSource("transmit");
  const finalGate = transmit.indexOf("closedLoopReadinessProblem([command])");
  const move = transmit.indexOf("await api.move(payload)");
  assert.ok(finalGate >= 0 && move > finalGate, "the final transmitter must fail closed before bridge I/O");
  assert.match(transmit.slice(finalGate, move), /闭环指令未发送[\s\S]*return \{ ok: false, error \}/);

  const status = functionSource("handleDriverEvent");
  assert.match(status, /data\.part === ["']A["'][\s\S]*runtime\.lastClosedReadinessAt\s*=\s*seenAt/);
});

test("recorded resend and batch send do not consult timeline track enable", () => {
  const resend = functionSource("sendRecordedCommand");
  const resendTransmit = resend.indexOf("await transmit(command");
  assert.ok(resendTransmit >= 0, "individual resend must retain transmit");
  assert.doesNotMatch(resend, /timelineTrackIsEnabled|timelineTrackEnabled|enabledTimelineActions/);

  const batch = functionSource("sendAllRecorded");
  const preflight = batch.indexOf("await requireIdleNodes(commands)");
  const begin = batch.indexOf('beginOperation("批量发送")');
  assert.ok(preflight >= 0 && begin > preflight, "batch send must retain idle preflight");
  assert.doesNotMatch(batch, /timelineTrackIsEnabled|timelineTrackEnabled|enabledTimelineActions/);
});

test("batch and return loops refresh stale closed-loop readiness and recheck cancellation before transmit", () => {
  for (const [name, sourceLabel] of [
    ["sendAllRecorded", "批量"],
    ["returnToOrigin", "回起点"],
  ]) {
    const source = functionSource(name);
    const loop = source.indexOf("for (const command of commands)");
    const firstEpochFence = source.indexOf("token !== state.operationEpoch", loop);
    const refresh = source.indexOf("await refreshClosedLoopReadinessIfStale([command])", firstEpochFence);
    const secondEpochFence = source.indexOf("token !== state.operationEpoch", refresh);
    const transmit = source.indexOf(`transmit(command, "${sourceLabel}"`, secondEpochFence);

    assert.ok(loop >= 0 && firstEpochFence > loop,
      `${name} must check cancellation before beginning each command`);
    assert.ok(refresh > firstEpochFence && secondEpochFence > refresh,
      `${name} must refresh stale closed-loop status and recheck cancellation after await`);
    assert.ok(transmit > secondEpochFence,
      `${name} must not transmit until the post-refresh operationEpoch fence passes`);
  }

  const refresh = functionSource("refreshClosedLoopReadinessIfStale");
  assert.match(refresh, /if \(!closedLoopReadinessProblem\(commands\)\) return true/);
  assert.match(refresh, /return requireClosedLoopReady\(commands\)/);
});

test("return-to-origin does not consult timeline track enable", () => {
  const origin = functionSource("returnToOrigin");
  const preflight = origin.indexOf("await requireIdleNodes(commands)");
  const confirmation = origin.indexOf("await confirmAction(");
  const begin = origin.indexOf('beginOperation("返回起点")');
  assert.ok(preflight >= 0 && confirmation > preflight && begin > confirmation);
  assert.doesNotMatch(origin, /timelineTrackIsEnabled|timelineTrackEnabled|enabledTimelineActions/);
});

test("STOP, DISABLE, and emergency stop are never blocked by timeline track enable", () => {
  for (const [name, bridgeCall] of [
    ["stopMotor", /api\.stop\s*\(/],
    ["disableMotor", /api\.disable\s*\(/],
    ["emergencyStop", /api\.(?:stop|disable)\s*\(/],
  ]) {
    const source = functionSource(name);
    assert.match(source, bridgeCall, `${name} must retain its safety bridge operation`);
    assert.doesNotMatch(source, /timelineTrackIsEnabled|timelineTrackEnabled|enabledTimelineActions/, `${name} must bypass timeline enable gates`);
  }
});
