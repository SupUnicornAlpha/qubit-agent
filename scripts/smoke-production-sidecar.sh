#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-${ROOT}/dist/bundle/bin/qubit}"
APP_ROOT_INPUT="${2:-${ROOT}/dist/bundle/resources}"
APP_ROOT="$(cd "${APP_ROOT_INPUT}" 2>/dev/null && pwd || true)"
PORT="${QUBIT_SIDECAR_SMOKE_PORT:-28386}"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qubit-sidecar-smoke.XXXXXX")"
LOG="${DATA_DIR}/sidecar.log"
HEALTH_FILE="${DATA_DIR}/health.json"
PID=""

cleanup() {
  if [[ -n "${PID}" ]] && kill -0 "${PID}" 2>/dev/null; then
    kill "${PID}" 2>/dev/null || true
    wait "${PID}" 2>/dev/null || true
  fi
  rm -rf "${DATA_DIR}"
}
trap cleanup EXIT

if [[ ! -x "${BIN}" ]]; then
  echo "[sidecar-smoke] binary missing or not executable: ${BIN}" >&2
  exit 1
fi
if [[ ! -d "${APP_ROOT}/db/migrations" ]]; then
  echo "[sidecar-smoke] packaged resources missing migrations: ${APP_ROOT}" >&2
  exit 1
fi

while lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

echo "[sidecar-smoke] binary=${BIN} resources=${APP_ROOT} port=${PORT}"
QUBIT_APP_ROOT="${APP_ROOT}" \
QUBIT_DATA_DIR="${DATA_DIR}" \
NODE_ENV=production \
HOST=127.0.0.1 \
PORT="${PORT}" \
"${BIN}" start >"${LOG}" 2>&1 &
PID=$!

for _ in $(seq 1 90); do
  if ! kill -0 "${PID}" 2>/dev/null; then
    echo "[sidecar-smoke] sidecar exited before readiness" >&2
    tail -n 120 "${LOG}" >&2
    exit 1
  fi
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >"${HEALTH_FILE}" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health")"
SOURCES="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/v1/market/data-sources")"
BUILD="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/v1/_meta/build-info")"

HEALTH_JSON="${HEALTH}" SOURCES_JSON="${SOURCES}" BUILD_JSON="${BUILD}" bun -e '
  const health = JSON.parse(process.env.HEALTH_JSON);
  const sources = JSON.parse(process.env.SOURCES_JSON);
  const build = JSON.parse(process.env.BUILD_JSON);
  if (!["ok", "degraded"].includes(health.status)) throw new Error(`unexpected health ${health.status}`);
  if (!health.marketData || health.marketData.status === "checking") throw new Error("market readiness gate did not finish");
  if (!Array.isArray(sources.data) || sources.data.length < 7) throw new Error("market sources not bootstrapped");
  if (build.nodeEnv !== "production" || !Number.isInteger(build.pid)) {
    throw new Error(`build info mismatch: nodeEnv=${build.nodeEnv} pid=${build.pid}`);
  }
  console.log(`[sidecar-smoke] ok health=${health.status} market=${health.marketData.status} sources=${sources.data.length}`);
'

if rg -q "ERR_DLOPEN_FAILED|libduckdb.*not found|Library not loaded" "${LOG}"; then
  echo "[sidecar-smoke] DuckDB native library failed to load" >&2
  tail -n 120 "${LOG}" >&2
  exit 1
fi
