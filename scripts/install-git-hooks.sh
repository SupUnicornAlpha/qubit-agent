#!/usr/bin/env bash
#
# 一次性把 scripts/git-hooks/ 设为 git hooks 目录。
# Clone 仓库后首次本地 commit 前跑一次即可，CI 不需要。
#
# 用法：
#   bash scripts/install-git-hooks.sh
#
# 卸载：
#   git config --unset core.hooksPath
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_DIR="$ROOT/scripts/git-hooks"

if [[ ! -d "$HOOKS_DIR" ]]; then
  echo "[install-git-hooks] missing $HOOKS_DIR" >&2
  exit 1
fi

# 给所有 hook 加可执行位（git 严格要求）。
chmod +x "$HOOKS_DIR"/* 2>/dev/null || true

git -C "$ROOT" config core.hooksPath scripts/git-hooks

echo "✓ core.hooksPath -> scripts/git-hooks"
echo "  hooks installed:"
ls -1 "$HOOKS_DIR" | sed 's/^/    - /'
