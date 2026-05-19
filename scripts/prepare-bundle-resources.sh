#!/usr/bin/env bash
# 将运行时资源复制到 dist/bundle/resources（供 Tauri 打包）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/dist/bundle/resources"

echo "[prepare-bundle] cleaning ${OUT}"
rm -rf "${OUT}"
mkdir -p "${OUT}/db"

echo "[prepare-bundle] migrations"
cp -R "${ROOT}/src/db/sqlite/migrations" "${OUT}/db/migrations"

echo "[prepare-bundle] python_connectors"
cp -R "${ROOT}/python_connectors" "${OUT}/python_connectors"
find "${OUT}/python_connectors" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

echo "[prepare-bundle] content-packs"
cp -R "${ROOT}/content-packs" "${OUT}/content-packs"

echo "[prepare-bundle] done → ${OUT}"
