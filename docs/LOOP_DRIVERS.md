# QUBIT Agent Loop 驱动（Native / Claude CLI / Codex CLI）

工作流（`workflow_run`）可选择三种 **Agent Loop**：

| `loop_kind`   | 行为 |
|---------------|------|
| `native`      | 默认：服务端 LangGraph `GraphRunner`（perceive→reason→act→observe）。 |
| `claude_cli`  | 子进程执行 `claude`（可 `loop_options_json.command` 覆盖），stdin 忽略；读取 stdout/stderr。 |
| `codex_cli`   | 子进程执行 `codex exec <promptFile>`（命令与参数可通过 `loop_options_json` 调整）。 |

## 配置字段

`workflow_run.loop_options_json`（JSON 对象，可选键）：

- `command`：可执行文件路径或 PATH 上的名称。
- `extraArgs`：插入在默认参数**之前**的额外 argv（便于加 `--model` 等）。
- `timeoutMs`：子进程超时（默认 900000）。
- `injectMcpBridge`：是否在 `.qubit/loop-runs/<workflowId>/` 下生成 `qubit-mcp-bridge.json`（默认 `true`）。设为 `false` 可关闭 MCP 片段。
- `maxOutputBytes`：stdout 累计大小上限（默认 8MB）。

## MCP Bridge（stdio）

生成目录中的 `qubit-mcp-bridge.json` 描述单个 MCP server：`qubit`，其 stdio 入口为：

`bun run <repo>/src/runtime/loop/mcp-bridge-server.ts`

环境变量 `QUBIT_MCP_BRIDGE_PROJECT_ID` 设为当前 `projectId`，以便与 QUBIT 内 `mcp_server_config` / `mcp_tool_binding` 一致解析。

Bridge 暴露工具 **`call_qubit_mcp`**，参数：

```json
{
  "serverName": "your-server-name",
  "toolName": "tool_name",
  "arguments": {}
}
```

内部调用与 UI 相同的 `dispatchMcpToolCall`。

本机需已安装 **bun** 且在 PATH 中，以便外部 CLI 子进程能启动 bridge。

## 可选机器协议（stdout NDJSON）

外部 CLI 可逐行输出 JSON（便于结构化观测）：

```json
{"v":"qubit.loop.v1","type":"log","message":"..."}
{"v":"qubit.loop.v1","type":"tool","tool":"x","payload":{}}
{"v":"qubit.loop.v1","type":"error","message":"..."}
{"v":"qubit.loop.v1","type":"final","payload":{"status":"completed"}}
```

非 JSON 行记为普通 stdout 日志事件。进程退出码非 0 时工作流记为 `failed`。

## 限制说明

- Native 路径下的 **内置 Connector 工具**（非 MCP）不会自动出现在 CLI；CLI 侧主要通过 **MCP bridge** 复用你在 QUBIT 里配置的 MCP。
- 各厂商 CLI 的实际子命令（如 `claude -p` / `codex exec`）可能随版本变化；若默认不匹配，请用 `command` + `extraArgs` 覆盖。
- 取消运行：导出 `cancelCliLoopRun(runId)`（`src/runtime/loop`），供后续 HTTP 取消接口接入。
