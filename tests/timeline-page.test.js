"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "renderer", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "renderer", "styles.css"), "utf8");

function functionSource(name) {
  const start = app.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = app.indexOf("\nfunction ", start + 1);
  const nextAsync = app.indexOf("\nasync function ", start + 1);
  const ends = [next, nextAsync].filter((value) => value > start);
  return app.slice(start, ends.length ? Math.min(...ends) : app.length);
}

test("GUI keeps the motor editor and exposes all four requested tab panels", () => {
  assert.match(html, /role="tablist"[^>]*aria-label="工作页面"/);
  assert.match(html, /id="motorControlTab"[^>]*role="tab"[^>]*aria-controls="motorControlPage"/);
  assert.match(html, /id="timelineEditorTab"[^>]*role="tab"[^>]*aria-controls="timelineEditorPage"[^>]*>电机控制时间轴</);
  assert.match(html, /id="namedActionEditorTab"[^>]*role="tab"[^>]*aria-controls="namedActionEditorPage"[^>]*>动作编辑</);
  assert.match(html, /id="actionTimelineTab"[^>]*role="tab"[^>]*aria-controls="actionTimelinePage"[^>]*>动作时间轴</);
  assert.match(html, /id="motorControlPage"[^>]*role="tabpanel"/);
  assert.match(html, /id="timelineEditorPage"[^>]*role="tabpanel"[^>]*hidden/);
  assert.match(html, /id="namedActionEditorPage"[^>]*role="tabpanel"[^>]*hidden/);
  assert.match(html, /id="actionTimelinePage"[^>]*role="tabpanel"[^>]*hidden/);
  assert.equal((html.match(/\brole="tab"/g) || []).length, 4);
  assert.equal((html.match(/\brole="tabpanel"/g) || []).length, 4);
  assert.doesNotMatch(html, /recordingEditorTab|recordingEditorPage|录制动作轨道|<video\b/);
  assert.match(styles, /\.page-host\s*\{[^}]*height:\s*calc\(100%\s*-\s*112px\)/);
});

