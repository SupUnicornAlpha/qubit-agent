#!/usr/bin/env bash
# 预下载 requirements.txt 中所有依赖的 wheel 到 python_connectors/wheels/，
# 之后 bootstrap 时会优先离线安装（`pip install --no-index --find-links`），
# 实现首次装机零网络 + 弱网环境秒级初始化。
#
# 使用：
#   scripts/build-python-wheels.sh                       # 当前平台
#   scripts/build-python-wheels.sh macosx_11_0_arm64     # 指定单一目标平台
#   PYTHON_VERSION=3.11 scripts/build-python-wheels.sh   # 指定 Python 版本
#
# 多平台分发：在每个目标平台分别执行一次，把生成的 .whl 一起 ship。
# Anaconda 等用户已有 pandas/numpy 的环境无影响（venv 仍是隔离的）。

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REQ="$ROOT/python_connectors/requirements.txt"
DEST="$ROOT/python_connectors/wheels"

if [[ ! -f "$REQ" ]]; then
  echo "error: $REQ not found" >&2
  exit 1
fi

mkdir -p "$DEST"

PY=${PYTHON_BIN:-python3}
declare -a PLATFORM_ARG=()
if [[ $# -ge 1 ]]; then
  PLATFORM_ARG+=(--platform "$1" --only-binary=:all:)
fi
if [[ -n "${PYTHON_VERSION:-}" ]]; then
  PLATFORM_ARG+=(--python-version "$PYTHON_VERSION")
fi

echo "Downloading wheels for $(grep -vE '^\s*#' "$REQ" | grep -vE '^\s*$' | tr '\n' ' ')"
echo "  → $DEST"
echo "  python: $PY  platform args: ${PLATFORM_ARG[*]:-<current>}"

if (( ${#PLATFORM_ARG[@]} > 0 )); then
  "$PY" -m pip download --dest "$DEST" "${PLATFORM_ARG[@]}" -r "$REQ"
else
  "$PY" -m pip download --dest "$DEST" -r "$REQ"
fi

echo
echo "Wheels written. Counts by package:"
ls -1 "$DEST" | sed -E 's/-[0-9].*//' | sort | uniq -c
