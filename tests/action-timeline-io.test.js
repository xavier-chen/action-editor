"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "renderer", "app.js"), "utf8");
const controller = fs.readFileSync(path.join(root, "renderer", "named-actions.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");

function functionSource(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `${name} must exist`);
  const remainder = source.slice(match.index + match[0].length);
  const next = remainder.search(/\n\s*(?:async\s+)?function\s+\w+\s*\(/);
  return source.slice(
    match.index,
    next < 0 ? source.length : match.index + match[0].length + next,
  );
}

function actionTimelinePageSource() {
  const start = html.indexOf('<main id="actionTimelinePage"');
  const end = html.indexOf('<div id="motorCreateModal"', start);
  assert.ok(start >= 0 && end > start, "actionTimelinePage must exist");
  return html.slice(start, end);
}

test("动作时间轴 exposes explicit local save, independent import, and independent export", () => {
  const page = actionTimelinePageSource();
  for (const [id, label] of [
    ["actionTimelineSaveProjectButton", "保存"],
    ["actionTimelineImportProjectButton", "导入"],
    ["actionTimelineExportProjectButton", "导出"],
  ]) {
    assert.match(page, new RegExp(`id="${id}"[^>]*>[^<]*${label}[^<]*<`));
    assert.match(controller, new RegExp(`${id}[^\\n]*addEventListener`));
  }

  const save = functionSource(controller, "saveActionTimelineProject");
  assert.match(save, /interactionLocked\(\)/);
  assert.match(save, /persistState\(true\)/);
});

test("action-timeline export is one self-contained versioned JSON document", () => {
  assert.match(controller, /const ACTION_TIMELINE_FILE_FORMAT\s*=\s*["'][^"']+["']/);
  assert.match(controller, /const ACTION_TIMELINE_FILE_SCHEMA_VERSION\s*=\s*1/);
  const exported = functionSource(controller, "exportActionTimelineDocument");
  const durationGuard = exported.indexOf("ensureDurationCoversSequence()");
  const latestSendGuard = exported.indexOf("latestSequenceSendMs()", durationGuard);
  const documentCreated = exported.indexOf("return {", latestSendGuard);
  assert.ok(durationGuard >= 0 && latestSendGuard > durationGuard && documentCreated > latestSendGuard,
    "export must restore a duration that its own importer accepts before taking the snapshot");
  assert.match(exported, /format:\s*ACTION_TIMELINE_FILE_FORMAT/);
  assert.match(exported, /schemaVersion:\s*ACTION_TIMELINE_FILE_SCHEMA_VERSION/);
  assert.match(exported, /exportedAt:\s*new Date\(\)\.toISOString\(\)/);
  assert.match(exported, /namedActions:\s*\{[\s\S]*definitions:\s*library\.snapshot\(\)/);
  assert.match(exported, /actionTimeline:\s*\{/);
  assert.match(exported, /tracks:\s*actionTracks\.snapshot\(\)/);
  assert.match(exported, /placements:\s*sequence\.snapshot\(\)/);
  for (const field of ["durationMs", "snapMs", "pixelsPerSecond"]) {
    assert.match(exported, new RegExp(`\\b${field}\\b`));
  }

  const action = functionSource(controller, "exportActionTimelineProject");
  assert.match(action, /JSON\.stringify\(exportActionTimelineDocument\(\), null, 2\)/);
  assert.match(action, /api\.exportActionTimelineFile\(content\)/);
});

test("action-timeline import completely validates references and limits before constructing replacements", () => {
  const normalize = functionSource(controller, "normalizeImportedActionTimeline");
  assert.match(normalize, /JSON\.parse/);
  assert.match(normalize, /configurationOnlyKeys/);
  assert.match(normalize, /ACTION_TIMELINE_FILE_FORMAT/);
  assert.match(normalize, /ACTION_TIMELINE_FILE_SCHEMA_VERSION/);
  assert.match(normalize, /actionModel\.MAX_ACTION_DEFINITIONS/);
  assert.match(normalize, /actionModel\.MAX_ACTION_TRACKS/);
  assert.match(normalize, /actionModel\.MAX_PLACEMENTS/);
  assert.match(normalize, /new actionModel\.ActionLibrary\(/);
  assert.match(normalize, /new actionModel\.ActionTrackCatalog\(/);
  assert.match(normalize, /new actionModel\.NamedActionTimeline\(/);
  assert.match(normalize, /actionDefinitionId/);
  assert.match(normalize, /trackId/);
  assert.match(normalize, /MAX_EXPANDED_MOTIONS/);
  assert.match(normalize, /actionModel\.MAX_START_MS/);
  assert.match(normalize, /hasMotor\(/,
    "imported motion definitions must reference a motor in the current catalog");
  for (const field of ["durationMs", "snapMs", "pixelsPerSecond"]) {
    assert.match(normalize, new RegExp(`\\b${field}\\b`));
  }
});

test("action-timeline import atomically swaps all models only after the native dialog returns", () => {
  const action = functionSource(controller, "importActionTimelineProject");
  const dialog = action.indexOf("await api.importActionTimelineFile()");
  const runtimeGuard = action.indexOf("state.busy", dialog);
  const normalized = action.indexOf("normalizeImportedActionTimeline", runtimeGuard);
  const libraryReplaced = action.indexOf("library = imported.library", normalized);
  const tracksReplaced = action.indexOf("actionTracks = imported.actionTracks", normalized);
  const sequenceReplaced = action.indexOf("sequence = imported.sequence", normalized);
  const durationCovered = action.indexOf("ensureDurationCoversSequence()", sequenceReplaced);
  const persisted = action.indexOf("persistState(true)", normalized);
  assert.ok(dialog >= 0 && runtimeGuard > dialog && normalized > runtimeGuard,
    "runtime state must be rechecked after the native file dialog");
  assert.ok(libraryReplaced > normalized && tracksReplaced > normalized && sequenceReplaced > normalized,
    "all imported models must be constructed before any live model is replaced");
  assert.ok(durationCovered > sequenceReplaced && persisted > durationCovered,
    "import must extend the committed duration before saving the replacement locally");
  assert.match(action.slice(runtimeGuard, normalized), /导入期间运行状态已变化/);
  assert.match(action, /selectedPlacementId\s*=\s*null/);
  assert.match(action, /persistState\(true\)/);
  assert.match(action, /renderActionTimeline\(\)/);
});

test("duration edits and profile refreshes preserve every placed motion's complete time range", () => {
  const latestEnd = functionSource(controller, "latestSequenceEndMs");
  assert.match(latestEnd, /placement\.startMs\s*\+\s*\(definition\s*\?\s*definitionDuration\(definition\)/,
    "the required duration must include the named action's relative motion times and estimated end");

  const resize = functionSource(controller, "updateActionTimelineDuration");
  assert.match(resize, /latestSequenceEndMs\(\)/);
  assert.match(resize, /Math\.ceil\(latestEndMs\s*\/\s*1_000\)\s*\*\s*1_000/);
  assert.match(resize, /next\s*<\s*requiredDurationMs/);
  assert.match(resize, /return;/,
    "a duration shorter than the latest internal motion must be rejected before assignment");

  const profiles = functionSource(controller, "motionProfilesChanged");
  const previous = profiles.indexOf("const previousDurationMs = durationMs");
  const expanded = profiles.indexOf("ensureDurationCoversSequence()", previous);
  const persisted = profiles.indexOf("persistState()", expanded);
  assert.ok(previous >= 0 && expanded > previous && persisted > expanded);
  assert.match(profiles, /durationMs\s*!==\s*previousDurationMs[\s\S]*persistState\(\)/,
    "a profile-driven theoretical-duration expansion must survive restart and export");
});

test("action-timeline file operations lock every mutating control until completion", () => {
  const controls = functionSource(controller, "renderActionTimelineControls");
  for (const id of [
    "actionTimelineSaveProjectButton",
    "actionTimelineImportProjectButton",
    "actionTimelineExportProjectButton",
  ]) {
    assert.match(controls, new RegExp(`${id}[\\s\\S]{0,100}disabled\\s*=\\s*locked`));
  }
  for (const name of ["exportActionTimelineProject", "importActionTimelineProject"]) {
    const action = functionSource(controller, name);
    assert.match(action, /interactionLocked\(\)/);
    assert.match(action, /state\.configIoBusy\s*=\s*true/);
    assert.match(action, /finally\s*\{[\s\S]*state\.configIoBusy\s*=\s*false/);
    assert.match(action, /renderConnection\(\)/);
  }
});

test("action-timeline files use dedicated trusted IPC and bounded JSON-only dialogs", () => {
  for (const direction of ["EXPORT", "IMPORT"]) {
    const constant = `ACTION_TIMELINE_${direction}_CHANNEL`;
    const channel = `motor-terminal:action-timeline-${direction.toLowerCase()}`;
    assert.match(preload, new RegExp(`const ${constant} = ["']${channel}["']`));
    const handlerStart = main.indexOf(`ipcMain.handle(${constant}`);
    assert.ok(handlerStart >= 0, `${constant} handler must exist`);
    const handler = main.slice(handlerStart, handlerStart + 420);
    assert.match(handler, /assertTrustedRenderer\(event\)/);
    assert.match(handler, /assertOperational\(\)/);
  }
  assert.match(
    preload,
    /exportActionTimelineFile:\s*\(content\)\s*=>\s*ipcRenderer\.invoke\(ACTION_TIMELINE_EXPORT_CHANNEL, content\)/,
  );
  assert.match(
    preload,
    /importActionTimelineFile:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(ACTION_TIMELINE_IMPORT_CHANNEL\)/,
  );

  const exportFile = functionSource(main, "exportActionTimelineFile");
  const importFile = functionSource(main, "importActionTimelineFile");
  for (const action of [exportFile, importFile]) {
    assert.match(action, /assertJsonFilePath/);
    assert.match(action, /JSON/);
  }
  assert.match(importFile, /fs\.stat/);
  assert.match(importFile, /info\.isFile\(\)/);
  assert.match(main, /const MAX_ACTION_TIMELINE_FILE_BYTES\s*=\s*16\s*\*\s*1024\s*\*\s*1024/);
  assert.match(functionSource(main, "actionTimelineText"), /MAX_ACTION_TIMELINE_FILE_BYTES/);
  assert.match(importFile, /MAX_ACTION_TIMELINE_FILE_BYTES/);
  assert.doesNotMatch(importFile, /MAX_CONFIG_FILE_BYTES/,
    "renderer text validation and main-process file validation must share the same action-project limit");
  assert.match(main, /title:\s*["']导出动作时间轴["']/);
  assert.match(main, /title:\s*["']导入动作时间轴["']/);
  assert.match(main, /Action Editor-动作时间轴-/);
});

test("main-process action-timeline export atomically replaces the selected JSON file", () => {
  const atomicWrite = functionSource(main, "writeTextFileAtomically");
  const opened = atomicWrite.indexOf('fs.open(temporaryPath, "wx", 0o600)');
  const written = atomicWrite.indexOf("handle.writeFile", opened);
  const synced = atomicWrite.indexOf("handle.sync()", written);
  const renamed = atomicWrite.indexOf("fs.rename(temporaryPath, filePath)", synced);
  assert.ok(opened >= 0 && written > opened && synced > written && renamed > synced,
    "the destination must only be replaced after a fully written and synced temporary file exists");
  assert.match(atomicWrite, /catch\s*\(error\)[\s\S]*fs\.unlink\(temporaryPath\)\.catch/);

  const exportFile = functionSource(main, "exportActionTimelineFile");
  assert.match(exportFile, /await writeTextFileAtomically\(filePath, text\)/);
  assert.doesNotMatch(exportFile, /fs\.writeFile\(filePath/,
    "a failed export must not truncate the user's previous action project");
});
