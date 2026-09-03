#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="${APP_DIR}/scripts/run.sh"

desktop_exec_quote() {
  local value="${1}"
  value="${value//\\/\\\\\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
  value="${value//\`/\\\`}"
  value="${value//%/%%}"
  printf '"%s"' "${value}"
}

DESKTOP_OVERRIDE="${ACTION_EDITOR_DESKTOP_DIR:-${LUMMOTOR_DESKTOP_DIR:-}}"
if [[ -n "${DESKTOP_OVERRIDE}" ]]; then
  DESKTOP_DIR="${DESKTOP_OVERRIDE}"
elif command -v xdg-user-dir >/dev/null 2>&1; then
  DESKTOP_DIR="$(xdg-user-dir DESKTOP)"
else
  DESKTOP_DIR="${HOME}/Desktop"
fi
if [[ -z "${DESKTOP_DIR}" ]]; then
  DESKTOP_DIR="${HOME}/Desktop"
fi

mkdir -p -- "${DESKTOP_DIR}"
TARGET="${DESKTOP_DIR}/Action Editor.desktop"
TEMPORARY="$(mktemp "${DESKTOP_DIR}/.Action-Editor.desktop.XXXXXX")"
trap 'rm -f -- "${TEMPORARY}"' EXIT

{
  printf '%s\n' '[Desktop Entry]'
  printf '%s\n' 'Version=1.0'
  printf '%s\n' 'Type=Application'
  printf '%s\n' 'Name=Action Editor'
  printf '%s\n' 'Comment=CAN motor and action timeline controller'
  printf 'Exec=%s\n' "$(desktop_exec_quote "${RUNNER}")"
  printf '%s\n' 'Icon=applications-engineering'
  printf '%s\n' 'Terminal=false'
  printf '%s\n' 'Categories=Development;Engineering;'
  printf '%s\n' 'StartupNotify=true'
  printf '%s\n' 'StartupWMClass=action-editor'
} >"${TEMPORARY}"

chmod 755 -- "${TEMPORARY}"
mv -f -- "${TEMPORARY}" "${TARGET}"
trap - EXIT
printf '已安装桌面快捷方式：%s\n' "${TARGET}"
