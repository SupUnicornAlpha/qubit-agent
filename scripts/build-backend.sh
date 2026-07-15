#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

OUTFILE="${1:-dist/qubit}"
mkdir -p "$(dirname "${OUTFILE}")"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) DUCKDB_TARGET="darwin-arm64" ;;
  Darwin-x86_64) DUCKDB_TARGET="darwin-x64" ;;
  Linux-arm64|Linux-aarch64) DUCKDB_TARGET="linux-arm64" ;;
  Linux-x86_64) DUCKDB_TARGET="linux-x64" ;;
  MINGW*-ARM64|MSYS*-ARM64) DUCKDB_TARGET="win32-arm64" ;;
  MINGW*-x86_64|MSYS*-x86_64) DUCKDB_TARGET="win32-x64" ;;
  *)
    echo "Unsupported build platform for DuckDB binding: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

DUCKDB_PLATFORMS=(
  linux-x64
  linux-arm64
  darwin-arm64
  darwin-x64
  win32-arm64
  win32-x64
)

EXTERNAL_ARGS=()
for platform in "${DUCKDB_PLATFORMS[@]}"; do
  if [[ "${platform}" != "${DUCKDB_TARGET}" ]]; then
    EXTERNAL_ARGS+=(--external "@duckdb/node-bindings-${platform}/duckdb.node")
  fi
done

echo "[build-backend] target=${DUCKDB_TARGET} outfile=${OUTFILE}"
bun build --compile "scripts/backend-entry/${DUCKDB_TARGET}.ts" \
  --outfile "${OUTFILE}" \
  --asset-naming '[name].[ext]' \
  "${EXTERNAL_ARGS[@]}"
chmod +x "${OUTFILE}"
