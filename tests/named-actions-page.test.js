"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "renderer", "app.js"), "utf8");
const controller = fs.readFileSync(path.join(root, "renderer", "named-actions.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "renderer", "styles.css"), "utf8");

function functionSource(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `${name} must exist`);
  const remainder = source.slice(match.index + match[0].length);
  const next = remainder.search(/\n\s*(?:async\s+)?function\s+\w+\s*\(/);
  return source.slice(match.index, next < 0 ? source.length : match.index + match[0].length + next);
}

function pageSource(pageId, nextMarker) {
  const start = html.indexOf(`<main id="${pageId}"`);
  assert.ok(start >= 0, `${pageId} must exist`);
  const end = html.indexOf(nextMarker, start + 1);
  assert.ok(end > start, `${pageId} must have a closing boundary`);
  return html.slice(start, end);
}

test("named action scripts load before the application and expose one controller boundary", () => {
  const modelIndex = html.indexOf('src="../src/action-library.js"');
  const controllerIndex = html.indexOf('src="named-actions.js"');
  const appIndex = html.indexOf('src="app.js"');
  assert.ok(modelIndex >= 0 && controllerIndex > modelIndex && appIndex > controllerIndex);
  assert.match(controller, /root\.LumNamedActions\s*=\s*Object\.freeze\(\{/);
  for (const method of [
    "initialize", "initEvents", "loadStoredState", "persistedStateFields",
    "reconcileMotorCatalog", "renderPage", "renderControls", "cancelInteractions",
  ]) assert.match(controller, new RegExp(`\\b${method},`));
});

test("the original raw motor timeline remains intact under its clearer visible name", () => {
  assert.match(
    html,
    /id="timelineEditorTab"[^>]*aria-controls="timelineEditorPage"[^>]*>电机控制时间轴</,
  );
  for (const id of [
    "timelineActionForm", "timelineSelectedMotor", "timelineStartInput", "timelineStepsInput",
    "timelineSpeedInput", "timelineAccelerationInput", "timelineTracks", "timelinePlayButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /timeline:\s*new timelineModel\.TimelineProgram\(\)/);
  assert.match(functionSource(app, "playTimeline"), /surface:\s*"motorTimeline"/);
});

test("动作编辑 builds a named action from one or many independently timed motor motions", () => {
  const page = pageSource("namedActionEditorPage", '<main id="actionTimelinePage"');
  for (const id of [
    "namedActionNameInput", "namedActionSaveButton", "namedActionDefinitionList",
    "namedMotionMotorSelect", "namedMotionStartInput", "namedMotionStepsInput",
    "namedMotionSpeedInput", "namedMotionAccelerationInput", "namedMotionLoopModeSelect",
    "namedMotionAddButton", "namedMotionList", "namedMotionTestButton", "namedActionTestButton",
  ]) assert.match(page, new RegExp(`id="${id}"`));
  assert.match(page, /id="namedMotionLoopModeSelect"[\s\S]*value="open"[^>]*selected[^>]*>开环<[\s\S]*value="closed"[^>]*>闭环</);
  assert.match(page, /id="namedMotionStartInput"[^>]*min="0"[^>]*max="600000"/);

  const addMotion = functionSource(controller, "addDraftMotion");
  assert.match(addMotion, /draftMotions\.push\(\{\s*\.\.\.motionDraftFromForm\(\)\s*\}\)/);
  assert.match(addMotion, /MAX_MOTIONS_PER_DEFINITION/);
  const save = functionSource(controller, "saveDefinition");
  assert.match(save, /library\.update\(draftDefinitionId, input\)/);
  assert.match(save, /library\.add\(input\)/);
  assert.match(save, /persistState\(true\)/);
  assert.match(functionSource(controller, "testCurrentMotion"), /playExpandedPlan/);
  assert.match(functionSource(controller, "testDraftDefinition"), /playExpandedPlan/);
  assert.match(styles, /\.named-action-page\b/);
  assert.match(styles, /\.named-motion-row\b/);
});

test("动作时间轴 uses a visible searchable action palette instead of a select", () => {
  const page = pageSource("actionTimelinePage", '<div id="motorCreateModal"');
  for (const id of [
    "actionTimelineSearchInput", "actionTimelineDefinitionPalette", "actionTimelineAddButton",
    "actionTimelineAddTrackButton", "actionTimelineTrackCount",
    "actionTimelinePlayButton",
    "actionTimelineStopButton", "actionTimelineDurationInput", "actionTimelineSnapSelect",
    "actionTimelineZoomInput", "actionTimelineRuler", "actionTimelineTracks",
    "actionTimelinePlayhead", "actionTimelineScroller",
  ]) assert.match(page, new RegExp(`id="${id}"`));
  assert.doesNotMatch(page, /id="actionTimelineDefinitionSelect"/);
  assert.doesNotMatch(page, /<select[^>]+(?:动作|actionTimelineDefinition)/);
  for (const className of [
    "action-sequence-workspace", "action-palette", "action-timeline-stage",
  ]) assert.match(page, new RegExp(`class="[^"]*\\b${className}\\b`));
  assert.doesNotMatch(page, /namedMotion(?:Motor|Start|Steps|Speed|Acceleration|LoopMode)/);
  assert.doesNotMatch(page, /timeline(?:SelectedMotor|StepsInput|SpeedInput|AccelerationInput)/);

  const palette = functionSource(controller, "renderActionPalette");
  assert.match(palette, /normalizeTimelineDefinitionSelection\(\)/);
  assert.match(
    functionSource(controller, "normalizeTimelineDefinitionSelection"),
    /library\.snapshot\(\)/,
  );
  assert.match(palette, /actionTimelineSearchInput/);
  assert.match(palette, /action-palette-card/);
  assert.match(palette, /action-palette-select/);
  assert.match(palette, /action-palette-quick-add/);
  assert.match(palette, /dataset\.actionDefinitionId/);
  assert.match(palette, /draggable\s*=\s*!locked/);
  assert.match(styles, /\.action-sequence-workspace\b/);
  assert.match(styles, /\.action-palette\b/);
  assert.match(styles, /\.action-palette-card\b/);
  assert.match(styles, /\.action-timeline-stage\b/);
});

test("action palette cards select, double-click to add, and drag onto an exact timeline time", () => {
  const select = functionSource(controller, "selectPaletteDefinition");
  assert.match(select, /closest\(["']\.action-palette-card["']\)/);
  assert.match(select, /actionDefinitionId\s*=\s*card\.dataset\.actionDefinitionId/);
  assert.match(select, /setSelectedTimelineDefinition\(actionDefinitionId\)/);
  const setSelected = functionSource(controller, "setSelectedTimelineDefinition");
  assert.match(setSelected, /selectedTimelineDefinitionId\s*=\s*actionDefinitionId/);

  const begin = functionSource(controller, "beginPaletteDrag");
  assert.match(begin, /closest\(["']\.action-palette-card["']\)/);
  assert.match(begin, /dataset\.actionDefinitionId/);
  assert.match(begin, /dataTransfer/);

  const startFromPointer = functionSource(controller, "actionTimelineStartFromClientX");
  assert.match(startFromPointer, /millisecondsFromPixels/);
  assert.match(startFromPointer, /snapStartMs/);

  const drop = functionSource(controller, "dropPaletteAction");
  assert.match(drop, /preventDefault\(\)/);
  assert.match(drop, /actionTimelineStartFromClientX\(/);
  assert.match(drop, /addPlacement\(actionDefinitionId,\s*cursorMs,\s*trackId\)/);

  const events = functionSource(controller, "initEvents");
  assert.match(events, /actionTimelineDefinitionPalette[\s\S]*addEventListener\(["']click["']/);
  assert.match(events, /actionTimelineDefinitionPalette[\s\S]*addEventListener\(["']dblclick["']/);
  assert.match(events, /actionTimelineDefinitionPalette[\s\S]*addEventListener\(["']dragstart["']/);
  assert.match(events, /actionTimelineDefinitionPalette[\s\S]*addEventListener\(["']dragend["']/);
  assert.match(events, /actionTimeline(?:Tracks|Scroller)[\s\S]*addEventListener\(["']dragover["']/);
  assert.match(events, /actionTimeline(?:Tracks|Scroller)[\s\S]*addEventListener\(["']drop["']/);
});

test("palette additions remain repeatable and placed timeline clips remain horizontally draggable", () => {
  const add = functionSource(controller, "addPlacement");
  assert.match(add, /sequence\.add\(\{[\s\S]*actionDefinitionId,[\s\S]*startMs:\s*(?:cursorMs|placementStartMs|requestedStartMs)[\s\S]*trackId[\s\S]*\}\)/);
  assert.doesNotMatch(add, /sequence\.(?:get|update)\([^)]*actionDefinitionId/,
    "adding the same named action again must create another placement");
  assert.match(
    functionSource(controller, "addPlacementAtCursor"),
    /addPlacement\(selectedTimelineDefinitionId,\s*cursorMs,\s*selectedTrackId\)/,
  );
  const drag = functionSource(controller, "finishPlacementDrag");
  assert.match(drag, /sequence\.update\(drag\.placement\.placementId,\s*\{[\s\S]*startMs:\s*drag\.previewStartMs[\s\S]*trackId:\s*drag\.previewTrackId[\s\S]*\}\)/);
  assert.match(drag, /persistState\(true\)/);
  assert.match(functionSource(controller, "clearActionTimeline"), /sequence\.clear\(\)/);
  assert.match(styles, /\.action-sequence-page\b/);
  assert.match(styles, /\.action-sequence-clip\b/);
});

test("动作时间轴 provides explicit tracks that can be added, renamed, selected, and deleted", () => {
  const page = pageSource("actionTimelinePage", '<div id="motorCreateModal"');
  assert.match(page, /id="actionTimelineAddTrackButton"/);
  assert.match(page, /id="actionTimelineTrackCount"/);
  assert.match(styles, /\.action-track-name-input\b/);
  assert.match(styles, /\.action-track-delete-button\b/);

  const add = functionSource(controller, "addActionTrack");
  assert.match(add, /actionTracks\.add\(/);
  assert.match(add, /setSelectedActionTrack\(/);
  assert.match(add, /persistState\(true\)/);

  const rename = functionSource(controller, "renameActionTrack");
  assert.match(rename, /actionTracks\.update\(/);
  assert.match(rename, /persistState\(true\)/);

  const remove = functionSource(controller, "deleteActionTrack");
  assert.match(remove, /actionTracks\.size\s*<=\s*1/,
    "the final track must remain available as a drop target");
  assert.match(remove, /placement\.trackId\s*===\s*track\.trackId/);
  assert.match(remove, /sequence\.remove\(placementId\)/,
    "deleting a populated track must not leave orphaned placements");
  assert.match(remove, /actionTracks\.remove\(/);
  assert.match(remove, /persistState\(true\)/);

  const select = functionSource(controller, "setSelectedActionTrack");
  assert.match(select, /selectedTrackId\s*=/);
  const render = functionSource(controller, "renderActionTimelineTracks");
  assert.match(render, /actionTracks\.snapshot\(\)/);
  assert.match(render, /row\.dataset\.trackId\s*=\s*track\.trackId/);
  assert.match(render, /lane\.dataset\.trackId\s*=\s*track\.trackId/);
  assert.match(render, /action-track-name-input/);
  assert.match(render, /action-track-delete-button/);
});

test("palette drops and existing clips can target a specific action track", () => {
  const trackAtPointer = functionSource(controller, "actionTrackIdFromClientY");
  assert.match(trackAtPointer, /clientY/);
  assert.match(trackAtPointer, /dataset\.trackId/);

  const drop = functionSource(controller, "dropPaletteAction");
  assert.match(drop, /actionTrackIdFromClientY\(event\.clientY\)/);
  assert.match(drop, /addPlacement\(actionDefinitionId,\s*cursorMs,\s*trackId\)/);

  const drag = functionSource(controller, "movePlacementDrag");
  assert.match(drag, /actionTrackIdFromClientY\(event\.clientY\)/);
  assert.match(drag, /previewTrackId/);
  const finish = functionSource(controller, "finishPlacementDrag");
  assert.match(finish, /trackId:\s*drag\.previewTrackId/);
});

test("same-time actions remain parallel across tracks while physical CAN ID conflicts stay global", () => {
  const expanded = functionSource(controller, "expandedSequence");
  assert.match(expanded, /for\s*\(const placement of placements\)/);
  assert.match(expanded, /placement\.startMs\s*\+\s*motion\.startMs/);
  assert.doesNotMatch(expanded, /selectedTrackId/,
    "playback expansion must include every track, not only the selected track");

  const conflicts = functionSource(controller, "expandedConflicts");
  assert.match(conflicts, /entry\.startMs/);
  assert.match(conflicts, /entry\.motion\.nodeId/);
  assert.doesNotMatch(conflicts, /trackId/,
    "the same physical CAN node at the same time must conflict even on different tracks");

  const play = functionSource(controller, "playActionTimeline");
  assert.match(play, /placements\.flatMap/);
  assert.match(play, /playExpandedPlan/);
  assert.match(functionSource(app, "dispatchTimelineGroup"), /Promise\.all\(group\.items\.map/);
});

test("schema 12 stores action timeline schema 2 tracks and placements separately", () => {
  const persisted = functionSource(app, "persistedStateDocument");
  assert.match(persisted, /schemaVersion:\s*12/);
  assert.match(persisted, /timeline:\s*\{/);
  assert.match(persisted, /\.\.\.window\.LumNamedActions\.persistedStateFields\(\)/);
  assert.match(functionSource(app, "loadStoredState"), /window\.LumNamedActions\.loadStoredState\(stored/);

  const namedPersisted = functionSource(controller, "persistedStateFields");
  assert.match(namedPersisted, /namedActions:\s*\{[\s\S]*definitions:\s*library\.snapshot\(\)/);
  assert.match(namedPersisted, /actionTimeline:\s*\{[\s\S]*schemaVersion:\s*2/);
  assert.match(namedPersisted, /tracks:\s*actionTracks\.snapshot\(\)/);
  assert.match(namedPersisted, /placements:\s*sequence\.snapshot\(\)/);
  const load = functionSource(controller, "loadStoredState");
  assert.match(load, /stored\?\.namedActions\?\.definitions/);
  assert.match(load, /stored\?\.actionTimeline\?\.tracks/);
  assert.match(load, /stored\?\.actionTimeline\?\.placements/);
  assert.match(load, /MAX_ACTION_DEFINITIONS/);
  assert.match(load, /MAX_ACTION_TRACKS/);
  assert.match(load, /MAX_PLACEMENTS/);
});

test("legacy action timelines without tracks migrate deterministically and never load trackless", () => {
  const load = functionSource(controller, "loadStoredState");
  assert.match(load, /schemaVersion/);
  assert.match(load, /actionDefinitionId/,
    "legacy placements must be grouped into deterministic action-definition tracks");
  assert.match(load, /trackId/);
  assert.match(load, /轨道 1/,
    "an empty legacy document must still receive a default track");
  assert.match(load, /actionTracks\.(?:import|add)\(/);
  assert.match(load, /sequence\.add\(/);
});

test("named actions reuse the protected timeline scheduler without low-level track-enable filtering", () => {
  const preflight = functionSource(controller, "playExpandedPlan");
  assert.match(preflight, /validateExpandedPlan\(expanded\)/);
  assert.match(preflight, /await requireIdleNodes\(commands\)/);
  assert.match(preflight, /state\.operationEpoch !== operationEpoch/);
  assert.match(preflight, /state\.connectionEpoch !== connectionEpoch/);
  assert.match(preflight, /library\.revision !== libraryRevision/);
  assert.match(preflight, /launchNamedTimelineRun\(\{/);
  assert.match(functionSource(controller, "validateExpandedPlan"), /expandedConflicts\(expanded\)/);

  const launch = functionSource(app, "launchNamedTimelineRun");
  assert.match(launch, /state\.timelineRun\s*=\s*run/);
  assert.match(launch, /requireTimelineTrackEnabled:\s*false/);
  assert.match(launch, /window\.LumNamedActions\.preparePlayback\(run\)/);
  assert.match(launch, /timelinePlaybackTick\(run\)/);
  const dispatch = functionSource(app, "dispatchTimelineGroup");
  assert.match(dispatch, /Promise\.all\(group\.items\.map/);
  assert.match(dispatch, /requireTimelineTrackEnabled:\s*run\.requireTimelineTrackEnabled\s*!==\s*false/);
  assert.match(functionSource(app, "stopTimelinePlayback"), /run\.involvedNodes/);
});

test("motor catalog replacement removes whole affected definitions and their placements", () => {
  const impact = functionSource(controller, "motorCatalogRemovalImpact");
  assert.match(impact, /definition\.motions\.some/);
  assert.match(impact, /removedDefinitions/);
  assert.match(impact, /removedPlacements/);
  const reconcile = functionSource(controller, "reconcileMotorCatalog");
  assert.match(reconcile, /sequence\.remove\(placement\.placementId\)/);
  assert.match(reconcile, /library\.remove\(actionDefinitionId\)/);
  assert.match(functionSource(app, "installMotorCatalog"), /window\.LumNamedActions\.reconcileMotorCatalog\(allowedMotorIds\)/);
});

test("high-level placements cannot schedule an internal motor send past 600000 ms", () => {
  const maximumStart = functionSource(controller, "maximumPlacementStartMs");
  assert.match(maximumStart, /definitionOrMotions\?\.motions/);
  assert.match(maximumStart, /motion\.startMs/);
  assert.match(maximumStart, /actionModel\.MAX_START_MS\s*-\s*latestRelativeStartMs/);

  const analysis = functionSource(controller, "actionTimelineAnalysis");
  assert.match(analysis, /overflowEntries/);
  assert.match(analysis, /startMs\s*>\s*actionModel\.MAX_START_MS/);
  assert.match(analysis, /overflowPlacementIds/);
  const status = functionSource(controller, "actionTimelineStatusText");
  assert.match(status, /analysis\.overflowEntries\.length/);
  const tracks = functionSource(controller, "renderActionTimelineTracks");
  assert.match(tracks, /analysis\.overflowPlacementIds/);
  assert.match(tracks, /overflow/);

  const controls = functionSource(controller, "renderActionTimelineControls");
  assert.match(controls, /const overflows\s*=\s*analysis\.overflowEntries\.length\s*>\s*0/);
  assert.match(controls, /actionTimelinePlayButton[\s\S]*overflows/,
    "an existing overflow placement must disable playback");
  assert.match(controls, /maximumPlacementStartMs/);
  assert.match(controls, /renderSelectedDefinitionControl\(\)/);
  const selectedControl = functionSource(controller, "renderSelectedDefinitionControl");
  assert.match(selectedControl, /const fits\s*=\s*!definition\s*\|\|\s*cursorMs\s*<=\s*maximumPlacementStartMs\(definition\)/);
  assert.match(selectedControl, /addButton\.disabled\s*=\s*[^;]*!fits/,
    "the Add button must identify a cursor past the selected definition's legal start");

  const add = functionSource(controller, "addPlacement");
  assert.match(add, /maximumPlacementStartMs\(definition\)/);
  assert.match(add, /Math\.min\([\s\S]*requestedStartMs[\s\S]*maximumPlacementStartMs\(definition\)/,
    "Add must clamp the requested placement to the latest legal start");
  const drag = functionSource(controller, "movePlacementDrag");
  assert.match(drag, /maximumPlacementStartMs\(/);
  assert.match(drag, /timelineModel\.snapStartMs\([\s\S]*Math\.min\(durationMs,\s*maximumStartMs\)/,
    "horizontal drag must clamp its preview using the dragged definition's legal start");
  assert.match(functionSource(controller, "validateExpandedPlan"), /startMs\s*>\s*actionModel\.MAX_START_MS/);
});

test("connecting CAN proactively loads every named-action motion profile on any active page", () => {
  const refresh = functionSource(controller, "refreshMotionProfiles");
  assert.match(refresh, /if\s*\(!state\.connected\)\s*return/);
  assert.match(refresh, /new Set\(\)/);
  assert.match(refresh, /library\.snapshot\(\)/);
  assert.match(refresh, /definition\.motions/);
  assert.match(refresh, /nodeIds\.add\(motion\.nodeId\)/);
  assert.match(refresh, /ensureMotionProfile\(nodeId\)/);
  assert.doesNotMatch(refresh, /state\.activePage/,
    "profile loading must not depend on whether 动作编辑 or 动作时间轴 is visible");

  assert.match(controller, /root\.LumNamedActions\s*=\s*Object\.freeze\(\{[\s\S]*\brefreshMotionProfiles,/);
  const connect = functionSource(app, "connectCan");
  const connected = connect.indexOf("state.connected = true");
  const refreshCall = connect.indexOf("window.LumNamedActions.refreshMotionProfiles()", connected);
  assert.ok(connected >= 0 && refreshCall > connected,
    "a successful CAN connection must request named-action profiles immediately");
  assert.doesNotMatch(connect.slice(connected, refreshCall), /state\.activePage/);
});
