#!/usr/bin/env bash
#
# 一键接入 Rust Core + Bun：起 qubit-app-server（带 Legacy Bridge）再起 Bun。
#
# 用法：
#   bash scripts/prime-up.sh
#   PORT=3000 QUBIT_BIND=127.0.0.1:8787 bash scripts/prime-up.sh
#
# 环境：
#   QUBIT_CORE_BACKEND   默认 rust（本脚本强制接入 Core）
#   QUBIT_CORE_STRICT=1  Core 不可达则 Bun 拒绝回落 TS（默认开启）
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"
BIND="${QUBIT_BIND:-127.0.0.1:8787}"
BRIDGE_URL="http://${HOST}:${PORT}/api/v1/prime-bridge"
CORE_URL="http://${BIND}"

BIN_CANDIDATES=(
  "${CARGO_TARGET_DIR:+$CARGO_TARGET_DIR/debug/qubit-app-server}"
  "$REPO_ROOT/target/debug/qubit-app-server"
)
BIN=""
for c in "${BIN_CANDIDATES[@]}"; do
  [ -n "$c" ] && [ -x "$c" ] && BIN="$c" && break
done
if [ -z "$BIN" ]; then
  echo "[prime-up] building qubit-app-server..."
  cargo build -p qubit-app-server
  for c in "${BIN_CANDIDATES[@]}"; do
    [ -n "$c" ] && [ -x "$c" ] && BIN="$c" && break
  done
fi
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "[prime-up] qubit-app-server binary not found"
  exit 1
fi
echo "[prime-up] using $BIN"
# free ports if needed
for p in "${PORT}" "${BIND##*:}"; do
  STALE=$(lsof -ti :"$p" 2>/dev/null || true)
  if [ -n "${STALE:-}" ]; then
    echo "[prime-up] killing stale on :$p"
    echo "$STALE" | xargs kill 2>/dev/null || true
    sleep 0.5
  fi
done

echo "[prime-up] starting Core on ${BIND} (bridge→${BRIDGE_URL})"
QUBIT_LEGACY_BRIDGE_URL="$BRIDGE_URL" \
QUBIT_BIND="$BIND" \
RUST_LOG="${RUST_LOG:-qubit_app_server=info,qubit_runtime=warn}" \
  "$BIN" --bind "$BIND" &
CORE_PID=$!

cleanup() {
  echo "[prime-up] stopping Core pid=$CORE_PID"
  kill "$CORE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# wait Core health
deadline=$((SECONDS + 30))
until curl -sf "${CORE_URL}/health" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "[prime-up] Core health timeout"
    exit 1
  fi
  sleep 0.2
done
echo "[prime-up] Core healthy"

echo "[prime-up] starting Bun on ${HOST}:${PORT} (QUBIT_CORE_BACKEND=rust)"
export PORT HOST
export QUBIT_CORE_BACKEND=rust
export QUBIT_RUST_CORE_URL="$CORE_URL"
export QUBIT_LEGACY_BRIDGE_URL="$BRIDGE_URL"
export QUBIT_CORE_STRICT="${QUBIT_CORE_STRICT:-1}"
export QUBIT_UNPRODUCTIVE_BUDGET="${QUBIT_UNPRODUCTIVE_BUDGET:-0}"

exec bun run src/index.ts
