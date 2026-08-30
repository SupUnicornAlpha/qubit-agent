#!/usr/bin/env bash
#
# Tauri validates bundle.externalBin even for `tauri dev`. Development normally
# uses the Bun fallback from src-tauri/src/lib.rs, so create an ignored,
# executable placeholder only when the real packaged sidecar is absent.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${TAURI_ENV_TARGET_TRIPLE:-$(rustc --print host-tuple)}"
SIDECAR="${ROOT}/src-tauri/binaries/qubit-sidecar-${TARGET}"

mkdir -p "${ROOT}/src-tauri/binaries"
if [[ ! -e "${SIDECAR}" ]]; then
  cat >"${SIDECAR}" <<'EOF'
#!/usr/bin/env bash
echo "Development placeholder: src-tauri uses Bun backend fallback." >&2
exit 0
EOF
  chmod +x "${SIDECAR}"
  echo "Created development Tauri sidecar placeholder: ${SIDECAR}"
fi
