"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { BridgeClient } = require("../src/bridge-client");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("project metadata installs its own exact Electron runtime", () => {
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(manifest.name, "action-editor");
  assert.equal(manifest.productName, "Action Editor");
  assert.equal(manifest.private, true);
  assert.equal(manifest.author, "鹏睿机器人（深圳）有限公司");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.engines.node, ">=24.20.0");
  assert.equal(manifest.packageManager, "npm@11.19.0");
  assert.equal(manifest.devDependencies.electron, "41.10.7");
  assert.equal(lock.packages[""].devDependencies.electron, "41.10.7");
  assert.equal(lock.name, "action-editor");
  assert.equal(lock.packages[""].name, "action-editor");
  assert.equal(lock.packages[""].license, "Apache-2.0");
  assert.equal(lock.packages[""].engines.node, ">=24.20.0");
  assert.match(manifest.scripts.start, /^electron\s+\.$/);
  assert.match(manifest.scripts.verify, /test:bridge/);
  assert.doesNotMatch(JSON.stringify(manifest.scripts), /\/home\/|gui_v2_electron/);
  fs.accessSync(path.join(root, "scripts", "run.sh"), fs.constants.X_OK);
  fs.accessSync(path.join(root, "scripts", "install-desktop.sh"), fs.constants.X_OK);
});