test("timeline action editor shows the selected track instead of a motor dropdown", () => {
  for (const id of [
    "timelineSelectedMotor",
    "timelineSelectedMotorName",
    "timelineSelectedMotorMeta",
    "timelineStartInput",
    "timelineStepsInput",
    "timelineSpeedInput",
    "timelineAccelerationInput",
    "timelineLoopModeSelect",
    "timelineTestButton",
    "timelineStopTestButton",
    "timelineSaveActionButton",
    "timelineUpdateActionButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="timelineMotorSelect"/);
  assert.doesNotMatch(html, /id="timelineNewActionButton"/);
  assert.doesNotMatch(app, /\$\(["']timelineMotorSelect["']\)/);
  assert.doesNotMatch(app, /\$\(["']timelineNewActionButton["']\)/);
  assert.match(html, /data-direction="1"[^>]*>＋\s*正向/);
  assert.match(html, /data-direction="-1"[^>]*>－\s*反向/);
  assert.match(html, /id="timelineStepsInput"[^>]*min="1"[^>]*max="16777215"/);
  for (const id of ["timelineSpeedInput", "timelineAccelerationInput"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*min="1"[^>]*max="100"`));
  }
  assert.match(html, /id="timelineLoopModeSelect"[\s\S]*value="open"[^>]*selected[^>]*>开环<[\s\S]*value="closed"[^>]*>闭环</);
  assert.match(app, /selectedTimelineMotorId:\s*null/);
  const selection = functionSource("renderTimelineMotorSelection");
  assert.match(selection, /selectedTimelineMotorId\(\)/);
  assert.match(selection, /timelineSelectedMotorName/);
  assert.match(selection, /timelineSelectedMotorMeta/);
  assert.match(functionSource("timelineDraftFromEditor"), /const motorId = selectedTimelineMotorId\(\)/);
});

test("timeline previews theoretical duration, end time, and renders duration-sized action blocks", () => {
  for (const id of [
    "timelineEstimateCard",
    "timelineEstimatedDuration",
    "timelineEstimatedWindow",
    "timelineEstimateProfile",
    "timelinePlaceAfterButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /动作块长度\s*=\s*理论(?:持续|轨迹)时间/);
  const estimate = functionSource("renderTimelineEstimate");
  assert.match(estimate, /timelineActionEstimate/);
  assert.match(estimate, /预计结束/);
  assert.match(estimate, /实际参数/);
  const tracks = functionSource("renderTimelineTracks");
  assert.match(tracks, /estimate\.durationMs/);
  assert.match(tracks, /clip\.style\.width/);
  assert.match(tracks, /queued/);
  assert.match(tracks, /action\.closed\s*\?\s*["'] closed-loop["']\s*:\s*["'] open-loop["']/);
  assert.match(tracks, /clip\.dataset\.mode\s*=\s*action\.closed\s*\?\s*["']闭["']\s*:\s*["']开["']/);
  assert.match(styles, /\.timeline-clip\s*\{[^}]*min-width:\s*12px/);
  assert.match(styles, /\.timeline-clip\.closed-loop\s*\{/);
});

test("timeline can place a new action after the estimated end of the same physical ID", () => {
  const schedule = functionSource("timelineSchedule");
  assert.match(schedule, /availableByNode/);
  assert.match(schedule, /estimatedEndMs/);
  assert.match(schedule, /queuedDelayMs/);
  const place = functionSource("placeTimelineActionAfterNode");
  assert.match(place, /timelinePlaceAfterButton/);
  assert.match(place, /timelineStartInput/);
  assert.match(app, /timelinePlaceAfterButton["']\)\.addEventListener\(\s*["']click["']/);
});

test("one motor can add multiple actions without overwriting the selected action", () => {
  assert.match(html, /id="timelineSaveActionButton"[^>]*type="submit"[^>]*>＋\s*添加为新动作/);
  assert.match(html, /id="timelineUpdateActionButton"[^>]*type="button"[^>]*hidden>更新所选动作/);
  const save = functionSource("saveTimelineAction");
  assert.match(save, /const saved = updateSelected/);
  assert.match(save, /state\.timeline\.update\(selected\.actionId, draft\)/);
  assert.match(save, /state\.timeline\.add\(draft\)/);
  assert.match(app, /saveTimelineAction\(false\)/);
  assert.match(app, /saveTimelineAction\(true\)/);
  assert.doesNotMatch(html, /timelineNewActionButton/);
  assert.doesNotMatch(app, /timelineNewActionButton/);
});

test("timeline surface provides playback, stop, clear, ruler, lanes, and playhead", () => {
  for (const id of [
    "timelinePlayButton",
    "timelineStopButton",
    "timelineClearButton",
    "timelineRuler",
    "timelineTracks",
    "timelinePlayhead",
    "timelinePlayheadHandle",
    "timelineScroller",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="timelineRuler"[^>]*role="slider"[^>]*aria-valuemin="0"[^>]*aria-valuemax="10000"[^>]*aria-valuenow="0"/);
  assert.match(styles, /\.timeline-scroll\s*\{[^}]*overflow:\s*auto/);
  assert.match(styles, /\.timeline-track-label\s*\{[^}]*position:\s*sticky/);
  assert.match(styles, /\.timeline-ruler\s*\{[^}]*position:\s*sticky[^}]*touch-action:\s*none/);
  assert.match(styles, /\.timeline-ruler\.dragging\s*\{/);
  assert.match(styles, /\.timeline-playhead-handle\s*\{[^}]*pointer-events:\s*auto[^}]*touch-action:\s*none/);
});

test("pressing and dragging the timeline ruler continuously captures and releases one pointer", () => {
  assert.match(app, /timelineCursorDrag:\s*null/);

  const begin = functionSource("beginTimelineCursorDrag");
  assert.match(begin, /timelineInteractionLocked\(\)/);
  assert.match(begin, /event\.button !== 0/);
  assert.match(begin, /event\.isPrimary === false/);
  assert.match(begin, /event\.preventDefault\(\)/);
  assert.match(begin, /state\.timelineCursorDrag = \{ pointerId: event\.pointerId \}/);
  assert.match(begin, /ruler\.setPointerCapture\(event\.pointerId\)/);
  assert.match(begin, /setTimelineCursorFromPointer\(event\)/);

  const move = functionSource("moveTimelineCursorDrag");
  assert.match(move, /drag\.pointerId !== event\.pointerId/);
  assert.match(move, /finishTimelineCursorDrag\(event, true\)/);
  assert.match(move, /setTimelineCursorFromPointer\(event, \{ autoScroll: true \}\)/);

  const finish = functionSource("finishTimelineCursorDrag");
  const finalPosition = finish.indexOf("if (!canceled && !timelineInteractionLocked()) setTimelineCursorFromPointer(event)");
  const clearState = finish.indexOf("state.timelineCursorDrag = null");
  const release = finish.indexOf("ruler.releasePointerCapture(event.pointerId)");
  assert.ok(finalPosition >= 0 && clearState > finalPosition && release > clearState,
    "pointerup must accept its final coordinate before clearing state and releasing capture");
  assert.match(finish, /ruler\.classList\.remove\("dragging"\)/);
  assert.match(finish, /timelinePlayhead"\)\.classList\.remove\("dragging"\)/);

  const events = functionSource("initEvents");
  assert.match(events, /timelineRuler"\)\.addEventListener\("pointerdown", beginTimelineCursorDrag\)/);
  assert.match(events, /timelinePlayheadHandle"\)\.addEventListener\("pointerdown", beginTimelineCursorDrag\)/);
  assert.match(events, /timelineRuler"\)\.addEventListener\("pointermove", moveTimelineCursorDrag\)/);
  assert.match(events, /timelineRuler"\)\.addEventListener\("pointerup", \(event\) => finishTimelineCursorDrag\(event\)\)/);
  assert.match(events, /timelineRuler"\)\.addEventListener\("pointercancel", \(event\) => finishTimelineCursorDrag\(event, true\)\)/);
  assert.match(events, /timelineRuler"\)\.addEventListener\("lostpointercapture", \(event\) => finishTimelineCursorDrag\(event, true\)\)/);
  assert.match(events, /window\.addEventListener\("blur"[\s\S]*finishTimelineCursorDrag\(\{ pointerId: cursorDrag\.pointerId \}, true\)/);
});

test("ruler drag snaps and clamps the live cursor while Alt disables snapping", () => {
  const update = functionSource("setTimelineCursorFromPointer");
  assert.match(update, /timelineRuler"\)\.getBoundingClientRect\(\)/);
  assert.match(update, /millisecondsFromPixels\(event\.clientX - rect\.left, state\.timelinePixelsPerSecond\)/);
  assert.match(update, /timelineModel\.snapStartMs\(milliseconds, event\.altKey \? 0 : state\.timelineSnapMs, state\.timelineDurationMs\)/);
  assert.match(update, /timelineStartInput"\)\.value = String\(state\.timelineCursorMs\)/);
  assert.match(update, /renderTimelineCursor\(\)/);
  assert.match(update, /renderTimelineEstimate\(\)/);

  const render = functionSource("renderTimelineCursor");
  assert.match(render, /Math\.min\(state\.timelineDurationMs, Math\.max\(0, state\.timelineCursorMs\)\)/);
  assert.match(render, /timelineRuler"\)\.setAttribute\("aria-valuenow", String\(cursor\)\)/);
});

test("dragging the ruler changes an edited action draft without silently saving the action", () => {
  const pointerUpdate = functionSource("setTimelineCursorFromPointer");
  assert.match(pointerUpdate, /timelineStartInput"\)\.value = String\(state\.timelineCursorMs\)/);
  assert.doesNotMatch(pointerUpdate, /selectedTimelineAction\(\)/,
    "an existing selection must not prevent the ruler from supplying a new draft start time");

  const gesture = [
    pointerUpdate,
    functionSource("beginTimelineCursorDrag"),
    functionSource("moveTimelineCursorDrag"),
    functionSource("finishTimelineCursorDrag"),
  ].join("\n");
  assert.doesNotMatch(gesture, /state\.timeline\.(?:add|update|remove|clear)\s*\(/);
  assert.doesNotMatch(gesture, /persistState\s*\(|saveTimelineAction\s*\(/);
  assert.doesNotMatch(gesture, /state\.selectedTimelineActionId\s*=/);

  const keyboard = functionSource("moveTimelineCursorWithKeyboard");
  assert.match(keyboard, /timelineStartInput"\)\.value = String\(state\.timelineCursorMs\)/);
  assert.doesNotMatch(keyboard, /selectedTimelineAction\(\)/);
});

test("clicking a track label or empty lane selects that motor for a new action", () => {
  const select = functionSource("selectTimelineMotor");
  const unchanged = select.indexOf("selectedTimelineMotorId() === motorId && !selectedTimelineAction()");
  const assignment = select.indexOf("setSelectedTimelineMotorId(motorId)");
  const reset = select.indexOf("resetTimelineEditor()", assignment);
  const render = select.indexOf("renderTimeline()", reset);
  assert.ok(unchanged >= 0 && assignment > unchanged, "clicking the already-selected new-action track must preserve the current draft");
  assert.ok(reset > assignment && render > reset, "a different track must become selected before the editor is reset and rerendered");

  const handler = functionSource("handleTimelineTrackSelection");
  assert.match(handler, /event\.target\.closest\(["']\.timeline-clip, \.timeline-track-enable-control["']\)\) return/);
  assert.match(handler, /closest\(["']\.timeline-track-label, \.timeline-track-lane["']\)/);
  assert.match(handler, /selectTimelineMotor\(track\.dataset\.motorId\)/);

  const events = functionSource("initEvents");
  const delegatedSelection = events.indexOf('$("timelineTracks").addEventListener("click", handleTimelineTrackSelection)');
  const delegatedClip = events.indexOf('$("timelineTracks").addEventListener("click", selectTimelineClip)');
  assert.ok(delegatedSelection >= 0 && delegatedClip > delegatedSelection, "track selection must ignore clips before the clip editor handles them");
});

test("the selected motor is highlighted across its label and complete timeline lane", () => {
  const tracks = functionSource("renderTimelineTracks");
  assert.match(tracks, /const trackSelected = motor\.id === selectedTimelineMotorId\(\)/);
  assert.match(tracks, /row\.className = `timeline-track-row\$\{trackSelected \? " selected-track" : ""\}`/);
  assert.match(tracks, /row\.dataset\.motorId = motor\.id/);
  assert.match(tracks, /label\.className = `[^`]*\$\{trackSelected \? " selected-track" : ""\}`/);
  assert.match(tracks, /label\.dataset\.motorId = motor\.id/);
  assert.match(tracks, /name\.className = "timeline-track-select-button"/);
  assert.match(tracks, /name\.setAttribute\("aria-pressed", String\(trackSelected\)\)/);
  assert.match(tracks, /lane\.className = `timeline-track-lane\$\{trackSelected \? " selected-track" : ""\}`/);
  assert.match(tracks, /lane\.dataset\.motorId = motor\.id/);
  assert.match(styles, /\.timeline-track-label\.selected-track\s*\{/);
  assert.match(styles, /\.timeline-track-lane\.selected-track\s*\{/);
});

test("timeline tracks follow dynamic group order and render non-interactive group dividers", () => {
  const tracks = functionSource("renderTimelineTracks");
  assert.match(tracks, /for\s*\(const group of state\.groups\)/);
  assert.match(tracks, /motor\.group\s*===\s*group\.id/);
  assert.match(tracks, /timeline-group-divider/);
  assert.match(tracks, /group\.label/);
  assert.match(tracks, /groupMotors\.length|motorsInGroup\.length|groupedMotors\.length/,
    "empty groups should not consume vertical timeline space");

  const targetLookup = functionSource("timelineLaneAtPoint");
  assert.match(targetLookup, /\.timeline-track-lane, \.timeline-track-label/);
  assert.doesNotMatch(targetLookup, /timeline-group-divider/,
    "a divider must never become a cross-track drag target");

  assert.match(
    styles,
    /\.timeline-group-divider(?:\s*\{[^}]*grid-column:\s*1\s*\/\s*-1|-(?:label|lane)\b)/,
  );
});

test("clicking an existing action still opens action edit mode and cross-lane drag follows its target motor", () => {
  const clip = functionSource("selectTimelineClip");
  const lookup = clip.indexOf("state.timeline.get(clip.dataset.actionId)");
  const selected = clip.indexOf("state.selectedTimelineActionId = action.actionId");
  const loaded = clip.indexOf("loadTimelineActionIntoEditor(action)");
  assert.ok(lookup >= 0 && selected > lookup && loaded > selected, "an action clip must load that action rather than reset the editor");

  const load = functionSource("loadTimelineActionIntoEditor");
  assert.match(load, /setSelectedTimelineMotorId\(action\.motorId\)/);
  const finish = functionSource("finishTimelineDrag");
  assert.match(finish, /motorId:\s*drag\.targetMotorId/);
  assert.match(finish, /loadTimelineActionIntoEditor\(updated\)/);
});

test("timeline actions persist and load through the existing local state document", () => {
  assert.match(app, /timeline:\s*new timelineModel\.TimelineProgram\(\)/);
  assert.match(app, /storedTimeline\.actions\.slice\(0,\s*timelineModel\.MAX_ACTIONS\)/);
  const persistence = functionSource("persistedStateDocument");
  assert.match(persistence, /timeline:\s*\{/);
  assert.match(persistence, /actions:\s*state\.timeline\.snapshot\(\)/);
  assert.match(html, /src="\.\.\/src\/timeline-model\.js"[\s\S]*src="app\.js"/);
});

test("pointer drag snaps horizontal time and can target another motor lane", () => {
  const begin = functionSource("beginTimelineDrag");
  const move = functionSource("moveTimelineDrag");
  const finish = functionSource("finishTimelineDrag");
  assert.match(begin, /setPointerCapture\(event\.pointerId\)/);
  assert.match(move, /millisecondsFromPixels/);
  assert.match(move, /snapStartMs/);
  assert.match(move, /targetMotorId/);
  assert.match(finish, /state\.timeline\.update/);
  assert.match(finish, /motorId:\s*drag\.targetMotorId/);
  assert.match(finish, /persistState\(true\)/);
});

test("same-time groups send concurrently while same-node conflicts block playback", () => {
  const dispatch = functionSource("dispatchTimelineGroup");
  const playStart = app.indexOf("async function playTimeline");
  const playEnd = app.indexOf("\nasync function ", playStart + 1);
  const play = app.slice(playStart, playEnd);
  assert.match(dispatch, /Promise\.all\(group\.items\.map/);
  assert.match(dispatch, /transmit\(command,\s*timelineRunSource\(run\)/);
  assert.match(dispatch, /requireTimelineTrackEnabled:\s*run\.requireTimelineTrackEnabled\s*!==\s*false/);
  assert.match(play, /sourceLabel:\s*"电机控制时间轴"/);
  assert.match(play, /requireTimelineTrackEnabled:\s*true/);
  assert.match(play, /timelineConflictsForActions\(actions\)/);
  assert.match(play, /物理上不能同时执行/);
  assert.doesNotMatch(play, /moreThanFifoCapacity/);
  assert.match(app, /function timelineGroupQueueIssue/);
  assert.match(app, /queueCapacity/);
});

test("timeline playback starts its clock only after the initial timeline render", () => {
  const play = functionSource("playTimeline");
  const runCreated = play.indexOf("const run = {");
  const nullClock = play.indexOf("startedAt: null", runCreated);
  const render = play.indexOf("renderTimeline()", nullClock);
  const startClock = play.indexOf("run.startedAt = performance.now()", render);
  const firstTick = play.indexOf("timelinePlaybackTick(run)", startClock);

  assert.ok(runCreated >= 0 && nullClock > runCreated,
    "the run must remain unclocked while its initial UI state is assembled");
  assert.ok(render > nullClock && startClock > render && firstTick > startClock,
    "initial render must finish before the playback clock starts and the first tick runs");
  assert.doesNotMatch(
    play.slice(runCreated, render),
    /performance\.now\(\)/,
    "rendering time must not consume any of the animation schedule",
  );
});

test("operations cannot start while configuration file I/O is active", () => {
  const source = functionSource("beginOperation");
  const guard = source.indexOf("state.configIoBusy");
  const mutation = source.indexOf("state.busy = true");
  assert.ok(guard >= 0 && mutation > guard, "beginOperation must reject config I/O before changing operation state");
  assert.match(source.slice(0, mutation), /return\s+null/);
});

test("timeline preflight is cancelled by STOP, disconnect, emergency, or configuration I/O", () => {
  for (const name of ["playTimeline", "testTimelineAction"]) {
    const source = functionSource(name);
    const captured = source.indexOf("const preflightEpoch = state.operationEpoch");
    const awaited = source.indexOf("await requireIdle");
    const checked = source.indexOf("state.operationEpoch !== preflightEpoch");
    const configChecked = source.indexOf("state.configIoBusy", awaited);
    const begin = source.indexOf("beginOperation(");
    assert.ok(captured >= 0 && awaited > captured && checked > awaited && begin > checked, `${name} must fence its preflight`);
    assert.ok(configChecked > awaited && configChecked < begin, `${name} must recheck config I/O after its asynchronous preflight`);
  }
});

test("an empty motor catalog disables action editing but leaves project-level timeline tools usable", () => {
  const controls = functionSource("renderTimelineControls");
  assert.match(controls, /const\s+noMotors\s*=\s*state\.motors\.length\s*===\s*0/);
  const actionGroupStart = controls.indexOf('"timelineStartInput"');
  const actionGroupEnd = controls.indexOf('for (const id of [', actionGroupStart + 1);
  const projectGroupEnd = controls.indexOf('for (const button of document.querySelectorAll', actionGroupEnd);
  assert.ok(actionGroupStart >= 0 && actionGroupEnd > actionGroupStart && projectGroupEnd > actionGroupEnd);
  const actionGroup = controls.slice(actionGroupStart, actionGroupEnd);
  const projectGroup = controls.slice(actionGroupEnd, projectGroupEnd);
  for (const id of [
    "timelineStartInput",
    "timelineStepsInput",
    "timelineSpeedInput",
    "timelineAccelerationInput",
    "timelineLoopModeSelect",
    "timelineSaveActionButton",
  ]) assert.match(actionGroup, new RegExp(`"${id}"`));
  assert.match(actionGroup, /\$\(id\)\.disabled\s*=\s*locked\s*\|\|\s*noMotors/);

  for (const id of [
    "timelineDurationInput",
    "timelineSnapSelect",
    "timelineZoomInput",
    "timelineSaveProjectButton",
    "timelineImportProjectButton",
    "timelineExportProjectButton",
  ]) assert.match(projectGroup, new RegExp(`"${id}"`));
  assert.match(projectGroup, /\$\(id\)\.disabled\s*=\s*locked/);
  assert.doesNotMatch(projectGroup, /noMotors/);
  assert.match(controls, /timeline-direction-button[\s\S]{0,100}button\.disabled\s*=\s*locked\s*\|\|\s*noMotors/);
});

test("every dynamically configured timeline position has an independent enable checkbox that saves immediately", () => {
  const tracks = functionSource("renderTimelineTracks");
  assert.match(tracks, /for\s*\(const motor of (?:state\.motors|groupedMotors)\)/);
  assert.match(tracks, /enableInput\.className\s*=\s*["']timeline-track-enable-input["']/);
  assert.match(tracks, /enableInput\.type\s*=\s*["']checkbox["']/);
  assert.match(tracks, /enableInput\.checked\s*=\s*positionEnabled/);
  assert.match(tracks, /enableInput\.dataset\.motorId\s*=\s*motor\.id/);
  assert.match(tracks, /enableControl\.className\s*=\s*["']timeline-track-enable-control["']/);

  const setter = functionSource("setTimelineTrackEnabled");
  const assignment = setter.indexOf("state.timelineTrackEnabled[motorId] = enabled");
  const revision = setter.indexOf("state.timelineEnableRevision += 1");
  const persistence = setter.indexOf("persistState(true)");
  assert.ok(assignment >= 0 && revision > assignment && persistence > revision);

  const events = functionSource("initEvents");
  assert.match(events, /timelineTracks["']\)\.addEventListener\(["']change["']/);
  assert.match(events, /handleTimelineTrackEnableChange/);
  const handler = functionSource("handleTimelineTrackEnableChange");
  assert.match(handler, /\.timeline-track-enable-input/);
  assert.match(handler, /setTimelineTrackEnabled\(input\.dataset\.motorId,\s*input\)/);
  assert.match(styles, /\.timeline-track-enable-control\b/);
});

test("timeline action testing checks track enable before and after asynchronous preflight", () => {
  const source = functionSource("testTimelineAction");
  const firstGate = source.indexOf("!timelineTrackIsEnabled(action.motorId)");
  const capturedRevision = source.indexOf("const enableRevision = state.timelineEnableRevision");
  const preflight = source.indexOf("await requireIdleNodes");
  const checkedRevision = source.indexOf("state.timelineEnableRevision !== enableRevision", preflight);
  const secondGate = source.indexOf("!timelineTrackIsEnabled(action.motorId)", preflight);
  const begin = source.indexOf('beginOperation("测试时间轨动作")');
  const transmit = source.indexOf("await transmit(command");

  assert.ok(firstGate >= 0 && firstGate < capturedRevision && capturedRevision < preflight, "timeline test must reject a disabled track and capture its revision before preflight");
  assert.ok(checkedRevision > preflight && checkedRevision < begin, "timeline test must reject enable changes during preflight");
  assert.ok(secondGate > preflight && secondGate < begin, "timeline test must recheck the selected track after preflight");
  assert.ok(transmit > begin, "timeline test may transmit only after both enable checks");
});

test("timeline commands preserve loop mode and closed actions share the safety preflight", () => {
  const editor = functionSource("timelineDraftFromEditor");
  const command = functionSource("timelineCommand");
  assert.match(editor, /closed:\s*\$\("timelineLoopModeSelect"\)\.value\s*===\s*["']closed["']/);
  assert.match(command, /closed:\s*action\.closed/);

  const idle = functionSource("requireIdleNodes");
  const idleStatus = idle.indexOf("requireIdleNodeIds");
  const closedStatus = idle.indexOf("confirmClosedLoopReady");
  assert.ok(idleStatus >= 0 && closedStatus > idleStatus,
    "FIFO/idle checks must complete before closed-loop validity is accepted");

  for (const name of ["testTimelineAction", "playTimeline"]) {
    const source = functionSource(name);
    const commands = source.indexOf(name === "testTimelineAction" ? "timelineCommand(action)" : "const commands =");
    const preflight = source.indexOf("await requireIdleNodes", commands);
    const begin = source.indexOf("beginOperation(", preflight);
    assert.ok(commands >= 0 && preflight > commands && begin > preflight,
      `${name} must preflight closed-loop readiness before beginning transmission`);
  }
});

test("timeline playback filters out disabled tracks instead of blocking the animation", () => {
  const source = functionSource("playTimeline");
  const allActions = source.indexOf("const allActions = state.timeline.snapshot()");
  const enabledActions = source.indexOf("const actions = enabledTimelineActions(allActions)");
  const stale = source.indexOf("actions.find((action) => !timelineActionBindingCurrent(action))");
  const conflicts = source.indexOf("timelineConflictsForActions(actions)");
  const groups = source.indexOf("groupTimelineActions(actions)");
  const capturedRevision = source.indexOf("const enableRevision = state.timelineEnableRevision");
  const preflight = source.indexOf("await requireIdleNodes(commands)");
  const checkedRevision = source.indexOf("state.timelineEnableRevision !== enableRevision", preflight);
  const secondGate = source.indexOf("actions.some((action) => !timelineTrackIsEnabled(action.motorId))", preflight);
  const begin = source.indexOf('beginOperation("时间轨播放")');

  assert.ok(allActions >= 0 && enabledActions > allActions, "playback must derive enabled actions from the complete animation");
  assert.ok(stale > enabledActions && conflicts > enabledActions && groups > enabledActions, "stale, conflict, and scheduling checks must use only enabled actions");
  assert.ok(capturedRevision > enabledActions && capturedRevision < preflight);
  assert.ok(checkedRevision > preflight && checkedRevision < begin, "playback must reject track-enable changes during preflight");
  assert.ok(secondGate > preflight && secondGate < begin, "playback must recheck enabled tracks after preflight");
  assert.match(source, /skippedCount:\s*allActions\.length\s*-\s*actions\.length/);
  assert.doesNotMatch(source, /state\.timeline\.conflicts\(\)|disabledAction|整段时间轨未发送/);
});

test("timeline controls test only an enabled editor track and allow partial playback", () => {
  const controls = functionSource("renderTimelineControls");
  assert.match(controls, /const\s+activeActions\s*=\s*enabledTimelineActions\(actions\)/);
  assert.match(controls, /const\s+stale\s*=\s*activeActions\.some/);
  assert.match(controls, /timelineConflictsForActions\(activeActions\)/);
  assert.match(controls, /const\s+editorTrackEnabled\s*=\s*timelineTrackIsEnabled\(/);
  assert.match(controls, /timelineTestButton["']\)\.disabled\s*=[^;]*!editorTrackEnabled/);
  assert.match(controls, /timelinePlayButton["']\)\.disabled\s*=[^;]*!activeActions\.length[^;]*stale[^;]*conflicts/);
  assert.doesNotMatch(controls, /disabled\s*=\s*actions\.some|!timelineTrackIsEnabled\(action\.motorId\)/);

  assert.match(controls, /timelineTrackIsEnabled\(selectedTimelineMotorId\(\)\)/);
  const hint = functionSource("refreshTimelineBindingHint");
  assert.match(hint, /const motorId = selectedTimelineMotorId\(\)/);
  assert.match(hint, /时间轨已使能/);
  assert.match(hint, /时间轨未使能/);

  const status = functionSource("timelineStatusText");
  assert.match(status, /enabledTimelineActions\(actions\)/);
  assert.match(status, /activeActions\.filter\(\(action\)\s*=>\s*!timelineActionBindingCurrent\(action\)\)/);
  assert.match(status, /未使能轨道的动作会跳过/);
});

test("timeline never bursts an unbounded backlog after a renderer stall", () => {
  const tick = functionSource("timelinePlaybackTick");
  assert.doesNotMatch(tick, /while\s*\(/);
  assert.match(tick, /lateness\s*>\s*TIMELINE_MAX_LATE_MS/);
  assert.match(tick, /stopTimelinePlayback/);
  assert.match(app, /const TIMELINE_MAX_LATE_MS = 250/);
});

test("idle and drain checks require a new ordered Status A and D pair", () => {
  const idle = functionSource("nodeStatusIsFreshAndIdle");
  const transmit = functionSource("transmit");
  const events = functionSource("handleDriverEvent");
  assert.match(idle, /lastStatusAAt/);
  assert.match(idle, /lastStatusDAt/);
  assert.match(idle, /statusDAt >= statusAAt/);
  assert.match(idle, /expectedSequence/);
  assert.match(idle, /lastMotionSequence/);
  assert.match(idle, /!hasFault/);
  assert.match(transmit, /lastStatusAAt = 0/);
  assert.match(transmit, /lastStatusDAt = 0/);
  assert.match(events, /data\.part === "A"/);
  assert.match(events, /data\.part === "D"/);
});

test("timeline drain fences each node at its final accepted motion sequence", () => {
  const dispatch = functionSource("dispatchTimelineGroup");
  const tick = functionSource("timelinePlaybackTick");
  const testAction = functionSource("testTimelineAction");
  assert.match(dispatch, /drainFenceByNode\.set/);
  assert.match(dispatch, /outcome\.result\?\.sequence/);
  assert.match(tick, /fence\.acceptedAt, fence\.sequence/);
  assert.match(testAction, /test\.expectedSequence/);
});

test("timeline stop continuations cannot cross into another CAN connection", () => {
  const stop = functionSource("stopTimelinePlayback");
  assert.match(stop, /const connectionEpoch = state\.connectionEpoch/);
  assert.match(stop, /token !== state\.operationEpoch/);
  assert.match(stop, /connectionEpoch !== state\.connectionEpoch/);
});

test("motion is logged to the origin ledger only after its matching hardware ACK", () => {
  const transmit = functionSource("transmit");
  const sent = transmit.indexOf("await api.move(payload)");
  const waited = transmit.indexOf("await waitForMotionAck(command.nodeId, result.sequence)");
  const accepted = transmit.indexOf("if (!ack.ok)");
  const recorded = transmit.indexOf("state.ledger.recordSuccess(command)");
  assert.ok(sent >= 0 && waited > sent && accepted > waited && recorded > accepted);
  assert.match(app, /const MOTION_ACK_TIMEOUT_MS = 1_000/);
  assert.match(functionSource("handleDriverEvent"), /receiveMotionAck\(data\)/);
});

test("stopping a timeline cancels future scheduling then stops every involved node", () => {
  const stopStart = app.indexOf("async function stopTimelinePlayback");
  const stopEnd = app.indexOf("\nasync function ", stopStart + 1);
  const stop = app.slice(stopStart, stopEnd);
  const detach = stop.indexOf("detachTimelineRun()");
  const broadcast = stop.indexOf("broadcast: true");
  const addressed = stop.indexOf("run.involvedNodes.map");
  assert.ok(detach >= 0 && broadcast > detach && addressed > broadcast);
  assert.match(stop, /immediate:\s*true/);
  assert.match(stop, /invalidateOrigin\(/);
});

test("timeline model explains that the axis is send time rather than physical completion", () => {
  assert.match(html, /时间点\s*=\s*指令发送时间/);
  assert.match(html, /实际起转仍由 CAN 与电机 FIFO 决定/);
});
