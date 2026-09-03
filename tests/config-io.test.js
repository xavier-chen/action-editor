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
const packageDocument = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function sourceNear(source, needle, radius = 2_000) {
  const index = source.indexOf(needle);
  assert.ok(index >= 0, `${needle} must exist`);
  return source.slice(Math.max(0, index - radius), index + needle.length + radius);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function declaredFunction(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`));
  assert.ok(start >= 0, `function ${name} must exist`);
  const remainder = source.slice(start + 1);
  const nextOffset = remainder.search(/\n(?:async\s+)?function\s+\w+\s*\(/);
  return source.slice(start, nextOffset < 0 ? source.length : start + 1 + nextOffset);
}

function functionNamedLike(source, namePattern, label) {
  const declarations = [...source.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)];
  const match = declarations.find(([, name]) => namePattern.test(name));
  assert.ok(match, `${label} function must exist`);
  return declaredFunction(source, match[1]);
}

function configChannel(direction) {
  const channels = [...main.matchAll(/const\s+([A-Z0-9_]*CONFIG[A-Z0-9_]*)\s*=\s*["']([^"']+)["']/g)];
  const match = channels.find(([, name, value]) => (
    name.toLowerCase().includes(direction)
    || value.toLowerCase().includes(direction)
  ));
  assert.ok(match, `main must declare an independent ${direction} config IPC channel`);
  return { name: match[1], value: match[2] };
}

test("top bar has config file actions but no old logo or LumFace brand block", () => {
  const topbar = html.match(/<header\b[^>]*class=["'][^"']*topbar[^"']*["'][^>]*>[\s\S]*?<\/header>/);
  assert.ok(topbar, "topbar must exist");
  assert.match(topbar[0], /id=["']exportConfigButton["']/);
  assert.match(topbar[0], /id=["']importConfigButton["']/);
  assert.match(topbar[0], />\s*导出配置\s*</);
  assert.match(topbar[0], />\s*导入配置\s*</);
  assert.doesNotMatch(topbar[0], /\bbrand(?:-icon)?\b|<h1\b|LumFace/i);
});

test("Action Editor visible product name keeps the legacy Electron profile so saved state is not lost", () => {
  assert.match(main, /const\s+PRODUCT_NAME\s*=\s*["']Action Editor["']/);
  assert.equal(packageDocument.productName, "Action Editor");
  assert.match(main, /const\s+LEGACY_USER_DATA_NAME\s*=\s*["']lumdriver-motor-terminal["']/);
  const preserveProfile = main.indexOf('app.setPath("userData"');
  const renameProduct = main.indexOf("app.setName(PRODUCT_NAME)");
  assert.ok(preserveProfile >= 0 && renameProduct > preserveProfile);
  assert.match(
    main.slice(preserveProfile, renameProduct),
    /path\.join\(app\.getPath\(["']appData["']\),\s*LEGACY_USER_DATA_NAME\)/,
  );
});

test("the inline ID area tells operators that valid IDs are saved automatically", () => {
  assert.match(html, /ID[^<]{0,30}自动保存|自动保存[^<]{0,30}ID/);
});

test("preload exposes explicit config-file methods without exposing raw IPC or filesystem", () => {
  const exposureStart = preload.indexOf("contextBridge.exposeInMainWorld");
  assert.ok(exposureStart >= 0);
  const exposedApi = preload.slice(exposureStart);
  assert.match(preload, /\b(?:exportConfigFile|exportConfig)\s*:/);
  assert.match(preload, /\b(?:importConfigFile|importConfig)\s*:/);
  assert.match(preload, /ipcRenderer\.invoke\(\s*[A-Z0-9_]*CONFIG[A-Z0-9_]*/);
  assert.doesNotMatch(preload, /require\(["'](?:node:)?fs(?:\/promises)?["']\)/);
  assert.doesNotMatch(exposedApi, /\b(?:ipcRenderer|fs)\s*[,}]/, "raw IPC/fs objects must not be exposed");
  assert.doesNotMatch(exposedApi, /(?:send|invoke)\s*:\s*(?:\([^)]*\)\s*=>\s*)?ipcRenderer/);
});

test("main uses two trusted-renderer IPC handlers and native dialogs for config files", () => {
  const exported = configChannel("export");
  const imported = configChannel("import");
  assert.notEqual(exported.name, imported.name);
  assert.notEqual(exported.value, imported.value);
  assert.notEqual(exported.value, "motor-terminal:request");
  assert.notEqual(imported.value, "motor-terminal:request");

  for (const channel of [exported, imported]) {
    const handler = sourceNear(main, `ipcMain.handle(${channel.name}`, 1_500);
    assert.match(handler, /assertTrustedRenderer\(event\)/);
  }
  assert.match(main, /\bdialog\.showSaveDialog\s*\(/);
  assert.match(main, /\bdialog\.showOpenDialog\s*\(/);
  assert.ok((main.match(/extensions\s*:\s*\[\s*["']json["']\s*\]/gi) || []).length >= 2);
});

test("main accepts only JSON config paths and bounds file contents before transfer", () => {
  assert.match(main, /(?:path\.extname\s*\(|\.endsWith\(\s*["']\.json["']\s*\))/);
  const limit = main.match(/const\s+MAX_CONFIG_FILE_BYTES\s*=\s*([^;]+);/);
  assert.ok(limit, "main must declare MAX_CONFIG_FILE_BYTES");
  assert.match(limit[1], /^[\d_+*/()\s-]+$/, "config byte limit must be a constant arithmetic expression");
  // This is restricted above to digits and arithmetic operators only.
  const bytes = Function(`"use strict"; return (${limit[1].replaceAll("_", "")});`)();
  assert.ok(Number.isSafeInteger(bytes) && bytes >= 1_024 && bytes <= 5 * 1_024 * 1_024);
  assert.match(main, /(?:Buffer\.byteLength\s*\(|\.size\s*>\s*MAX_CONFIG_FILE_BYTES)/);
  const textCheck = sourceNear(main, "function configurationText", 1_200);
  assert.match(textCheck, /MAX_CONFIG_FILE_BYTES/);
  assert.match(textCheck, /(?:过大|大小|字节|KiB|bytes?)/i);
  assert.match(main, /(?:readFile|writeFile)\s*\(/);
});

test("renderer export snapshot includes dynamic group and motor catalogs without timeline enable", () => {
  const snapshot = declaredFunction(app, "exportConfigurationDocument");
  assert.match(snapshot, /state\.groups\.map\s*\(/);
  assert.match(snapshot, /state\.motors\.map\s*\(/);
  for (const field of ["interfaceName", "groupId", "label", "motorId", "group", "nodeId", "steps", "speed", "acceleration", "closed"]) {
    assert.match(snapshot, new RegExp(`\\b${field}\\b`), `exported configuration must include ${field}`);
  }
  assert.match(snapshot, /groupCount:\s*groups\.length/);
  assert.match(snapshot, /motorCount:\s*motors\.length/);
  assert.match(snapshot, /schemaVersion:\s*CONFIG_SCHEMA_VERSION/);
  assert.doesNotMatch(snapshot, /\benabled\b|trackEnabled|timelineTrackEnabled/);
  assert.match(app, /JSON\.stringify\s*\(/);
  assert.match(app, /(?:api|motorTerminal)\.(?:exportConfigFile|exportConfig)\s*\(/);
  assert.match(app, /exportConfigButton["']\)\.addEventListener\(\s*["']click["']/);
});

test("motor config import never changes timeline track enable", () => {
  const validator = functionNamedLike(app, /^(?:normalize|validate|parse).*config/i, "import config validator");
  assert.doesNotMatch(validator, /defaultTimelineTrackEnabled|state\.timelineTrackEnabled|trackEnabled/);
  assert.doesNotMatch(validator, /return\s*\{[^}]*motorEnabled[^}]*\}/);

  const importer = functionNamedLike(app, /^import.*config/i, "config import action");
  assert.doesNotMatch(importer, /state\.timelineTrackEnabled\s*=/);
  assert.match(importer, /persistState\(\s*(?:true|\{\s*immediate\s*:\s*true)/);
});

test("schema-5 import validates bounded group and motor catalogs while preserving repeated CAN IDs", () => {
  const validator = functionNamedLike(app, /^(?:normalize|validate|parse).*config/i, "import config validator");
  assert.match(validator, /schemaVersion\s*===\s*CONFIG_SCHEMA_VERSION/);
  assert.match(validator, /configurationInteger\(documentRecord\.groupCount[\s\S]{0,100}0,\s*registry\.MAX_GROUPS\)/);
  assert.match(validator, /configurationInteger\(documentRecord\.motorCount[\s\S]{0,100}0,\s*registry\.MAX_MOTORS\)/);
  assert.match(validator, /registry\.normalizeGroupCatalog\s*\(/);
  assert.match(validator, /registry\.normalizeMotorCatalog\(catalogInput,\s*groups\)/);
  assert.match(validator, /schemaVersion\s*===\s*CONFIG_SCHEMA_VERSION[\s\S]*["']closed["']/);
  assert.match(validator, /configurationBoolean\(entry\.closed,[^)]*闭环模式[^)]*\)/);
  assert.match(validator, /importedMotorIds\s*=\s*motors\.map\(\(\{ id \}\)\s*=>\s*id\)/);
  assert.match(validator, /importedMotorIds\.includes\(entry\.motorId\)/);
  assert.match(validator, /return\s*\{[^}]*interfaceName[^}]*groups[^}]*motors[^}]*bindings[^}]*drafts/);
  assert.doesNotMatch(validator, /(?:usedNodeIds|seenNodeIds|nodeIdsSeen|uniqueNodeIds)/);
  assert.doesNotMatch(validator, /节点 ID[^\n]*(?:重复|唯一|duplicate)|(?:重复使用|duplicate)[^\n]*节点 ID/i);
  assert.match(validator, /(?:format|格式)[\s\S]{0,300}CONFIG_FORMAT/);
  assert.match(validator, /schemaVersion[\s\S]{0,200}CONFIG_SCHEMA_VERSION/);
  assert.match(validator, /(?:OnlyKeys|未知字段)/);
});

test("configuration schemas keep closed mode strict only in schema 5", () => {
  assert.match(app, /const CONFIG_SCHEMA_VERSION = 5/);
  assert.match(app, /const GROUP_CONFIG_SCHEMA_VERSION = 4/);
  const validator = functionNamedLike(app, /^(?:normalize|validate|parse).*config/i, "import config validator");
  assert.match(
    validator,
    /const closed = schemaVersion === CONFIG_SCHEMA_VERSION[\s\S]{0,180}configurationBoolean\(entry\.closed[\s\S]{0,180}: false/,
  );
  const booleanValidator = declaredFunction(app, "configurationBoolean");
  assert.match(booleanValidator, /typeof value !== ["']boolean["']/);
  assert.match(booleanValidator, /throw new TypeError/);
});

test("import validation enforces interface, ID, step, speed, and acceleration ranges", () => {
  const validator = functionNamedLike(app, /^(?:normalize|validate|parse).*config/i, "import config validator");
  assert.match(app, /\^\[A-Za-z0-9\]\[A-Za-z0-9_.-\]\{0,14\}\$/);
  assert.match(validator, /(?:nodeId|节点 ID)[\s\S]{0,800}(?:1\s*,\s*127|<\s*1|>\s*127)/);
  assert.match(validator, /(?:steps|步数)[\s\S]{0,800}(?:MAX_STEP_COUNT|0xFFFFFF|16777215)/);
  assert.match(validator, /(?:speed|速度)[\s\S]{0,800}(?:1\s*,\s*100|<\s*1|>\s*100)/);
  assert.match(validator, /(?:acceleration|加速度)[\s\S]{0,800}(?:1\s*,\s*100|<\s*1|>\s*100)/);
});

test("configuration import is disabled and guarded until CAN is fully disconnected", () => {
  assert.match(app, /importConfigButton["']\)\.addEventListener\(\s*["']click["']/);
  assert.match(app, /importConfigButton["']\)\.disabled\s*=\s*[^;\n]*state\.connected/);
  const importSource = functionNamedLike(app, /^import.*config/i, "config import action");
  assert.ok((importSource.match(/state\.connected/g) || []).length >= 2, "CAN state must be checked before and after the file dialog");
  assert.match(importSource, /(?:api|motorTerminal)\.(?:importConfigFile|importConfig)\s*\(/);
  assert.match(importSource, /(?:normalize|validate|parse)\w*(?:Imported)?Config\w*\s*\(/i);
  assert.match(importSource, /persistState\(\s*(?:true|\{\s*immediate\s*:\s*true)/);
  assert.match(importSource, /(?:refreshMotorRows|buildMotorRows|renderConnection)\s*\(/);
  for (const runtimeState of ["nodeStatus", "programStats", "ledger", "pendingOriginNodes"]) {
    assert.match(importSource, new RegExp(`state\\.${runtimeState}\\.clear\\(\\)`));
  }
  assert.match(importSource, /state\.originReliable\s*=\s*false/);
});

test("configuration import confirms destructive catalog cleanup before mutating live state", () => {
  const importer = declaredFunction(app, "importConfiguration");
  const normalized = importer.indexOf("normalizeImportedConfiguration");
  const impact = importer.indexOf("motorCatalogRemovalImpact(normalized.motors)", normalized);
  const confirmation = importer.indexOf("await confirmAction(", impact);
  const cancelGate = importer.indexOf("if (!confirmed) return", confirmation);
  const install = importer.indexOf("installMotorCatalog(normalized)", cancelGate);
  const interfaceMutation = importer.indexOf("state.interfaceName = normalized.interfaceName", cancelGate);
  assert.ok(normalized >= 0 && impact > normalized && confirmation > impact);
  assert.ok(cancelGate > confirmation && interfaceMutation > cancelGate && install > cancelGate);
  assert.match(importer.slice(impact, confirmation), /removedCommands\s*\|\|\s*impact\.removedActions/);
  assert.match(importer.slice(confirmation, cancelGate), /应用并清理/);
  assert.match(importer.slice(cancelGate, install), /确认期间 CAN 状态已改变/);
});

test("committing a valid inline ID persists immediately and reload validates saved IDs", () => {
  const commit = sourceNear(app, "function commitInlineNodeId", 1_800);
  const assignment = commit.indexOf("state.bindings[motorId]");
  const persistenceOffset = commit.slice(Math.max(0, assignment)).search(/persistState(?:Immediately|Now)?\s*\(/);
  const persistence = persistenceOffset < 0 ? -1 : assignment + persistenceOffset;
  assert.ok(assignment >= 0, "ID commit must update the binding");
  assert.ok(persistence > assignment, "ID commit must persist immediately after updating the binding");

  const persistenceImplementation = declaredFunction(app, "persistState");
  const globallySynchronous = !/setTimeout\s*\(/.test(persistenceImplementation);
  const explicitImmediateCommit = /(?:persistState(?:Immediately|Now)\s*\(\s*\)|persistState\s*\(\s*(?:true|\{\s*immediate\s*:\s*true)|localStorage\.setItem\s*\()/
    .test(commit.slice(assignment));
  assert.ok(
    globallySynchronous || explicitImmediateCommit,
    "ID commit must not wait behind the ordinary debounced localStorage save",
  );
  assert.match(app, /motorRows["']\)\.addEventListener\(\s*["']change["']\s*,\s*handleMotorBoardChange\s*\)/);

  const loader = sourceNear(app, "function loadStoredState", 4_000);
  assert.match(loader, /nodeId\s*>=\s*1\s*&&\s*nodeId\s*<=\s*127/);
  assert.doesNotMatch(loader, /usedNodeIds/);
});
