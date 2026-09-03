#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_ENTRY="${APP_DIR}/node_modules/electron/cli.js"

find_node() {
  node_supported() {
    "${1}" -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && (minor > 20 || (minor === 20 && patch >= 0))) ? 0 : 1)' >/dev/null 2>&1
  }

  local node_override="${ACTION_EDITOR_NODE:-${LUMMOTOR_NODE:-}}"
  if [[ -n "${node_override}" && -x "${node_override}" ]] && node_supported "${node_override}"; then
    printf '%s\n' "${node_override}"
    return
  fi
  local path_node
  path_node="$(command -v node 2>/dev/null || true)"
  if [[ -n "${path_node}" ]] && node_supported "${path_node}"; then
    printf '%s\n' "${path_node}"
    return
  fi
  local candidate
  shopt -s nullglob
  for candidate in "${HOME}/.local/nodejs"/node-v*/bin/node; do
    if [[ -x "${candidate}" ]] && node_supported "${candidate}"; then
      printf '%s\n' "${candidate}"
      return
    fi
  done
  return 1
}

if ! NODE_BIN="$(find_node)"; then
  echo "未找到 Node.js 24.20 或更高版本。请先安装 Node.js 24 LTS，或通过 ACTION_EDITOR_NODE 指定可执行文件。" >&2
  exit 1
fi

if [[ ! -f "${ELECTRON_ENTRY}" ]]; then
  echo "未安装 Action Editor 的 Electron 依赖。请在 ${APP_DIR} 运行 npm ci。" >&2
  exit 1
fi

cd "${APP_DIR}"
exec "${NODE_BIN}" "${ELECTRON_ENTRY}" "${APP_DIR}" "$@"
