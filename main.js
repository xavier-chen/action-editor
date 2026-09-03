"use strict";

const { app, BrowserWindow, dialog, ipcMain, session } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { BridgeClient } = require("./src/bridge-client");

const PRODUCT_NAME = "Action Editor";
const LEGACY_USER_DATA_NAME = "lumdriver-motor-terminal";

// Keep the existing Chromium profile path so renaming the product does not
// make saved motor IDs, custom motors, commands, and timelines appear lost.
app.setPath("userData", path.join(app.getPath("appData"), LEGACY_USER_DATA_NAME));
app.setName(PRODUCT_NAME);
app.enableSandbox();

const IPC_REQUEST = "motor-terminal:request";
const CONFIG_EXPORT_CHANNEL = "motor-terminal:config-export";
const CONFIG_IMPORT_CHANNEL = "motor-terminal:config-import";
const TIMELINE_EXPORT_CHANNEL = "motor-terminal:timeline-export";
const TIMELINE_IMPORT_CHANNEL = "motor-terminal:timeline-import";
const ACTION_TIMELINE_EXPORT_CHANNEL = "motor-terminal:action-timeline-export";
const ACTION_TIMELINE_IMPORT_CHANNEL = "motor-terminal:action-timeline-import";
const DRIVER_EVENT = "driver:event";
const RENDERER_FILE = path.join(__dirname, "renderer", "index.html");
const MAX_STATUS_NODES = 16;
const MAX_CONFIG_FILE_BYTES = 512 * 1024;
const MAX_ACTION_TIMELINE_FILE_BYTES = 16 * 1024 * 1024;
const MOTION_PROFILE_PARAMETERS = Object.freeze({
  fullSteps: 0x10,
  microsteps: 0x11,
  sCurveTimeMs: 0x30,
  speedLimitRpm: 0x49,
  accelerationLimitRpmS: 0x4A,
});
const CAN_INTERFACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/;
const ACTIONS = new Set([
  "connect",
  "disconnect",
  "move",
  "stop",
  "disable",
  "status_many",
  "motion_profile",
]);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const bridge = new BridgeClient();
let mainWindow = null;
let applicationClosing = false;
let shutdownComplete = false;
let shutdownPromise = null;
let configDialogBusy = false;

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label}必须是普通对象`);
  }
  return value;
}

function onlyKeys(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`${label}包含未知字段: ${key}`);
  }
}

function integer(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label}必须是 ${minimum}–${maximum} 的整数`);
  }
  return value;
}

