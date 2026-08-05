# Qubit Prime · Rust crates

按 [`docs/qubit-prime/01-runtime-core-rust.zh-CN.md`](../docs/qubit-prime/01-runtime-core-rust.zh-CN.md) 落地（**M0–M7+ · 客户端自启 Core ✅**）。

| Crate | 里程碑 | 职责 | 状态 |
|-------|--------|------|------|
| `qubit-protocol` | M0 | 跨端类型 + JSON Schema | ✅ |
| `qubit-policy` | M5 | Recipe JSON → `PolicySnapshot` | ✅ |
| `qubit-runtime` | M1–M6 | harness + Delivery + invoke + cancel/supervisor/trigger + **CoreDb Session/HITL** | ✅ |
| `qubit-tool-host` | M4 | Legacy Bun bridge（L2：market.* + memory.*） | ✅ |
| `qubit-app-server` | M1+ | HTTP JSON-RPC + **SSE `/events`** + 默认开 CoreDb + recover_on_boot | ✅ |

**客户端启动（推荐）**：

```bash
# 先编一次 Core（开发机）
cargo build -p qubit-app-server

# Tauri / 后端：只起 Bun，会自动拉起 Core，默认 QUBIT_CORE_BACKEND=rust
bun run dev:tauri
# 或
bun run dev:backend
```

确认：`curl -s http://127.0.0.1:17385/health | jq .prime`（Tauri 端口）应见 `activeBackend: "rust"`。

- 默认路径：`rust`（Bun `ensureRustCoreRunning` 自启 `qubit-app-server`）
- 关停 Bun 时杀掉其拥有的 Core 子进程
- 强制旧路径：`QUBIT_CORE_BACKEND=ts`；禁止自启：`QUBIT_SKIP_CORE_SPAWN=1`
- Bridge：`market.resolve_symbol|readiness|data_sources|snapshot.get`
- 打包：`build-app.sh` 会把 `qubit-app-server` 拷进 `dist/bundle/bin` 与 resources
