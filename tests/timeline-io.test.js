"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "renderer", "app.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");

function functionSource(name) {
  const start = app.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const remainder = app.slice(start + 1);
  const next = remainder.search(/\n(?:async\s+)?function\s+\w+\s*\(/);
  return app.slice(start, next < 0 ? app.length : start + 1 + next);
}

test("timeline page provides explicit local save, animation import, and animation export", () => {
  for (const [id, label] of [
    ["timelineSaveProjectButton", "保存时间轴"],
    ["timelineImportProjectButton", "导入动画"],
    ["timelineExportProjectButton", "导出动画"],
  ]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*>${label}<`));
    assert.match(app, new RegExp(`${id}[^\\n]*addEventListener`));
  }
  const save = functionSource("saveTimelineProject");
  assert.match(save, /persistState\(true\)/);
  assert.match(save, /state\.timeline\.size/);
});

test("schema-4 animation export includes dynamic motor references, track enable, and closed mode on every action", () => {
  const exported = functionSource("exportTimelineDocument");
  assert.match(app, /const TIMELINE_FILE_FORMAT = "face-robot-timeline-animation"/);
  assert.match(app, /const TIMELINE_FILE_SCHEMA_VERSION = 4/);
  assert.match(exported, /format:\s*TIMELINE_FILE_FORMAT/);
  assert.match(exported, /schemaVersion:\s*TIMELINE_FILE_SCHEMA_VERSION/);
  assert.match(exported, /motorCount:\s*state\.motors\.length/);
  assert.match(exported, /motors:\s*state\.motors\.map\(\(\{ id, label \}\)\s*=>\s*\(\{ motorId: id, label \}\)\)/);
  assert.doesNotMatch(exported, /\bgroups\b|\bgroupCount\b|\bgroupId\b/,
    "timeline schema deliberately uses the current configuration's groups");
  for (const field of ["durationMs", "snapMs", "pixelsPerSecond"]) {
    assert.match(exported, new RegExp(`\\b${field}\\b`));
  }
  assert.match(exported, /trackEnabled:\s*state\.timelineTrackEnabled/);
  assert.match(exported, /actions:\s*state\.timeline\.snapshot\(\)/);
  assert.match(app, /closed:\s*\$\("timelineLoopModeSelect"\)\.value\s*===\s*["']closed["']/);
  const action = functionSource("exportTimelineProject");
  assert.match(action, /JSON\.stringify\(exportTimelineDocument\(\), null, 2\)/);
  assert.match(action, /api\.exportTimelineFile\(content\)/);
});

test("animation import validates the complete file before atomically replacing the timeline", () => {
  const normalize = functionSource("normalizeImportedTimeline");
  assert.match(normalize, /JSON\.parse/);
  assert.match(normalize, /configurationOnlyKeys/);
  assert.match(normalize, /TIMELINE_FILE_FORMAT/);
  assert.match(normalize, /TIMELINE_FILE_SCHEMA_VERSION/);
  assert.match(normalize, /registry\.normalizeMotorCatalog/);
  assert.match(normalize, /missingMotorIds[\s\S]{0,300}当前电机配置缺少动画引用的位置/);
  assert.match(normalize, /timelineModel\.MAX_ACTIONS/);
  assert.match(normalize, /new timelineModel\.TimelineProgram\(normalizedActions\)/);
  assert.match(normalize, /latestActionMs > durationMs/);
  assert.match(normalize, /normalizeTimelineTrackEnabled\(timeline\.trackEnabled,\s*importedMotorIds\)/);

  const action = functionSource("importTimelineProject");
  const dialog = action.indexOf("await api.importTimelineFile()");
  const runtimeGuard = action.indexOf("if (state.busy || state.connecting || state.disconnecting)", dialog);
  const normalized = action.indexOf("normalizeImportedTimeline");
  const replaced = action.indexOf("state.timeline = imported.program");
  const enableReplaced = action.indexOf("state.timelineTrackEnabled = imported.trackEnabled");
  const persisted = action.indexOf("persistState(true)");
  assert.ok(dialog >= 0 && runtimeGuard > dialog && normalized > runtimeGuard, "runtime state must be rechecked after the native file dialog and before parsing/applying");
  assert.ok(replaced > normalized && enableReplaced > replaced && persisted > enableReplaced);
  assert.match(action.slice(runtimeGuard, normalized), /导入期间运行状态已变化/);
  assert.match(action, /state\.selectedTimelineActionId = null/);
  assert.match(action, /renderTimeline\(\)/);
});

test("timeline schemas migrate versions 1 through 3 to open loop and require a boolean in schema 4", () => {
  const normalize = functionSource("normalizeImportedTimeline");
  assert.match(normalize, /const legacyActionKeys\s*=\s*\[[\s\S]*["']acceleration["'][\s\S]*\]/);
  assert.match(
    normalize,
    /schemaVersion === TIMELINE_FILE_SCHEMA_VERSION[\s\S]{0,180}\[\.\.\.legacyActionKeys, ["']closed["']\][\s\S]{0,300}const closed = schemaVersion === TIMELINE_FILE_SCHEMA_VERSION[\s\S]{0,180}configurationBoolean\(action\.closed[\s\S]{0,180}: false/,
  );
  assert.match(normalize, /return \{ \.\.\.action, closed \}/);
});

test("timeline track enable defaults off, persists locally, and loads only explicit true values", () => {
  const defaults = functionSource("defaultTimelineTrackEnabled");
  assert.match(defaults, /catalog\.map\(\(\{ id \}\)\s*=>\s*\[id,\s*false\]\)/);
  assert.match(app, /timelineTrackEnabled:\s*defaultTimelineTrackEnabled\(\)/);

  const persistence = functionSource("persistedStateDocument");
  assert.match(persistence, /timeline:\s*\{[\s\S]*trackEnabled:\s*Object\.fromEntries\(ids\.map/);

  const loader = functionSource("loadStoredState");
  assert.match(
    loader,
    /state\.timelineTrackEnabled\[motorId\]\s*=\s*storedTimeline\?\.trackEnabled\?\.\[motorId\]\s*===\s*true/,
  );
});

test("animation import validates every referenced track while current extra tracks default off", () => {
  const normalize = functionSource("normalizeTimelineTrackEnabled");
  assert.match(normalize, /const\s+trackEnabled\s*=\s*defaultTimelineTrackEnabled\(state\.motors\)/);
  assert.match(normalize, /value\s*===\s*undefined[\s\S]{0,80}return\s+trackEnabled/);
  assert.match(normalize, /importedMotorIds\s*=\s*motorIds\(\)/);
  assert.match(normalize, /configurationOnlyKeys\(record,\s*importedMotorIds/);
  assert.match(normalize, /for\s*\(const motorId of importedMotorIds\)/);
  assert.match(normalize, /Object\.hasOwn\(record,\s*motorId\)/);
  assert.match(normalize, /typeof\s+record\[motorId\]\s*!==\s*["']boolean["']/);
  assert.match(normalize, /trackEnabled\[motorId\]\s*=\s*record\[motorId\]\s*===\s*true/);
});

test("timeline files use dedicated trusted-renderer IPC channels and native JSON dialogs", () => {
  for (const direction of ["EXPORT", "IMPORT"]) {
    const name = `TIMELINE_${direction}_CHANNEL`;
    assert.match(preload, new RegExp(`const ${name} = "motor-terminal:timeline-${direction.toLowerCase()}"`));
    const handlerStart = main.indexOf(`ipcMain.handle(${name}`);
    assert.ok(handlerStart >= 0);
    assert.match(main.slice(handlerStart, handlerStart + 350), /assertTrustedRenderer\(event\)/);
  }
  assert.match(preload, /exportTimelineFile:\s*\(content\)\s*=>\s*ipcRenderer\.invoke\(TIMELINE_EXPORT_CHANNEL, content\)/);
  assert.match(preload, /importTimelineFile:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(TIMELINE_IMPORT_CHANNEL\)/);
  assert.match(main, /title:\s*"导出动画时间轴"/);
  assert.match(main, /title:\s*"导入动画时间轴"/);
  assert.match(main, /Action Editor-动画时间轴-/);
});
