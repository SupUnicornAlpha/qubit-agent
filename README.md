# QUBIT Agent Platform

QUBIT 是一个面向量化研究场景的多 Agent 平台，当前版本已经具备：

- 统一 Agent Runtime（LangGraph perceive/reason/act/observe）
- Sandbox 策略校验与违规审计
- 前端运行监控（workflow 创建、Agent 状态、SSE 事件流）
- 配置中心（workspace 配置 diff、reload、模型配置）
- Tauri 客户端 sidecar（启动/停止/查询后端状态）

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

## 常用 API

- `POST /api/v1/workflows`：创建 workflow（返回 `runId`）
- `GET /api/v1/workflows/:id/stream/:runId`：订阅步骤流
- `GET /api/v1/agents`：查询运行中 Agent
- `POST /api/v1/agents/reload`：重载 runtime 配置
- `GET /api/v1/agents/config`：查看 workspace/DB/runtime 配置对比
- `GET /api/v1/agents/model-config`：读取模型配置
- `POST /api/v1/agents/model-config`：保存模型配置

## 说明

- `.qubit/`、`.idea/` 已在 `.gitignore`，属于本地运行配置与 IDE 产物。
- 当前实现以 MVP 为目标，重点在 runtime 与桌面端联通闭环。
