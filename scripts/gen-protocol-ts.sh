#!/usr/bin/env bash
# Refresh JSON schemas from Rust (source of truth), then remind to sync protocol-ts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
cargo run -p qubit-protocol --example export_schemas
echo "Schemas written under crates/qubit-protocol/schemas/"
echo "Hand-synced types live in packages/protocol-ts/src/index.ts — update if wire shapes changed."
