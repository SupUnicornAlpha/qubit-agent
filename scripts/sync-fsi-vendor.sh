#!/usr/bin/env bash
# 将 Anthropic financial-services 中 manifest 引用的 Skills / Playbook 同步到本仓库 vendor/。
# 用法：
#   ./scripts/sync-fsi-vendor.sh              # 优先 submodule，其次浅克隆
#   ./scripts/sync-fsi-vendor.sh --force      # 覆盖已有 vendor
#   FSI_SOURCE=/path/to/financial-services ./scripts/sync-fsi-vendor.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACK="$ROOT/content-packs/anthropic-fsi"
VENDOR="$PACK/vendor"
MANIFEST="$PACK/manifest.json"
SUBMODULE="$PACK/financial-services"
UPSTREAM_REPO="${FSI_UPSTREAM_REPO:-https://github.com/anthropics/financial-services.git}"
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
  esac
done

if [[ ! -f "$MANIFEST" ]]; then
  echo "manifest not found: $MANIFEST" >&2
  exit 1
fi

resolve_source() {
  if [[ -n "${FSI_SOURCE:-}" && -d "$FSI_SOURCE" ]]; then
    echo "$FSI_SOURCE"
    return
  fi
  if [[ -d "$SUBMODULE/.git" || -f "$SUBMODULE/plugins/vertical-plugins/equity-research/skills/earnings-analysis/SKILL.md" ]]; then
    echo "$SUBMODULE"
    return
  fi
  local tmp
  tmp="$(mktemp -d)"
  echo "[sync-fsi] Shallow clone $UPSTREAM_REPO ..." >&2
  git clone --depth 1 "$UPSTREAM_REPO" "$tmp" >&2
  echo "$tmp"
  trap 'rm -rf "$tmp"' EXIT
}

if [[ -d "$VENDOR" && "$FORCE" != true ]]; then
  count="$(find "$VENDOR" -name 'SKILL.md' 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "${count:-0}" -ge 10 ]]; then
    echo "[sync-fsi] vendor/ already has $count SKILL.md files; use --force to refresh."
    exit 0
  fi
fi

SOURCE="$(resolve_source)"
echo "[sync-fsi] Source: $SOURCE"

python3 - "$SOURCE" "$VENDOR" "$MANIFEST" <<'PY'
import json, os, shutil, sys
source, vendor, manifest_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(manifest_path, encoding="utf-8") as f:
    m = json.load(f)
paths = set()
for sk in m.get("skills", {}).values():
    paths.add(sk["path"])
for wf in m.get("agentWorkflows", {}).values():
    paths.add(wf["playbookPath"])
os.makedirs(vendor, exist_ok=True)
copied = 0
for rel in sorted(paths):
    src = os.path.join(source, rel)
    dst = os.path.join(vendor, rel)
    if not os.path.isfile(src):
        print(f"  skip (missing): {rel}", file=sys.stderr)
        continue
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    copied += 1
print(f"[sync-fsi] Copied {copied} files into {vendor}")
PY

# 记录来源（便于合规与更新）
git -C "$SOURCE" rev-parse HEAD 2>/dev/null >"$VENDOR/SOURCE_COMMIT.txt" || echo "unknown" >"$VENDOR/SOURCE_COMMIT.txt"
echo "$UPSTREAM_REPO" >"$VENDOR/SOURCE_REPO.txt"
date -u +"%Y-%m-%dT%H:%M:%SZ" >"$VENDOR/SYNCED_AT.txt"

echo "[sync-fsi] Done."
