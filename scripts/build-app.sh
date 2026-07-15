#!/usr/bin/env bash
#
# 将 QUBIT 打成可安装桌面应用（Tauri）+ 独立后端二进制。
# 开发仍使用: bun run dev && bun run dev:frontend
#
# 用法:
#   ./scripts/build-app.sh           # 仅准备 bundle（二进制 + 资源）
#   ./scripts/build-app.sh --tauri   # 并执行 tauri build 产出 .dmg/.msi 等
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

PACKAGED_PORT=17385
RUN_TAURI=false
if [[ "${1:-}" == "--tauri" ]]; then
  RUN_TAURI=true
fi

echo "==> [1/8] install dependencies"
bun install
bun install --cwd frontend

echo "==> [2/8] prepare bundle resources"
bash scripts/prepare-bundle-resources.sh

echo "==> [3/8] python venv (optional, same OS/arch as build host)"
bash scripts/setup-python-venv.sh || true

echo "==> [4/8] compile backend binary"
bash scripts/build-backend.sh dist/bundle/bin/qubit

echo "==> [5/8] production sidecar smoke"
bash scripts/smoke-production-sidecar.sh dist/bundle/bin/qubit

echo "==> [6/8] build frontend (packaged backend URL)"
export VITE_BACKEND_URL="http://127.0.0.1:${PACKAGED_PORT}"
# 打包走 vite build（与 dev 一致）；完整 tsc 仍用 `bun run --cwd frontend build`
(cd frontend && bunx vite build)

echo "==> [7/8] stage for Tauri"
TARGET="$(rustc --print host-tuple)"
mkdir -p src-tauri/binaries
cp dist/bundle/bin/qubit "src-tauri/binaries/qubit-${TARGET}"

echo "    sidecar: src-tauri/binaries/qubit-${TARGET}"
echo "    resources: dist/bundle/resources → \$RESOURCE/bundle/"

if [[ "${RUN_TAURI}" == true ]]; then
  echo "==> [8/8] tauri build"
  if ! command -v cargo >/dev/null 2>&1; then
    echo "Rust/Cargo is required for tauri build. Install from https://rustup.rs"
    exit 1
  fi
  # macOS 的 create-dmg 会调用系统 Perl；部分终端继承的 C.UTF-8 在 macOS
  # 不存在，会让卷图标阶段 panic 并遗留挂载盘。固定到 POSIX C locale。
  if [[ "$(uname -s)" == "Darwin" ]]; then
    LC_ALL=C LANG=C bun run build:tauri -- --ci
  else
    bun run build:tauri -- --ci
  fi
  echo ""
  echo "Installers are under src-tauri/target/release/bundle/"
else
  echo "==> [8/8] skip tauri build (pass --tauri to create .dmg/.msi)"
  echo ""
  echo "Test backend bundle manually:"
  echo "  QUBIT_APP_ROOT=${ROOT}/dist/bundle/resources \\"
  echo "  QUBIT_DATA_DIR=\${HOME}/.quant-agent-test \\"
  echo "  PORT=${PACKAGED_PORT} HOST=127.0.0.1 \\"
  echo "  ./dist/bundle/bin/qubit start"
fi

echo ""
echo "Done."
