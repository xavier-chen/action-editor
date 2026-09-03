"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

test("Electron renderer stays isolated and every permission is denied", () => {
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /nodeIntegrationInWorker:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /webviewTag:\s*false/);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(
    main,
    /setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/,
  );
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /will-navigate/);
  assert.match(main, /assertTrustedRenderer/);
  assert.doesNotMatch(main, /mediaType|mediaTypes|getUserMedia|loadFaceVisionAssets|VISION_ASSETS_CHANNEL/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("motorTerminal"/);
  assert.doesNotMatch(preload, /exposeInMainWorld\s*\([^)]*ipcRenderer/);
});

test("renderer CSP is local-only and disables network, media, and workers", () => {
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const contentPolicy = main.slice(
    main.indexOf("const CONTENT_SECURITY_POLICY"),
    main.indexOf("const bridge = new BridgeClient"),
  );
  for (const directive of [
    /default-src 'self'/,
    /script-src 'self'/,
    /connect-src 'none'/,
    /media-src 'none'/,
    /worker-src 'none'/,
    /object-src 'none'/,
    /frame-src 'none'/,
  ]) {
    assert.match(contentPolicy, directive);
    assert.match(html, directive);
  }
  assert.doesNotMatch(contentPolicy, /wasm-unsafe-eval|blob:|https?:/);
  assert.doesNotMatch(html, /wasm-unsafe-eval|blob:|https?:\/\//);
  assert.doesNotMatch(main, /dgram|tracking:|config:import|execFile|servo_move/);
});

test("main process exposes only motor operations and read-only duration profiles", () => {
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  assert.match(
    main,
    /const ACTIONS = new Set\(\[\s*"connect",\s*"disconnect",\s*"move",\s*"stop",\s*"disable",\s*"status_many",\s*"motion_profile",\s*\]\)/,
  );
  assert.match(main, /CAN_INTERFACE_PATTERN/);
  assert.match(main, /count:\s*integer\(params\.count, "步数", 1, 0xFFFFFF\)/);
  assert.match(main, /paramsFor\(payload, \[[\s\S]{0,180}["']closed["'][\s\S]{0,180}\]\)/);
  assert.match(main, /closed:\s*boolean\(params\.closed, ["']闭环标志["']\)/);
  assert.match(main, /speedLevel:\s*integer\(params\.speedLevel, "速度等级", 1, 100\)/);
  assert.match(main, /accelerationLevel:\s*integer\(params\.accelerationLevel, "加速度等级", 1, 100\)/);
  assert.match(main, /request\.action === "status_many"[\s\S]*?bridge\.request\(request\.action/);
  assert.match(main, /bridge\.requestWithAck\(request\.action/);
  assert.match(main, /request\.action === "motion_profile"[\s\S]*?readMotionProfile/);
  assert.match(main, /"param_get"/);
  assert.doesNotMatch(main, /"param_set"/);
});

test("preload API is explicit and does not expose camera or raw IPC access", () => {
  const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
  for (const method of [
    "connect",
    "disconnect",
    "move",
    "stop",
    "disable",
    "statusMany",
    "motionProfile",
    "exportConfigFile",
    "importConfigFile",
    "exportTimelineFile",
    "importTimelineFile",
    "onDriverEvent",
  ]) {
    assert.match(preload, new RegExp("\\b" + method + "\\b"));
  }
  assert.doesNotMatch(preload, /vision|camera|getUserMedia|mediaDevices/i);
  assert.doesNotMatch(preload, /send:\s*ipcRenderer|invoke:\s*ipcRenderer/);
});

test("duration profile lookup is read-only and limited to five motion parameters", () => {
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const profile = main.slice(
    main.indexOf("const MOTION_PROFILE_PARAMETERS"),
    main.indexOf("const CAN_INTERFACE_PATTERN"),
  );
  for (const parameterId of ["0x10", "0x11", "0x30", "0x49", "0x4A"]) {
    assert.match(profile, new RegExp(parameterId));
  }
  assert.equal((profile.match(/0x[0-9A-F]+/g) || []).length, 5);
  const reader = main.slice(
    main.indexOf("async function readMotionProfile"),
    main.indexOf("ipcMain.handle(IPC_REQUEST"),
  );
  assert.match(reader, /"param_get"/);
  assert.doesNotMatch(reader, /param_set|param_save|param_defaults/);
  assert.match(reader, /commandClass\) !== 4/);
  assert.match(reader, /parameterId\) !== parameterId/);
});

test("safety shutdown broadcasts immediate STOP before DISABLE", () => {
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const shutdown = main.slice(main.indexOf("async function emergencyBridgeShutdown"));
  const stop = shutdown.search(/"stop",\s*\{ immediate: true, broadcast: true \}/);
  const disable = shutdown.search(/"disable",\s*\{ broadcast: true \}/);
  assert.ok(stop >= 0);
  assert.ok(disable > stop);
  assert.match(shutdown, /"disconnect"/);
  assert.match(shutdown, /bridge\.close\(\)/);
  assert.match(main, /render-process-gone/);
  assert.match(main, /app\.on\("before-quit"/);
});

test("all shipped JavaScript parses", () => {
  for (const file of [
    "main.js",
    "preload.js",
    "renderer/app.js",
    "renderer/named-actions.js",
    "src/action-library.js",
    "src/bridge-client.js",
    "src/motor-registry.js",
    "src/command-ledger.js",
    "src/timeline-model.js",
  ]) {
    const checked = spawnSync(process.execPath, ["--check", path.join(root, file)], {
      encoding: "utf8",
    });
    assert.equal(checked.status, 0, file + ": " + checked.stderr);
  }
});
