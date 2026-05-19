#!/usr/bin/env bash
# 在 dist/bundle/resources 下创建可随安装包分发的 Python venv（需在目标平台构建）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="${ROOT}/dist/bundle/resources/python-venv"
REQ="${ROOT}/python_connectors/requirements.txt"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[setup-python-venv] python3 not found — skip bundled venv (app will create venv on first run)"
  exit 0
fi

echo "[setup-python-venv] creating ${VENV_DIR}"
rm -rf "${VENV_DIR}"
python3 -m venv "${VENV_DIR}"

PY="${VENV_DIR}/bin/python3"
if [[ ! -x "${PY}" ]]; then
  PY="${VENV_DIR}/Scripts/python.exe"
fi

echo "[setup-python-venv] pip install -r requirements.txt"
"${PY}" -m pip install --upgrade pip
"${PY}" -m pip install -r "${REQ}"

echo "[setup-python-venv] done"