test("runtime, launcher, and documentation contain no parent-project dependency", () => {
  for (const relativePath of ["main.js", "scripts/run.sh", "README.md", "README_EN.md"]) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /gui_v2_electron/);
    assert.doesNotMatch(source, /\/home\/orangepi/);
  }
  assert.match(read("main.js"), /require\(["']\.\/src\/bridge-client["']\)/);
  assert.ok(fs.statSync(path.join(root, "bridge", "lumdriver_bridge.py")).isFile());
});

test("Action Editor branding changes user-facing names while preserving compatibility identifiers", () => {
  const main = read("main.js");
  const html = read("renderer/index.html");
  const namedActions = read("renderer/named-actions.js");
  const launcher = read("scripts/run.sh");
  const desktopInstaller = read("scripts/install-desktop.sh");
  const bridgeClient = read("src/bridge-client.js");
  const ignores = read(".gitignore");

  assert.doesNotMatch([main, html, namedActions].join("\n"), /LumMotor/);
  for (const prefix of ["电机配置", "动画时间轴", "动作时间轴"]) {
    assert.ok(main.includes(`Action Editor-${prefix}-`));
  }
  assert.match(main, /LEGACY_USER_DATA_NAME\s*=\s*["']lumdriver-motor-terminal["']/);
  assert.match(namedActions, /ACTION_TIMELINE_FILE_FORMAT\s*=\s*["']lummotor-action-timeline-project["']/);
  assert.match(launcher, /ACTION_EDITOR_NODE/);
  assert.match(launcher, /LUMMOTOR_NODE/);
  assert.ok(launcher.indexOf("ACTION_EDITOR_NODE") < launcher.indexOf("LUMMOTOR_NODE"));
  assert.match(desktopInstaller, /ACTION_EDITOR_DESKTOP_DIR/);
  assert.match(desktopInstaller, /LUMMOTOR_DESKTOP_DIR/);
  assert.match(bridgeClient, /ACTION_EDITOR_PYTHON/);
  assert.match(bridgeClient, /LUMDRIVER_PYTHON/);
  assert.match(ignores, /Action Editor-电机配置-\*\.json/);
  assert.match(ignores, /LumMotor-电机配置-\*\.json/);
});

test("Apache-2.0 licensing, company copyright, and bilingual READMEs stay release-ready", () => {
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const license = read("LICENSE");
  const notice = read("NOTICE");
  const chinese = read("README.md");
  const english = read("README_EN.md");

  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(lock.packages[""].license, "Apache-2.0");
  assert.equal(
    crypto.createHash("sha256").update(license).digest("hex"),
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  );
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.equal(notice, "Action Editor\nCopyright 2026 鹏睿机器人（深圳）有限公司\n");
  assert.match(chinese, /\[English\]\(README_EN\.md\)/);
  assert.match(english, /\[中文\]\(README\.md\)/);
  assert.equal((chinese.match(/^## /gm) || []).length, 14);
  assert.equal((english.match(/^## /gm) || []).length, 14);

  for (const document of [chinese, english]) {
    for (const target of ["LICENSE", "NOTICE", "SAFETY.md", "CONTRIBUTING.md", "SECURITY.md"]) {
      assert.ok(document.includes(`(${target})`), target);
    }
    for (const protocolValue of ["1..127", "1..16777215", "0x200", "0x280", "250 ms"]) {
      assert.ok(document.includes(protocolValue), protocolValue);
    }
    for (const match of document.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^(?:https?:|#)/.test(target)) continue;
      const relativePath = target.split("#", 1)[0];
      assert.ok(fs.existsSync(path.join(root, relativePath)), target);
    }
  }
});

test("desktop installer quotes standalone project paths containing spaces and percent signs", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "action-editor-desktop-test-"));
  const linkedRoot = path.join(temporary, "Action Editor \\ quote\" dollar$ tick` % copy");
  const desktop = path.join(temporary, "Desktop folder");
  fs.symlinkSync(root, linkedRoot, "dir");

  try {
    const installed = spawnSync("bash", [path.join(linkedRoot, "scripts", "install-desktop.sh")], {
      encoding: "utf8",
      env: { ...process.env, ACTION_EDITOR_DESKTOP_DIR: desktop },
    });
    assert.equal(installed.status, 0, installed.stderr);
    const shortcutPath = path.join(desktop, "Action Editor.desktop");
    const shortcut = fs.readFileSync(shortcutPath, "utf8");
    const escapedRunner = path.join(linkedRoot, "scripts", "run.sh")
      .replaceAll("\\", "\\\\\\\\")
      .replaceAll("\"", "\\\"")
      .replaceAll("$", "\\$")
      .replaceAll("`", "\\`")
      .replaceAll("%", "%%");
    assert.ok(shortcut.split("\n").includes(`Exec="${escapedRunner}"`));
    assert.match(shortcut, /^Name=Action Editor$/m);
    assert.match(shortcut, /^StartupWMClass=action-editor$/m);
    assert.doesNotMatch(shortcut, /^Path=/m);

    const validated = spawnSync("desktop-file-validate", [shortcutPath], { encoding: "utf8" });
    if (!validated.error || validated.error.code !== "ENOENT") {
      assert.equal(validated.status, 0, validated.stderr);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("BridgeClient resolves the bundled Python bridge inside this project", () => {
  const bridge = new BridgeClient();
  assert.equal(
    path.resolve(bridge.script),
    path.join(root, "bridge", "lumdriver_bridge.py"),
  );
});

test("bundled JavaScript and Python bridge complete a simulated Protocol 6 motion", { timeout: 10_000 }, async (context) => {
  const bridge = new BridgeClient({
    python: process.env.LUMDRIVER_PYTHON || "python3",
  });
  context.after(async () => bridge.close());

  const connected = await bridge.request("connect", {
    interface: "can0",
    nodeId: 7,
    simulate: true,
  });
  assert.equal(connected.connected, true);
  assert.equal(connected.simulate, true);
  assert.equal(connected.nodeId, 7);

  const motion = await bridge.requestWithAck("move", {
    nodeId: 7,
    closed: false,
    direction: 0,
    count: 100,
    speedLevel: 10,
    accelerationLevel: 20,
  }, 1_500);
  assert.equal(motion.nodeId, 7);
  assert.equal(motion.ack.ok, true);
  assert.equal(motion.ack.commandClass, 1);

  const disconnected = await bridge.request("disconnect");
  assert.equal(disconnected.connected, false);
});
