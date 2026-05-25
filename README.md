# QUBIT Agent Platform

**量化研究多 Agent 平台** — 对话驱动研究、多分析师协作、K 线 IDE、回测与实盘编排，一体化交付。

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Tauri](https://img.shields.io/badge/desktop-Tauri%20v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)

---

## 简介

QUBIT 面向量化研究与交易自动化场景，将 **LangGraph Agent Runtime**、**多角色分析师团队**、**MCP 工具市场** 与 **可视化 IDE** 整合在同一工作台中。你可以：

- 在对话中带入 K 线上下文，由编排 Agent 调度研究 / 回测 / 风控等角色
- 在「研究团队」画布上勾选参与分析的 Agent，查看拓扑与 A2A 协作轨迹
- 在 IDE 中编辑指标与 Python 信号代码，运行 SMA 等回测
- 通过配置中心接入 MCP（Anthropic Registry）、Skills（SkillsMP）与券商（Futu / IB）

数据与策略脚本默认落在本地 `~/.quant-agent`（可通过 `QUBIT_DATA_DIR` 修改）。

---

## 截图

### 研究工作台 · 对话 + K 线 + 回测

对话会话、Agent 看板与 K 线、回测坞同屏协作；支持将行情上下文带入对话分析。

![研究工作台：对话、K 线与回测](docs/screenshots/ide-workbench.png)

### 研究团队 · 多 Agent 拓扑

按工作流组织研究任务；可配置分析师编组、启动团队分析，并在右侧绑定策略与代码（落盘至工作流目录）。

![研究团队：成员目录、拓扑画布与策略代码](docs/screenshots/research-team.png)

### 资讯 · 个股与板块新闻

个股 K 线叠加 Yahoo / 内置新闻源；支持「带入对话分析」与板块 ETF 资讯。

![资讯页：行情与新闻简报](docs/screenshots/news-brief.png)

---

## 功能特性

| 模块 | 说明 |
|------|------|
| **Agent Runtime** | LangGraph `perceive → reason → act → observe`，Sandbox 策略校验与违规审计 |
| **研究团队** | 多分析师并行、辩论 / 风控、信号融合；工作流可读名称与策略脚本按 run 绑定 |
| **QUBIT IDE** | K 线（QuantDigger）、指标编辑、Python 回测坞、策略脚本入库 |
| **对话工作台** | Session 管理、消息关联 workflow、Agent 看板与执行时间线 |
| **运行监控** | Session / Workflow / Step / Tool / Sandbox 多层观测 |
| **配置中心** | Workspace diff、模型配置、Agent 草稿发布、MCP & Skills 市场 |
| **实盘与券商** | Intent → 风控 → 执行；Futu / IB（mock / sandbox / live） |
| **桌面端** | Tauri v2 客户端，Sidecar 拉起后端并显示连接状态 |

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Bun · TypeScript · Hono · Drizzle · SQLite |
| 编排 | LangGraph.js · OpenAI SDK（多 Provider） |
| 前端 | Vite · React · Zustand |
| 桌面 | Tauri v2（Rust） |
| 连接器 | Python（`python_connectors/`，行情 / 券商桥） |

---

## 快速开始

### 0. 前置条件

| 组件 | 必须 | 用途 |
|------|------|------|
| [Bun](https://bun.sh) `>= 1.3` | 是 | 后端运行时 + 包管理 + 前端 dev server |
| Node.js `>= 20` | 推荐 | 部分构建工具链（Vite / Drizzle Kit） |
| Git | 是 | 克隆与 FSI vendor 同步 |
| Rust / Cargo（stable） | 仅构建 Tauri 客户端 | `bun run dev:tauri` / `bun run build:tauri` |
| Xcode Command Line Tools / MSVC Build Tools | 同上 | Tauri 编译原生壳 |
| Python `>= 3.10` + pip | 可选 | 行情 / 回测 / 券商 HTTP 桥（`python_connectors/`） |
| OpenD（富途）/ IB Gateway | 可选 | 实盘交易时使用 |

> 数据与策略脚本默认落在 `~/.quant-agent`，可通过 `QUBIT_DATA_DIR` 修改；macOS 桌面打包后默认为 `~/Library/Application Support/app.qubit.agent/`。

### 1. 公共步骤：克隆与安装依赖

```bash
git clone <your-fork-or-this-repo>.git qubit-agent
cd qubit-agent

# 安装根（后端）+ 前端 workspace 依赖
bun install

# 首次启动或 schema 变更后生成迁移并初始化 SQLite
bun run db:generate
bun run db:migrate
```

可选种子数据（推荐首次执行，以便配置中心 / 研究团队有内容可用）：

```bash
bun run seed:agent-definitions    # 预置 Agent 定义与研究团队编组
bun run seed:recommended-mcp      # 推荐 MCP（数学 / 金融等）
```

### 2. 后端（必启）

LangGraph runtime + Hono HTTP/WS 服务，默认 **http://localhost:3000**。

**前置条件**：完成步骤 1；如需调用云端大模型，至少配置一个 Provider 的 Key（见下文「[配置](#配置)」）。

```bash
# 终端 1
bun run dev
```

可通过环境变量覆盖监听地址：

```bash
PORT=3000 HOST=localhost bun run dev
```

启动成功后会看到 `Server listening on http://localhost:3000`，并可访问 `GET /api/v1/system/health`。

### 3. 前端（Web 调试）

Vite + React，默认 **http://localhost:3041**。`/api` 与 `/ws` 已在 `frontend/vite.config.ts` 中代理到后端 `:3000`。

**前置条件**：后端已在 `:3000` 启动。

```bash
# 终端 2
bun run dev:frontend
```

浏览器打开 **http://localhost:3041**，顶部显示 `Backend Connected` 即表示 API 可用。

### 4. 桌面客户端（Tauri v2，可选）

Tauri 仅作为壳，**开发态依旧需要 Web 后端 + 前端 dev server**，`tauri dev` 会自动 `bun run --cwd frontend dev` 并加载 `http://localhost:3041`。

**前置条件**：
- 已安装 Rust（`rustup` 推荐）与平台原生编译工具链
- 步骤 1 完成依赖与迁移
- 已在另一个终端跑 `bun run dev`（或使用打包态 Sidecar，见下）

```bash
# 终端 3（保持 终端 1 的 bun run dev 运行）
bun run dev:tauri
```

**打包成可分发的安装包**（含 Bun 编译的后端 sidecar、SQLite 迁移、`python_connectors/`、`content-packs/`；详见 [docs/PACKAGING.md](docs/PACKAGING.md)）：

```bash
bun run build:app:release
```

产物：`src-tauri/target/release/bundle/`（`.dmg` / `.app` / `.msi` 等）。

打包态客户端首次启动会自动：拉起内置 sidecar（监听 `127.0.0.1:38473`）→ 数据库迁移 → 种子 Agent/MCP/Tool → 按需创建 Python venv。亦可手动 `POST /api/v1/system/bootstrap` 或 `./dist/bundle/bin/qubit bootstrap`。

### 5. Python 连接器（可选）

仅当需要 **行情数据（AKShare）、Python 回测、券商实盘桥（Futu/IB/CCXT）** 时启动；后端会在缺失时优雅降级。

**前置条件**：本机 `python3 >= 3.10`，建议使用 venv 隔离。

```bash
cd python_connectors
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # 基础：numpy / pandas / akshare / pytest

# 实盘 Futu 示例（需额外依赖与 OpenD）
pip install futu-api
python broker_http_server.py             # 默认 http://127.0.0.1:18765
```

启动后在 UI「券商账户配置」中登记 `mock` / `sandbox` / `live` 与 `baseUrl`。打包态下 venv 在数据目录自动创建，无需手工 `pip install`。

### 速查：三种最常见的开发组合

| 场景 | 终端 1 | 终端 2 | 终端 3 |
|------|--------|--------|--------|
| 仅 Web 调试 | `bun run dev` | `bun run dev:frontend` | — |
| 桌面客户端调试 | `bun run dev` | — | `bun run dev:tauri` |
| 完整链路（含实盘桥） | `bun run dev` | `bun run dev:frontend` | `python broker_http_server.py` |

---

## 配置

### 模型（配置中心 / `.qubit/model.json`）

支持 Provider：`openai` · `anthropic` · `ollama` · `deepseek` · `qwen` · `zhipu` · `mock`。

未在前端保存时，将回退环境变量，例如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`DASHSCOPE_API_KEY` 等。

### 数据目录

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QUBIT_DATA_DIR` | `~/.quant-agent` | SQLite、Agent Pack、工作流策略落盘目录 |
| `PORT` / `HOST` | `3000` / `localhost` | 后端监听 |
| `SKILLSMP_API_KEY` | — | SkillsMP 搜索配额（可选） |

工作流策略文件示例路径：

`$QUBIT_DATA_DIR/projects/<projectId>/workflows/<workflowRunId>/report.md`  
`$QUBIT_DATA_DIR/projects/<projectId>/workflows/<workflowRunId>/strategies/...`

---

## 项目结构

```
qubit-agent/
├── src/                 # 后端 API、LangGraph runtime、路由
├── frontend/            # Web UI（Vite + React）
├── src-tauri/           # Tauri 桌面壳
├── python_connectors/   # 行情 / 券商 HTTP 桥
├── docs/
│   ├── ARCHITECTURE.md  # 平台架构说明
│   ├── screenshots/     # README 用图
│   └── LOOP_DRIVERS.md  # Loop 驱动说明
└── drizzle/             # 迁移产物
```

---

## 开发与质量

```bash
bun run lint          # Biome lint
bun run check         # lint + format 检查
bun test              # 集成测试
bun run acceptance:langgraph
```

---

## 常用 API（节选）

<details>
<summary>展开 REST 端点列表</summary>

- `POST /api/v1/workflows` — 创建 workflow
- `GET /api/v1/workflows/:id/stream/:runId` — 步骤流
- `GET /api/v1/agents/definitions` — Agent 定义与草稿
- `GET /api/v1/chat/sessions` · `POST .../messages` — 对话
- `GET /api/v1/monitor/sessions/:id/overview` — 会话监控聚合
- `GET /api/v1/analyst/fusion/:workflowId` — 团队信号融合
- `GET /api/v1/agents/mcp/market/catalog` — MCP 市场（分页）
- `GET /api/v1/agents/skills/market/search` — Skills 市场（分页）
- `POST /api/v1/reia/broker/accounts/upsert` — 券商账户

完整路由见 `src/routes/`。

</details>

### 券商（Futu / IB）

交易链路：`intent_order` → 风控 / 确认 → `executeIntentLive`。需先启动 OpenD 与 Python 桥（启动方式见上文「[Python 连接器](#5-python-连接器可选)」），并在 UI「券商账户配置」中设置 `mock` / `sandbox` / `live` 与 `baseUrl`。详见 [Futu OpenAPI 文档](https://openapi.futunn.com/futu-api-doc/intro/intro.html)。

### 外部 MCP

在 `mcp_server_config` 中配置 **stdio** / **http** / **ws** 传输；工具超时可在 `mcp_tool_binding` 按服务名配置。

---

## 文档

- [平台架构说明](docs/ARCHITECTURE.md)
- [Loop 驱动说明](docs/LOOP_DRIVERS.md)

---

## 参与贡献

欢迎 Issue 与 Pull Request。提交前请尽量通过 `bun run check` 与 `bun test`。

---

## 许可证

[Apache License 2.0](LICENSE)