function boolean(value, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

function nodeId(value, label = "节点 ID") {
  return integer(value, label, 1, 127);
}

function interfaceName(value) {
  if (
    typeof value !== "string"
    || !CAN_INTERFACE_PATTERN.test(value)
    || Buffer.byteLength(value, "utf8") > 15
  ) {
    throw new TypeError("CAN 接口名不合法");
  }
  return value;
}

function paramsFor(payload, allowedKeys) {
  const params = payload.params === undefined
    ? {}
    : plainRecord(payload.params, "操作参数");
  onlyKeys(params, new Set(allowedKeys), "操作参数");
  return params;
}

const SANITIZERS = Object.freeze({
  connect(payload) {
    const params = paramsFor(payload, ["interface", "nodeId", "simulate"]);
    return {
      interface: interfaceName(params.interface),
      nodeId: params.nodeId === undefined ? 1 : nodeId(params.nodeId, "默认节点 ID"),
      simulate: boolean(params.simulate, "仿真模式", false),
    };
  },

  disconnect(payload) {
    paramsFor(payload, []);
    return {};
  },

  move(payload) {
    const params = paramsFor(payload, [
      "nodeId",
      "closed",
      "direction",
      "count",
      "speedLevel",
      "accelerationLevel",
    ]);
    return {
      nodeId: nodeId(params.nodeId),
      closed: boolean(params.closed, "闭环标志"),
      direction: integer(params.direction, "方向", 0, 1),
      count: integer(params.count, "步数", 1, 0xFFFFFF),
      speedLevel: integer(params.speedLevel, "速度等级", 1, 100),
      accelerationLevel: integer(params.accelerationLevel, "加速度等级", 1, 100),
    };
  },

  stop(payload) {
    const params = paramsFor(payload, ["nodeId", "broadcast", "immediate"]);
    const broadcast = boolean(params.broadcast, "广播", false);
    if (broadcast && params.nodeId !== undefined) {
      throw new TypeError("广播停止不能同时指定节点 ID");
    }
    return {
      ...(broadcast ? {} : { nodeId: nodeId(params.nodeId) }),
      broadcast,
      immediate: boolean(params.immediate, "立即停止", false),
    };
  },

  disable(payload) {
    const params = paramsFor(payload, ["nodeId", "broadcast"]);
    const broadcast = boolean(params.broadcast, "广播", false);
    if (broadcast && params.nodeId !== undefined) {
      throw new TypeError("广播失能不能同时指定节点 ID");
    }
    return {
      ...(broadcast ? {} : { nodeId: nodeId(params.nodeId) }),
      broadcast,
    };
  },

  status_many(payload) {
    const params = paramsFor(payload, ["nodeIds", "flags"]);
    if (!Array.isArray(params.nodeIds)) {
      throw new TypeError("节点 ID 列表必须是数组");
    }
    const nodeIds = [...new Set(params.nodeIds.map((value) => nodeId(value)))];
    if (nodeIds.length < 1 || nodeIds.length > MAX_STATUS_NODES) {
      throw new RangeError(`状态查询必须包含 1–${MAX_STATUS_NODES} 个不同节点`);
    }
    return {
      nodeIds,
      flags: integer(params.flags ?? 15, "状态标志", 0, 15),
    };
  },

  motion_profile(payload) {
    const params = paramsFor(payload, ["nodeId"]);
    return { nodeId: nodeId(params.nodeId) };
  },
});

function sanitizeRequest(payload) {
  const request = plainRecord(payload, "IPC 请求");
  onlyKeys(request, new Set(["action", "params"]), "IPC 请求");
  if (typeof request.action !== "string" || !ACTIONS.has(request.action)) {
    throw new Error("不允许的 CAN 操作");
  }
  return {
    action: request.action,
    params: SANITIZERS[request.action](request),
  };
}

function isRendererUrl(urlText) {
  try {
    const url = new URL(urlText);
    return url.protocol === "file:"
      && path.resolve(fileURLToPath(url)) === path.resolve(RENDERER_FILE);
  } catch (_) {
    return false;
  }
}

function assertTrustedRenderer(event) {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || !event.senderFrame
    || event.senderFrame !== mainWindow.webContents.mainFrame
    || !isRendererUrl(event.senderFrame.url)
  ) {
    throw new Error("拒绝非主窗口 IPC 请求");
  }
}

function assertOperational() {
  if (applicationClosing) throw new Error("程序正在安全关闭");
}

function configurationText(value) {
  if (typeof value !== "string") throw new TypeError("导出配置必须是文本");
  const size = Buffer.byteLength(value, "utf8");
  if (size < 2 || size > MAX_CONFIG_FILE_BYTES) {
    throw new RangeError("配置文件必须小于 512 KiB");
  }
  let parsed;
  try {
    parsed = JSON.parse(value.replace(/^\uFEFF/, ""));
  } catch (_) {
    throw new TypeError("配置文件必须是有效 JSON");
  }
  plainRecord(parsed, "JSON 根对象");
  return value;
}

function timelineText(value) {
  if (typeof value !== "string") throw new TypeError("动画时间轴必须是文本");
  const size = Buffer.byteLength(value, "utf8");
  if (size < 2 || size > MAX_CONFIG_FILE_BYTES) {
    throw new RangeError("动画时间轴文件必须小于 512 KiB");
  }
  let parsed;
  try {
    parsed = JSON.parse(value.replace(/^\uFEFF/, ""));
  } catch (_) {
    throw new TypeError("动画时间轴文件必须是有效 JSON");
  }
  plainRecord(parsed, "动画时间轴 JSON 根对象");
  return value;
}

function actionTimelineText(value) {
  if (typeof value !== "string") throw new TypeError("动作时间轴必须是文本");
  const size = Buffer.byteLength(value, "utf8");
  if (size < 2 || size > MAX_ACTION_TIMELINE_FILE_BYTES) {
    throw new RangeError("动作时间轴文件必须小于 16 MiB");
  }
  let parsed;
  try {
    parsed = JSON.parse(value.replace(/^\uFEFF/, ""));
  } catch (_) {
    throw new TypeError("动作时间轴文件必须是有效 JSON");
  }
  plainRecord(parsed, "动作时间轴 JSON 根对象");
  return value;
}

function assertJsonFilePath(filePath) {
  if (typeof filePath !== "string" || path.extname(filePath).toLowerCase() !== ".json") {
    throw new TypeError("配置文件必须使用 .json 扩展名");
  }
  return filePath;
}

