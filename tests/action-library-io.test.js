"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
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

function actionEditorPageSource() {
  const start = html.indexOf('<main id="namedActionEditorPage"');
  const end = html.indexOf('<main id="actionTimelinePage"', start);
  assert.ok(start >= 0 && end > start, "namedActionEditorPage must exist");
  return html.slice(start, end);
}

test("动作编辑 exposes independent action-library import and export", () => {
  const page = actionEditorPageSource();
  for (const [id, label] of [
    ["namedActionImportLibraryButton", "导入动作库"],
    ["namedActionExportLibraryButton", "导出动作库"],
  ]) {
    assert.match(page, new RegExp(`id="${id}"[^>]*>[^<]*${label}[^<]*<`));
    assert.match(controller, new RegExp(`${id}[^\\n]*addEventListener`));
  }
  assert.match(
    html,
    /actionTimelineImportProjectButton[^>]*>导入时间轴</,
  );
  assert.match(
    html,
    /actionTimelineExportProjectButton[^>]*>导出时间轴</,
  );
});

test("action-library export is a versioned document without timeline state", () => {
  assert.match(controller, /const ACTION_LIBRARY_FILE_FORMAT\s*=\s*["']lummotor-action-library["']/);
  assert.match(controller, /const ACTION_LIBRARY_FILE_SCHEMA_VERSION\s*=\s*1/);
  const exported = functionSource(controller, "exportActionLibraryDocument");
  assert.match(exported, /format:\s*ACTION_LIBRARY_FILE_FORMAT/);
  assert.match(exported, /schemaVersion:\s*ACTION_LIBRARY_FILE_SCHEMA_VERSION/);
  assert.match(exported, /exportedAt:\s*new Date\(\)\.toISOString\(\)/);
  assert.match(exported, /namedActions:\s*\{[\s\S]*\bdefinitions,/);
  assert.match(exported, /actionLibraryMotorSnapshot\(definitions\)/);
  assert.doesNotMatch(exported, /actionTimeline|tracks|placements|playbackSettings/);

  const action = functionSource(controller, "exportActionLibraryProject");
  assert.match(action, /draftIsDirty\(\)/);
  assert.match(action, /请先保存动作再导出动作库/);
  assert.match(action, /JSON\.stringify\(exportActionLibraryDocument\(\), null, 2\)/);
  assert.match(action, /api\.exportActionLibraryFile\(content\)/);
});

test("action-library import strictly validates the complete file before merging", () => {
  const normalize = functionSource(controller, "normalizeImportedActionLibrary");
  assert.match(normalize, /JSON\.parse/);
  assert.match(normalize, /configurationOnlyKeys/);
  assert.match(normalize, /ACTION_LIBRARY_FILE_FORMAT/);
  assert.match(normalize, /ACTION_LIBRARY_FILE_SCHEMA_VERSION/);
  assert.match(normalize, /actionModel\.MAX_ACTION_DEFINITIONS/);
  assert.match(normalize, /new actionModel\.ActionLibrary\(/);
  assert.match(normalize, /actionTimelineFileStableId\(definition\.actionDefinitionId/);
  assert.match(normalize, /actionTimelineFileStableId\(motion\.motionId/);
  assert.match(normalize, /typeof motion\.closed !== ["']boolean["']/);
  assert.match(normalize, /actionModel\.validateActionFileMotion\(motion\)/);
  assert.match(normalize, /importedMotorIds\.has\(motion\.motorId\)/);
  assert.match(normalize, /hasMotor\(motion\.motorId\)/);
  assert.match(normalize, /currentMotor\.label !== importedLabel/);
});

test("action-library import appends atomically without replacing the existing timeline", () => {
  const action = functionSource(controller, "importActionLibraryProject");
  const dialog = action.indexOf("await api.importActionLibraryFile()");
  const runtimeGuard = action.indexOf("state.busy", dialog);
  const normalized = action.indexOf("normalizeImportedActionLibrary", runtimeGuard);
  const merged = action.indexOf("library.appendAsNew", normalized);
  const persisted = action.indexOf("persistState(true)", merged);
  assert.ok(dialog >= 0 && runtimeGuard > dialog && normalized > runtimeGuard && merged > normalized);
  assert.ok(persisted > merged, "the fully validated append must be persisted after its atomic commit");
  assert.match(action, /state\.operationEpoch !== operationEpoch/);
  assert.match(action, /state\.connectionEpoch !== connectionEpoch/);
  assert.match(action, /library\.revision !== libraryRevision/);
  assert.match(action, /actionTracks\.revision !== tracksRevision/);
  assert.match(action, /sequence\.revision !== sequenceRevision/);
  assert.doesNotMatch(action, /library\s*=|sequence\s*=|actionTracks\s*=/,
    "a library import must preserve existing definitions, tracks, placements, and their stable IDs");
  assert.doesNotMatch(action, /sequence\.(?:clear|remove)\(/);
  assert.match(action, /未修改现有动作和时间轴/);
});

test("action-library file controls share the global file-operation lock", () => {
  const controls = functionSource(controller, "renderControls");
  assert.match(controls, /namedActionImportLibraryButton[\s\S]{0,100}disabled\s*=\s*locked/);
  assert.match(controls, /namedActionExportLibraryButton[\s\S]{0,100}disabled\s*=\s*locked\s*\|\|\s*!library\.size/);
  for (const name of ["exportActionLibraryProject", "importActionLibraryProject"]) {
    const action = functionSource(controller, name);
    assert.match(action, /interactionLocked\(\)/);
    assert.match(action, /state\.configIoBusy\s*=\s*true/);
    assert.match(action, /finally\s*\{[\s\S]*state\.configIoBusy\s*=\s*false/);
    assert.match(action, /renderConnection\(\)/);
  }
});

test("action-library files use dedicated trusted IPC and bounded JSON-only dialogs", () => {
  for (const direction of ["EXPORT", "IMPORT"]) {
    const constant = `ACTION_LIBRARY_${direction}_CHANNEL`;
    const channel = `motor-terminal:action-library-${direction.toLowerCase()}`;
    assert.match(preload, new RegExp(`const ${constant} = ["']${channel}["']`));
    const handlerStart = main.indexOf(`ipcMain.handle(${constant}`);
    assert.ok(handlerStart >= 0, `${constant} handler must exist`);
    const handler = main.slice(handlerStart, handlerStart + 420);
    assert.match(handler, /assertTrustedRenderer\(event\)/);
    assert.match(handler, /assertOperational\(\)/);
  }
  assert.match(
    preload,
    /exportActionLibraryFile:\s*\(content\)\s*=>\s*ipcRenderer\.invoke\(ACTION_LIBRARY_EXPORT_CHANNEL, content\)/,
  );
  assert.match(
    preload,
    /importActionLibraryFile:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(ACTION_LIBRARY_IMPORT_CHANNEL\)/,
  );

  const exportFile = functionSource(main, "exportActionLibraryFile");
  const importFile = functionSource(main, "importActionLibraryFile");
  for (const action of [exportFile, importFile]) assert.match(action, /assertJsonFilePath/);
  assert.match(exportFile, /writeTextFileAtomically\(filePath, text\)/);
  assert.match(importFile, /readBoundedTextFile/);
  assert.match(importFile, /MAX_ACTION_LIBRARY_FILE_BYTES/);
  assert.match(functionSource(main, "actionLibraryText"), /MAX_ACTION_LIBRARY_FILE_BYTES/);
  const boundedRead = functionSource(main, "readBoundedTextFile");
  assert.match(boundedRead, /fs\.open\(filePath, ["']r["']\)/);
  assert.match(boundedRead, /handle\.stat\(\)/);
  assert.match(boundedRead, /info\.isFile\(\)/);
  assert.match(boundedRead, /maximumBytes \+ 1 - totalBytes/);
  assert.match(boundedRead, /totalBytes > maximumBytes/);
  assert.match(boundedRead, /handle\.close\(\)/);
  assert.match(main, /const MAX_ACTION_LIBRARY_FILE_BYTES\s*=\s*16\s*\*\s*1024\s*\*\s*1024/);
  assert.match(main, /title:\s*["']导出动作库["']/);
  assert.match(main, /title:\s*["']导入动作库["']/);
  assert.match(main, /Action Editor-动作库-/);
});
