"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const IPC_REQUEST = "motor-terminal:request";
const CONFIG_EXPORT_CHANNEL = "motor-terminal:config-export";
const CONFIG_IMPORT_CHANNEL = "motor-terminal:config-import";
const TIMELINE_EXPORT_CHANNEL = "motor-terminal:timeline-export";
const TIMELINE_IMPORT_CHANNEL = "motor-terminal:timeline-import";
const ACTION_TIMELINE_EXPORT_CHANNEL = "motor-terminal:action-timeline-export";
const ACTION_TIMELINE_IMPORT_CHANNEL = "motor-terminal:action-timeline-import";
const DRIVER_EVENT = "driver:event";

const invoke = (action, params = {}) => ipcRenderer.invoke(
  IPC_REQUEST,
  { action, params },
);

function onDriverEvent(callback) {
  if (typeof callback !== "function") {
    throw new TypeError("callback 必须是函数");
  }
  const listener = (_event, message) => callback(message);
  ipcRenderer.on(DRIVER_EVENT, listener);
  return () => ipcRenderer.removeListener(DRIVER_EVENT, listener);
}

contextBridge.exposeInMainWorld("motorTerminal", Object.freeze({
  connect: (options) => invoke("connect", options),
  disconnect: () => invoke("disconnect"),
  move: (options) => invoke("move", options),
  stop: (options) => invoke("stop", options),
  disable: (options) => invoke("disable", options),
  statusMany: (nodeIds, flags = 15) => invoke("status_many", { nodeIds, flags }),
  motionProfile: (nodeId) => invoke("motion_profile", { nodeId }),
  exportConfigFile: (content) => ipcRenderer.invoke(CONFIG_EXPORT_CHANNEL, content),
  importConfigFile: () => ipcRenderer.invoke(CONFIG_IMPORT_CHANNEL),
  exportTimelineFile: (content) => ipcRenderer.invoke(TIMELINE_EXPORT_CHANNEL, content),
  importTimelineFile: () => ipcRenderer.invoke(TIMELINE_IMPORT_CHANNEL),
  exportActionTimelineFile: (content) => ipcRenderer.invoke(ACTION_TIMELINE_EXPORT_CHANNEL, content),
  importActionTimelineFile: () => ipcRenderer.invoke(ACTION_TIMELINE_IMPORT_CHANNEL),
  onDriverEvent,
}));
