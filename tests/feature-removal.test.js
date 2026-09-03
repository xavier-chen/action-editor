"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const runtimeFiles = [
  "main.js",
  "preload.js",
  "renderer/app.js",
  "renderer/named-actions.js",
  "renderer/index.html",
  "renderer/styles.css",
  "package.json",
  "package-lock.json",
  "README.md",
  "README_EN.md",
];

test("camera recording UI, runtime hooks, and dependency are completely absent", () => {
  const runtime = runtimeFiles
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");
  for (const obsolete of [
    /recordingEditor/,
    /FaceRecording/,
    /FaceMotion/,
    /loadFaceVisionAssets/,
    /VISION_ASSETS_CHANNEL/,
    /getUserMedia/,
    /mediaDevices/,
    /@mediapipe/,
    /MediaPipe/,
    /录制动作轨道/,
    /摄像头/,
    /\.recording-/,
  ]) {
    assert.doesNotMatch(runtime, obsolete);
  }
  assert.doesNotMatch(runtime, /use-gl|use-angle|ignore-gpu-blocklist|enable-unsafe-swiftshader/);

  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  assert.equal((html.match(/\brole="tab"/g) || []).length, 4);
  assert.equal((html.match(/\brole="tabpanel"/g) || []).length, 4);
  assert.doesNotMatch(html, /<video\b/);
});

test("recording implementation files, workers, and model asset remain deleted", () => {
  for (const file of [
    "assets/face_landmarker.task",
    "renderer/recording-controller.js",
    "renderer/recording-analysis-worker.js",
    "renderer/face-landmarker-worker.js",
    "src/face-motion-model.js",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
  assert.equal(
    fs.existsSync(path.join(root, "node_modules", "@mediapipe")),
    false,
  );
});

test("saved state contains motor data plus the two explicit action layers, without recording data", () => {
  const app = fs.readFileSync(path.join(root, "renderer", "app.js"), "utf8");
  const pageDefinitions = app.slice(
    app.indexOf("const PAGE_DEFINITIONS"),
    app.indexOf("function defaultDrafts"),
  );
  assert.match(pageDefinitions, /id: "motor"/);
  assert.match(pageDefinitions, /id: "timeline"/);
  assert.match(pageDefinitions, /id: "namedAction"/);
  assert.match(pageDefinitions, /id: "actionTimeline"/);
  assert.equal((pageDefinitions.match(/\bid:/g) || []).length, 4);

  const persisted = app.slice(
    app.indexOf("function persistedStateDocument"),
    app.indexOf("function setSaveStatus"),
  );
  assert.match(persisted, /schemaVersion:\s*12/);
  assert.match(persisted, /groups:\s*state\.groups\.map/);
  assert.match(persisted, /nextCustomGroupNumber:\s*state\.nextCustomGroupNumber/);
  assert.match(persisted, /nextCustomMotorNumber:\s*state\.nextCustomMotorNumber/);
  assert.match(persisted, /motors:\s*state\.motors\.map/);
  assert.match(persisted, /bindings:\s*Object\.fromEntries\(ids\.map/);
  assert.match(persisted, /drafts:\s*Object\.fromEntries\(ids\.map/);
  assert.match(persisted, /timeline:/);
  assert.match(persisted, /\.\.\.window\.LumNamedActions\.persistedStateFields\(\)/);
  assert.doesNotMatch(persisted, /recording/i);
  assert.match(
    app.slice(app.indexOf("function initialize")),
    /renderTimeline\(\);\s*window\.LumNamedActions\.initialize\(\);\s*persistState\(true\);/,
  );
});
