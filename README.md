# QUBIT Agent Platform

QUBIT 是一个面向量化研究场景的多 Agent 平台，当前版本已经具备：

- 统一 Agent Runtime（LangGraph perceive/reason/act/observe）
- Sandbox 策略校验与违规审计
- 前端运行监控（session/workflow/step/tool/sandbox 多层观测）
- 配置中心（workspace 配置 diff、reload、模型配置、Agent 草稿/发布）
- 对话工作台（session 管理、User/Agent 对话、消息关联 workflow 轨迹）
- Tauri 客户端 sidecar（启动/停止/查询后端状态）
- Broker 接入治理（账号配置、健康检查、事件审计；支持 mock/sandbox/live）
- Workflow 失败补偿队列（入队、重试、批处理执行）
- 集成管理中心（Telegram/Webhook 通道配置与消息日志）
- 团队面板联动选择器（workflow/intents 去手填）

## 技术栈

- 后端：Bun + TypeScript + Hono + Drizzle + SQLite
- 编排：LangGraph.js + OpenAI SDK
- 前端：Vite + React + Zustand
- 桌面端：Tauri v2（Rust）

## 目录结构

- `src/`: 后端服务、runtime、路由、数据库
- `frontend/`: Web UI
- `src-tauri/`: 桌面客户端
- `python_connectors/`: Python 连接器骨架

## 本地开发环境

- Bun `>= 1.3`
- Node.js `>= 20`（仅部分工具链依赖）
- Rust/Cargo（Tauri 编译需要）

## 快速启动（后端 + 前端）

1. 安装根依赖

```bash
bun install
```

2. 生成数据库 migration（首次或 schema 变更后）

```bash
bun run db:generate
```

3. 启动后端

```bash
bun run dev
```

4. 启动前端

```bash
bun run --cwd frontend dev
```

默认访问：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`

## 启动 Tauri 客户端

在项目根目录执行：

```bash
bun tauri dev
```

客户端启动后会通过 Tauri command 拉起后端（sidecar 风格），并在 UI 顶部显示后端连接状态。

## 模型配置（前端/客户端）

在“配置中心”可以配置：

- `model`（例如 `gpt-4o-mini`）
- `apiKey`
- `baseUrl`（可选）

保存后会写入本地：

- `.qubit/model.json`

`reason` 节点优先读取该文件；若未配置则回退到环境变量 `OPENAI_API_KEY`。

当前支持 provider：

- `openai`
- `anthropic`
- `ollama`
- `deepseek`
- `qwen`（阿里云 DashScope 兼容模式）
- `zhipu`
- `mock`

常见环境变量回退：

- OpenAI：`OPENAI_API_KEY`
- Anthropic：`ANTHROPIC_API_KEY`
- DeepSeek：`DEEPSEEK_API_KEY`
- Qwen：`DASHSCOPE_API_KEY`
- Zhipu：`ZHIPU_API_KEY`

## 常用 API

- `POST /api/v1/workflows`：创建 workflow（返回 `runId`）
- `GET /api/v1/workflows/:id/stream/:runId`：订阅步骤流
- `GET /api/v1/agents`：查询运行中 Agent
- `POST /api/v1/agents/reload`：重载 runtime 配置
- `GET /api/v1/agents/config`：查看 workspace/DB/runtime 配置对比
- `GET /api/v1/agents/model-config`：读取模型配置
- `POST /api/v1/agents/model-config`：保存模型配置
- `GET /api/v1/agents/definitions`：读取 Agent 发布态/草稿态/角色 profile
- `POST /api/v1/agents/definitions/:id/draft`：保存 Agent 草稿
- `POST /api/v1/agents/definitions/:id/release`：发布草稿并触发 runtime reload
- `GET /api/v1/chat/sessions?workspaceId=&projectId=`：查询会话列表
- `POST /api/v1/chat/sessions`：创建会话
- `GET /api/v1/chat/sessions/:id/messages`：查询会话消息
- `POST /api/v1/chat/sessions/:id/messages`：写入会话消息
- `GET /api/v1/monitor/sessions/:id/overview`：查询会话聚合监控
- `GET /api/v1/monitor/workflows/:id/timeline`：查询 workflow 时间线
- `GET /api/v1/monitor/workflows/:id/sandbox-violations`：查询 sandbox 违规记录
- `GET /api/v1/reia/broker/accounts`：查询 Broker 账号配置
- `POST /api/v1/reia/broker/accounts/upsert`：创建/更新 Broker 账号
- `POST /api/v1/reia/broker/health-check`：执行 Broker 健康检查
- `GET /api/v1/reia/broker/events`：查询 Broker 事件日志
- `POST /api/v1/workflows/compensation/enqueue`：新增补偿任务
- `GET /api/v1/workflows/compensation/tasks`：查询补偿任务队列
- `POST /api/v1/workflows/compensation/process`：批量执行补偿任务
- `GET /api/v1/integrations/channels`：查询集成通道配置
- `POST /api/v1/integrations/channels/upsert`：保存集成通道配置
- `GET /api/v1/integrations/logs`：查询集成消息日志

## 真券商接入（可选）

是否使用**模拟盘 / 实盘**由你在券商侧与环境中自行决定；QUBIT 只提供统一 HTTP 桥与账号配置。

1. （可选）安装 Python 依赖：`cd python_connectors && pip install futu-api ib-insync`（按你实际使用的券商安装其一或全部）。
2. 启动本地 HTTP 桥：`python broker_http_server.py`（默认监听 `http://127.0.0.1:18765`，可用环境变量 `QUBIT_BROKER_PORT` 修改）。
3. 在后端 `POST /api/v1/reia/broker/accounts/upsert` 或使用 UI 配置 Broker 账号：`baseUrl` 指向上述地址，`mode` 为 `sandbox` 或 `live`，`accountRef` 自定义标识即可。
4. 环境变量提示：`QUBIT_BROKER_PROVIDER`（`futu` | `ib`）、`QUBIT_FUTU_OPEND_HOST` / `QUBIT_FUTU_OPEND_PORT`（富途 OpenD）、`QUBIT_IB_HOST` / `QUBIT_IB_PORT`、`QUBIT_BROKER_PAPER=1` 表示在支持模拟环境时走模拟（具体以各券商 API 为准）。

未安装 SDK 时桥接服务仍可对 `/health`、`/orders` 返回**模拟成功**，便于联调；接入真实交易前请务必阅读券商协议与风控要求。

## 外部 MCP（stdio / http / ws）

在 `mcp_server_config` 中为同一服务配置 `transport` 与连接信息：

- **stdio**：填写 `command`（可执行命令行），或通过 `capabilities_json.argv` 传入字符串数组；可选 `capabilities_json.env`、`cwd`。
- **http**：填写 `url`（POST 接收 JSON-RPC `tools/call` 的端点）；可选 `capabilities_json.httpPath`、`capabilities_json.httpHeaders`。
- **ws**：填写可建立 WebSocket 的 `url`，按行发送/接收 JSON-RPC。

工具级超时可在 `mcp_tool_binding` 中按 `server_name` + `tool_name`（或 `*`）配置 `timeout_ms`。

## 说明

- `.qubit/`、`.idea/` 已在 `.gitignore`，属于本地运行配置与 IDE 产物。
- 当前实现以 MVP 为目标，重点在 runtime 与桌面端联通闭环。