function datedConfigFileName() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return `Action Editor-电机配置-${date}.json`;
}

function datedTimelineFileName() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return `Action Editor-动画时间轴-${date}.json`;
}

function datedActionTimelineFileName() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return `Action Editor-动作时间轴-${date}.json`;
}

async function withConfigDialog(operation) {
  if (configDialogBusy) throw new Error("已有配置文件对话框打开");
  configDialogBusy = true;
  try {
    return await operation();
  } finally {
    configDialogBusy = false;
  }
}

async function exportConfigurationFile(content) {
  const text = configurationText(content);
  return withConfigDialog(async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出电机配置",
      defaultPath: path.join(app.getPath("documents"), datedConfigFileName()),
      filters: [{ name: "JSON 配置", extensions: ["json"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const filePath = assertJsonFilePath(result.filePath);
    await fs.writeFile(filePath, text, { encoding: "utf8" });
    return { canceled: false, fileName: path.basename(filePath) };
  });
}

async function importConfigurationFile() {
  return withConfigDialog(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入电机配置",
      filters: [{ name: "JSON 配置", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length !== 1) return { canceled: true };
    const filePath = assertJsonFilePath(result.filePaths[0]);
    const info = await fs.stat(filePath);
    if (!info.isFile() || info.size < 2 || info.size > MAX_CONFIG_FILE_BYTES) {
      throw new RangeError("配置文件必须是小于 512 KiB 的普通文件");
    }
    const content = await fs.readFile(filePath, "utf8");
    configurationText(content);
    return { canceled: false, fileName: path.basename(filePath), content };
  });
}

async function exportTimelineFile(content) {
  const text = timelineText(content);
  return withConfigDialog(async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出动画时间轴",
      defaultPath: path.join(app.getPath("documents"), datedTimelineFileName()),
      filters: [{ name: "动画时间轴 JSON", extensions: ["json"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const filePath = assertJsonFilePath(result.filePath);
    await fs.writeFile(filePath, text, { encoding: "utf8" });
    return { canceled: false, fileName: path.basename(filePath) };
  });
}

async function importTimelineFile() {
  return withConfigDialog(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入动画时间轴",
      filters: [{ name: "动画时间轴 JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length !== 1) return { canceled: true };
    const filePath = assertJsonFilePath(result.filePaths[0]);
    const info = await fs.stat(filePath);
    if (!info.isFile() || info.size < 2 || info.size > MAX_CONFIG_FILE_BYTES) {
      throw new RangeError("动画时间轴文件必须是小于 512 KiB 的普通文件");
    }
    const content = await fs.readFile(filePath, "utf8");
    timelineText(content);
    return { canceled: false, fileName: path.basename(filePath), content };
  });
}

async function writeTextFileAtomically(filePath, text) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.lummotor-action-timeline-${process.pid}-${Date.now()}.tmp`,
  );
  let handle = null;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(text, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function exportActionTimelineFile(content) {
  const text = actionTimelineText(content);
  return withConfigDialog(async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出动作时间轴",
      defaultPath: path.join(app.getPath("documents"), datedActionTimelineFileName()),
      filters: [{ name: "动作时间轴 JSON", extensions: ["json"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const filePath = assertJsonFilePath(result.filePath);
    await writeTextFileAtomically(filePath, text);
    return { canceled: false, fileName: path.basename(filePath) };
  });
}

async function importActionTimelineFile() {
  return withConfigDialog(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入动作时间轴",
      filters: [{ name: "动作时间轴 JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length !== 1) return { canceled: true };
    const filePath = assertJsonFilePath(result.filePaths[0]);
    const info = await fs.stat(filePath);
    if (!info.isFile() || info.size < 2 || info.size > MAX_ACTION_TIMELINE_FILE_BYTES) {
      throw new RangeError("动作时间轴文件必须是小于 16 MiB 的普通文件");
    }
    const content = await fs.readFile(filePath, "utf8");
    actionTimelineText(content);
    return { canceled: false, fileName: path.basename(filePath), content };
  });
}

function sendDriverEvent(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(DRIVER_EVENT, message);
  }
}

function configureSessionSecurity() {
  const activeSession = session.defaultSession;
  activeSession.setPermissionCheckHandler(() => false);
  activeSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  activeSession.on("will-download", (event) => event.preventDefault());
  activeSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== "mainFrame" || !isRendererUrl(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...(details.responseHeaders || {}),
        "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
      },
    });
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: "#0b1220",
    show: false,
    title: PRODUCT_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      spellcheck: false,
      devTools: false,
    },
  });
  mainWindow = window;

  window.removeMenu();
  void window.loadFile(RENDERER_FILE);
  window.once("ready-to-show", () => {
    if (!applicationClosing && !window.isDestroyed()) window.show();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, url) => {
    if (!isRendererUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", () => {
    if (!applicationClosing) void requestSafeQuit();
  });
  window.on("close", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void requestSafeQuit();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
}

async function emergencyBridgeShutdown() {
  try {
    await bridge.requestWithAck(
      "stop",
      { immediate: true, broadcast: true },
      1_000,
    );
  } catch (_) {
    // DISABLE and bridge closure are still required if STOP fails.
  }
  try {
    await bridge.requestWithAck("disable", { broadcast: true }, 1_000);
  } catch (_) {
    // Disconnect and bridge closure remain the final safety fallback.
  }
  try {
    await bridge.requestWithAck("disconnect", {}, 750);
  } catch (_) {
    // BridgeClient.close() terminates the transport if disconnect fails.
  }
  await bridge.close().catch(() => {});
}

function requestSafeQuit() {
  if (shutdownComplete) {
    app.quit();
    return Promise.resolve();
  }
  if (shutdownPromise) return shutdownPromise;
  applicationClosing = true;
  shutdownPromise = emergencyBridgeShutdown().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
  return shutdownPromise;
}

async function readMotionProfile(targetNodeId) {
  const entries = await Promise.all(Object.entries(MOTION_PROFILE_PARAMETERS).map(
    async ([name, parameterId]) => {
      const result = await bridge.requestWithAck(
        "param_get",
        { nodeId: targetNodeId, parameterId },
      );
      const ack = result?.ack;
      if (
        !ack
        || ack.ok !== true
        || Number(ack.nodeId) !== targetNodeId
        || Number(ack.commandClass) !== 4
        || Number(ack.opcode) !== 1
        || Number(ack.parameterId) !== parameterId
        || !Number.isSafeInteger(Number(ack.value))
      ) {
        throw new Error(`节点 ${targetNodeId} 的运动参数 0x${parameterId.toString(16).toUpperCase()} 响应不匹配`);
      }
      return [name, Number(ack.value)];
    },
  ));
  return Object.freeze({ nodeId: targetNodeId, ...Object.fromEntries(entries) });
}

ipcMain.handle(IPC_REQUEST, async (event, payload) => {
  assertTrustedRenderer(event);
  assertOperational();
  const request = sanitizeRequest(payload);
  if (request.action === "motion_profile") {
    return readMotionProfile(request.params.nodeId);
  }
  if (request.action === "status_many") {
    return bridge.request(request.action, request.params);
  }
  return bridge.requestWithAck(request.action, request.params);
});

ipcMain.handle(CONFIG_EXPORT_CHANNEL, async (event, content) => {
  assertTrustedRenderer(event);
  assertOperational();
  return exportConfigurationFile(content);
});

ipcMain.handle(CONFIG_IMPORT_CHANNEL, async (event) => {
  assertTrustedRenderer(event);
  assertOperational();
  return importConfigurationFile();
});

ipcMain.handle(TIMELINE_EXPORT_CHANNEL, async (event, content) => {
  assertTrustedRenderer(event);
  assertOperational();
  return exportTimelineFile(content);
});

ipcMain.handle(TIMELINE_IMPORT_CHANNEL, async (event) => {
  assertTrustedRenderer(event);
  assertOperational();
  return importTimelineFile();
});

ipcMain.handle(ACTION_TIMELINE_EXPORT_CHANNEL, async (event, content) => {
  assertTrustedRenderer(event);
  assertOperational();
  return exportActionTimelineFile(content);
});

ipcMain.handle(ACTION_TIMELINE_IMPORT_CHANNEL, async (event) => {
  assertTrustedRenderer(event);
  assertOperational();
  return importActionTimelineFile();
});

bridge.on("event", (message) => sendDriverEvent(message));

const ownsInstanceLock = app.requestSingleInstanceLock();
if (!ownsInstanceLock) {
  shutdownComplete = true;
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    configureSessionSecurity();
    bridge.start();
    createWindow();
  }).catch(() => {
    void requestSafeQuit();
  });

  app.on("activate", () => {
    if (!applicationClosing && BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on("window-all-closed", () => {
    if (!shutdownComplete) void requestSafeQuit();
  });

  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void requestSafeQuit();
  });

  process.once("SIGINT", () => void requestSafeQuit());
  process.once("SIGTERM", () => void requestSafeQuit());
}
