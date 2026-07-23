#!/usr/bin/env bash
#
# 开发期一键启动后端（独立于 Tauri）。
#
# 用法：
#   bash scripts/dev-backend.sh           # bun --watch 模式，改 ts 自动 graceful restart
#   QUBIT_DEV_NO_WATCH=1 bash scripts/dev-backend.sh   # 关 watch，跑一次（长 backtest 等场景）
#
# 适用场景：
#   - 改了 Rust 代码不想等 `tauri dev` 重新 cargo build，又希望后端立即生效；
#   - 想看实时 backend 日志（直接 stdout），不需要去 dev-backend.log 翻。
#
# 注意：
#   1. 启动前会 `kill $(lsof -ti :17385)` 把 Tauri sidecar 或上一个进程占的端口腾出来；
#   2. 用 macOS Tauri 实际的数据目录（~/Library/Application Support/app.qubit.agent）
#      和仓库根作为 QUBIT_APP_ROOT，与 sidecar 模式行为完全一致；
#   3. Ctrl-C 退出。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR_DEFAULT="$HOME/Library/Application Support/app.qubit.agent"
DATA_DIR="${QUBIT_DATA_DIR:-$DATA_DIR_DEFAULT}"
PORT="${PORT:-17385}"
HOST="${HOST:-127.0.0.1}"

# 占端口的进程统统让位（典型是 Tauri 启的 sidecar 或上一轮没退干净的 bun）。
STALE_PID=$(lsof -ti :"$PORT" 2>/dev/null || true)
if [ -n "${STALE_PID:-}" ]; then
  echo "[dev-backend] killing stale process on :$PORT (pid=$(echo "$STALE_PID" | tr '\n' ' '))"
  echo "$STALE_PID" | xargs kill 2>/dev/null || true
  sleep 1
fi

if [ "${QUBIT_DEV_NO_WATCH:-0}" = "1" ] || [ "${QUBIT_DEV_NO_WATCH:-}" = "true" ]; then
  BUN_CMD=(bun run)
  WATCH_FLAG=0
else
  BUN_CMD=(bun --watch run)
  WATCH_FLAG=1
fi

cd "$REPO_ROOT"
export PORT HOST
export QUBIT_APP_ROOT="$REPO_ROOT"
export QUBIT_DATA_DIR="$DATA_DIR"
export QUBIT_BUN_WATCH="$WATCH_FLAG"

echo "[dev-backend] starting on :$PORT"
echo "[dev-backend]   QUBIT_APP_ROOT=$QUBIT_APP_ROOT"
echo "[dev-backend]   QUBIT_DATA_DIR=$QUBIT_DATA_DIR"
echo "[dev-backend]   watch=$WATCH_FLAG"
exec "${BUN_CMD[@]}" src/index.ts
