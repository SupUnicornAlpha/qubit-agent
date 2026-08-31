# QUBIT Agent Platform

[English](README.en.md)

**对话驱动的量化研究 Agent 平台** — Rust Core 负责 Agent 执行，Bun Host 提供 API、SSE、持久化与外部能力，覆盖研究、量化工程、回测和交易治理。

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Tauri](https://img.shields.io/badge/desktop-Tauri%20v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)

---

## 简介

QUBIT 面向量化研究与交易自动化场景，将 **Rust Prime Core**、**对话式 Agent 调度**、**MCP / Connector 工具** 与 **可视化 IDE** 整合在同一工作台中。你可以：

- 通过统一对话入口提出研究问题，由 Orchestrator 按需调用 `agent.invoke` / `call_team_*`
- 在「研究团队」工作台查看 Agent 分析流、工具调用、行情证据、结构化指标和研究产物
- 在量化工坊中查看 Agent 产出的因子 / 策略 / 脚本，编辑指标与 Python 信号并运行回测
- 在行情中心维护本机自选、读取已配置券商的持仓；自选可直接作为 Agent 研究上下文
- 覆盖股票、期权、期货与加密资产的行情研究路径，并通过行情源控制面管理 Wind、Tushare、EastMoney、AKShare、yfinance、Yahoo 与 Binance
- 将已选策略绑定到匹配的标的与 K 线周期，在图表上发起回测并回写信号 / 成交标记
- 用内置 benchmark 对 Agent 的终态、证据、工具治理、研究产物和执行能力持续评分
- 通过配置中心接入 MCP（Anthropic Registry）、Skills（SkillsMP）与券商（Futu / IB）

数据与策略脚本默认落在本地 `~/.quant-agent`（可通过 `QUBIT_DATA_DIR` 修改）。

---

## 截图

### 研究工作台 · 对话 + K 线 + 回测

对话会话、Agent 看板与 K 线、回测坞同屏协作；支持将行情上下文带入对话分析。

![研究工作台：对话、K 线与回测](docs/screenshots/ide-workbench.png)

### 行情中心 · 自选、持仓与盘口

本机自选同时服务于行情查看和 Agent 研究；每个标的可展示当日迷你 K 线与日内涨跌。配置券商后，持仓会在相邻页签从券商桥读取；移除自选会先要求确认。

![行情中心：自选、持仓入口与五档盘口](docs/screenshots/market-watchlist.png)

### 期权链 · Greeks 与策略推演

期权链与行情深度并列展示，支持按到期日、行权价、Call / Put 与方向构建策略，并展示报价、IV、OI、Greeks、盈亏平衡与到期情景。

![AAPL 期权链：策略工具、Greeks 与到期情景](docs/screenshots/market-options-chain.png)

### 研究团队 · Agent 研究工作台

研究通过对话启动；工作台实时展示分析流、研究阶段、行情证据、工具指标、Agent 调用链和因子 / 策略 / 回测产物。拓扑图作为执行图查看，而不是研究首屏。

![研究团队：成员目录、拓扑画布与策略代码](docs/screenshots/research-team.png)

### 资讯 · 个股与板块新闻

个股 K 线叠加 Yahoo / 内置新闻源；支持「带入对话分析」与板块 ETF 资讯。

![资讯页：行情与新闻简报](docs/screenshots/news-brief.png)

---

## 功能特性

| 模块 | 说明 |
|------|------|
| **Agent Core** | Rust Prime Core 负责 turn loop、工具准入、HITL、计划、Goal 门禁、`agent.invoke` 和交付；Bun 只保留 Host / 外部能力 |
| **工作模式** | Agent：通用自主执行；Plan：只生成可验证计划；Goal：自主规划、执行、验证并经完成门禁闭环；Ask / Diagnose：问答与诊断 |
| **研究工作流** | 统一通过对话 turn 启动；Orchestrator 按需调用 Agent / subagent，研究阶段和 Plan 状态由后端下发 |
| **行情治理** | 按市场 / 周期 / 凭证 / 健康度 / 优先级路由；成功率、P95、最近错误、熔断与 fallback 可观测 |
| **自选与持仓** | 本机自选由 `market.ide_subscription.get` 统一读取；每行支持日内迷你 K 线、涨跌与删除确认。配置券商后可从券商桥读取持仓 |
| **多资产行情** | 股票 / ETF、OPRA 美股期权链、期货连续合约与 Binance 现货在同一行情工作台呈现；具体可用市场取决于已配置的数据源 |
| **期权链与策略推演** | Call / Put 链、报价、IV、OI、Greeks、策略组合、盈亏平衡与到期情景；研究级行情明确标识，不能直接用于交易决策 |
| **量化工坊** | Agent 产出的因子 / 策略 / 脚本与 workflow 关联；支持编辑、评估、回测及产物跳转 |
| **图表内回测** | 回测前校验策略的标的 / 标的池与 K 线周期维度；匹配后在当前图表运行，信号与成交标记回写 K 线 |
| **新闻证据** | 当前分析默认 7 天 freshness window；过滤无日期、过期、无关及 synthetic / stub 内容 |
| **对话工作台** | Session 管理、消息关联 workflow、Agent 看板与执行时间线 |
| **运行监控** | Session / Workflow / Step / Tool / MCP / Sandbox 多层观测与失败归因 |
| **配置中心** | Workspace diff、模型配置、Agent 草稿发布、MCP & Skills 市场 |
| **Agent Benchmark** | 10 个研究 / 选股 / 因子 / 策略 / 交易场景，AQM 多维评分、trace 与版本对比 |
| **实盘与券商** | Intent → 风控 → 执行；Futu / IB（mock / sandbox / live） |
| **桌面端** | Tauri v2 客户端，生产 Sidecar、迁移 / seed、DuckDB 原生依赖与后端 readiness 状态 |

Agent 工作模式与执行类型（primary / subagent / reactor）正交。Plan 的“只规划”由 Rust Core
工具权限强制执行；Goal 把目标文本
作为完成条件，持久化结果、约束、验证标准和证据，并支持暂停、恢复、编辑与清除。计划仍有
`pending / in_progress` 步骤、全部步骤被跳过或缺少实际执行证据时不会提前结束。旧工作流中的
`experience: native / coding_agent` 会分别兼容映射为 Agent / Goal，新接口统一使用
`loopOptionsJson.agentMode`。研究阶段字段是研究工作流的可选扩展；普通 Agent 不需要维护研究阶段。

### 自选、持仓与研究数据边界

- **自选**由 IDE 本机维护，Agent 通过 `market.ide_subscription.get` 获取真实条目；接口为空或不可用时，Agent 不会用历史对话中的标的冒充自选清单。
- **持仓**默认从已配置券商桥读取；未配置账户或桥不可用时，界面会显示空态而不会伪造仓位。
- **行情与期权链**会携带数据源与可用性信息。研究级 / 降级数据仅供研究、回测与策略推演，不能作为交易决策依据。
- **图表回测**只可在策略覆盖的标的（或明确指定的标的池成员）与匹配的 K 线周期上执行；篮子策略必须明确回测标的后才可运行。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 Host | Bun · TypeScript · Hono · Drizzle · SQLite · DuckDB |
| Agent Core | Rust Prime Core · turn loop · tool gate · HITL · Agent invoke |
| 编排与外部能力 | 对话 turn · A2A 审计总线 · MCP · Connector · OpenAI-compatible Provider |
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

### 2. 后端（必启，默认自动启动 Rust Core）

启动 Bun Host + Hono HTTP/WS 服务，默认 **http://localhost:3000**。Bun 默认会自动构建并拉起
`qubit-app-server` Rust Core，默认 Core 地址为 **http://127.0.0.1:8787**；Rust Core 不健康时
不会静默回退到旧的 TypeScript Agent Runtime。

**前置条件**：完成步骤 1；如需调用真实模型，至少在配置中心或 `.qubit/model.json`
配置一个 Provider（见下文「[配置](#配置)」）。

```bash
# 终端 1
bun run dev
```

可通过环境变量覆盖监听地址：

```bash
PORT=3000 HOST=localhost bun run dev
```

启动成功后会看到 Bun Host 和 Rust Core 的启动日志，并可访问：

```bash
curl http://localhost:3000/api/v1/system/health
curl http://127.0.0.1:8787/health
```

桌面联调或需要监听 TypeScript 改动时，使用带 watch 的后端脚本。它复用 Tauri 数据目录，
默认监听 `127.0.0.1:17385`，修改 `src/**` 后会自动重启：

```bash
bun run dev:backend
```

### 3. 前端（Web 调试）

Vite + React，默认 **http://localhost:3041**。`/api` 与 `/ws` 已在 `frontend/vite.config.ts` 中代理到后端 `:3000`。

**前置条件**：后端已通过 `bun run dev` 在 `:3000` 启动。Vite 的 `/api` 与 `/ws`
代理默认指向该端口；`dev:backend` 的 `:17385` 主要用于桌面客户端联调。

```bash
# 终端 2
bun run dev:frontend
```

浏览器打开 **http://localhost:3041**，顶部显示 `Backend Connected` 即表示 API 可用。

### 4. 桌面客户端（Tauri v2，可选）

Tauri 作为桌面壳，`tauri dev` 会自动启动前端 dev server 并加载 `http://localhost:3041`；
开发态由 Tauri 侧启动 Bun Host，Bun 再管理 Rust Core，不需要另外启动 `bun run dev`。
启动前会自动创建一个被 git 忽略的 sidecar 占位文件，满足 Tauri 对 `externalBin` 的开发态校验。

**前置条件**：
- 已安装 Rust（`rustup` 推荐）与平台原生编译工具链
- 步骤 1 完成依赖与迁移
- 开发态不需要预编译 sidecar；生产打包使用 `bun run build:app:release`

```bash
# 终端 1
bun run dev:tauri
```

**打包成可分发的安装包**（含 Bun 编译的后端 sidecar、SQLite 迁移、`python_connectors/`、`content-packs/`）：

```bash
bun run build:app:release
```

产物：`src-tauri/target/release/bundle/`（`.dmg` / `.app` / `.msi` 等）。

打包态客户端首次启动会自动：拉起内置 sidecar（监听 `127.0.0.1:38473`）→ 数据库迁移 → 种子 Agent/MCP/Tool → 按需创建 Python venv。亦可手动 `POST /api/v1/system/bootstrap` 或 `./dist/bundle/bin/qubit bootstrap`。

### 5. Python 连接器（可选）

仅当需要 **AKShare / 腾讯 A 股、yfinance Yahoo（含分红与基本面）、Python 回测、
券商实盘桥（Futu/IB/CCXT）** 时启用；后端在 Python 环境或单个上游不可用时会按
市场能力和健康状态降级，并明确返回 unavailable，而不是生成模拟行情。

**前置条件**：本机 `python3 >= 3.10`，建议使用 venv 隔离。

```bash
cd python_connectors
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # 基础：numpy / pandas / akshare / yfinance / pytest

# 实盘 Futu 示例（需额外依赖与 OpenD）
pip install futu-api
python broker_http_server.py             # 默认 http://127.0.0.1:18765
```

启动后在 UI「券商账户配置」中登记 `mock` / `sandbox` / `live` 与 `baseUrl`。打包态下 venv 在数据目录自动创建，无需手工 `pip install`。

### 速查：三种最常见的开发组合

| 场景 | 终端 1 | 终端 2 | 终端 3 |
|------|--------|--------|--------|
| 仅 Web 调试 | `bun run dev` | `bun run dev:frontend` | — |
| 桌面客户端调试 | — | — | `bun run dev:tauri` |
| 完整链路（含实盘桥） | `bun run dev` | `bun run dev:frontend` | `python broker_http_server.py` |

### 修改后端代码后什么会发生？

| 方式 | ts 改动如何生效 | 适用 |
|------|-----------------|------|
| `bun run dev` | **不会自动重载**，改完要手动 Ctrl-C 重启 | 不推荐 |
| `bun run dev:backend` | **自动**，bun --watch 监听 `src/**`，1~2s graceful restart | 推荐（独立终端运行后端） |
| `bun run dev:tauri` | **自动**，Tauri sidecar 已切到 `bun --watch`（含数据目录与 Tauri 完全一致） | 推荐（桌面壳） |

**怎么确认后端跑的是不是最新代码？**

```bash
curl -s http://localhost:17385/api/v1/_meta/build-info | jq
# 返回 pid / startedAt / commit / indexMtime / watchMode 等
```

- `dev-backend.log` 头部每次重启都会打 banner 横线 + `pid / commit / watchMode`，`tail -f` 一眼可数；
- 如果你需要**关闭** watch（例如长时间跑回测不想被改文件打断），加 `QUBIT_DEV_NO_WATCH=1`：
  ```bash
  QUBIT_DEV_NO_WATCH=1 bash scripts/dev-backend.sh    # 独立后端
  QUBIT_DEV_NO_WATCH=1 bun run dev:tauri              # Tauri 壳
  ```
- 极端情况下端口被旧进程占住（macOS Tauri 关窗口不一定 kill sidecar）：
  ```bash
  kill $(lsof -ti :17385)
  ```

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
| `QUBIT_CORE_BACKEND` | `rust` | Rust Core 后端；`ts` 仅用于紧急兼容，不建议使用 |
| `QUBIT_RUST_CORE_URL` | `http://127.0.0.1:8787` | Rust Core 地址 |
| `QUBIT_SKIP_CORE_SPAWN=1` | — | 不由 Bun 自动拉起 Core，适用于手动运行 `qubit-app-server` |
| `QUBIT_CORE_STRICT=1` | — | Core 不健康时拒绝静默降级 |
| `SKILLSMP_API_KEY` | — | SkillsMP 搜索配额（可选） |
| `TOPOLOGY_TASK_TIMEOUT_MS` | `120000` | Orchestrator 等待单个专家 A2A 结果的上限（10s–300s） |

工作流策略文件示例路径：

`$QUBIT_DATA_DIR/projects/<projectId>/workflows/<workflowRunId>/report.md`  
`$QUBIT_DATA_DIR/projects/<projectId>/workflows/<workflowRunId>/strategies/...`

---

## 行情数据源与证据治理

QUBIT 会在启动时注册并探测以下真实数据源：

| 数据源 | 主要市场 | 角色 |
|--------|----------|------|
| Wind | A 股 / 港股 | 高优先级终端数据 |
| Tushare Pro | A 股日线 | Token 数据源 |
| EastMoney | A 股 | 公共 fallback |
| AKShare / 腾讯证券 | A 股 / 港股 | Python 与独立上游 fallback |
| yfinance / Yahoo Chart | 美股、港股、A 股及多个海外市场 | 全球市场 fallback |
| Binance | Crypto | 分钟到日线 |

配置中心的行情源面板会展示支持市场和周期、凭证状态、最近健康检查、成功率、
P95 延迟、最近错误、熔断状态、优先级、fallback 能力及网络路由。行情页和 Agent
工具使用同一份健康状态，自适应跳过不可用数据源。

启动 readiness gate 会对目标市场请求真实样本。只有至少一个目标市场数据源返回
有效数据，后端才会报告相应市场 ready；所有源失败时，工具返回包含尝试源和失败分类的
`market_data_unavailable`，不会把空结果或 synthetic 数据当作成功。

常用检查：

```bash
curl -s http://localhost:3000/api/v1/market/data-sources | jq
curl -s -X POST http://localhost:3000/api/v1/market/data-sources/health | jq
curl -s http://localhost:3000/api/v1/market/readiness | jq
```

新闻也经过证据门：当前行情分析默认只接收最近 7 天、带有效发布时间、与标的相关且
非 synthetic / stub 的内容。历史新闻必须显式使用 `historical_validation` 模式，
不能作为近期催化使用。

---

## 项目结构

```
qubit-agent/
├── crates/
│   ├── qubit-protocol/  # Rust Core 与 Host 共用的协议、事件、计划和 RPC 类型
│   ├── qubit-runtime/   # Agent turn loop、工具准入、HITL、计划和 Agent invoke
│   ├── qubit-tool-host/ # Rust Core 的工具宿主与外部能力桥
│   └── qubit-app-server/ # Rust Core HTTP / SSE 服务
├── src/                 # Bun Host：API、SSE、持久化、MCP、Connector、交易与适配器
│   ├── routes/          # Hono REST 路由
│   └── runtime/         # 按 agent / quant / trading / host / evaluation /
│                        # compatibility 路由的索引与 Host 业务模块
├── frontend/            # Web UI（Vite + React）
├── src-tauri/           # Tauri v2 桌面壳
├── python_connectors/   # 可选行情 / 券商 HTTP 桥
├── scripts/             # 开发、构建、迁移、测试与 benchmark 脚本
├── docs/                # 架构、运行时与研究完整性文档
└── drizzle/             # Drizzle 迁移产物
```

`src/runtime/` 的一级业务域通过 `index.ts` 统一路由：

| 域 | 责任 |
|---|---|
| `agent` | 对话、Agent 调度、A2A、Harness、Plan、Workflow、工具和技能 |
| `quant` | 因子、策略、筛选、回测、发现与量化评估 |
| `trading` | REIA、风险、订单执行、模拟盘、交易归因 |
| `host` | SSE、MCP、行情、外部调用、工作区和平台适配 |
| `evaluation` | benchmark、readiness、monitor、审计和 lineage |
| `compatibility` | 旧数据、旧 Loop 和历史路径的兼容出口 |

研究调用统一使用对话接口，不再通过独立的“启动研究”接口：

```text
POST /api/v1/chat/sessions/:sessionId/turns
  → Bun Host 持久化会话与工作流
  → Rust Core 执行 turn / tool / agent.invoke
  → Bun 投影 SSE、Plan、指标、证据和产物
```

---

## 开发与质量

```bash
bun run lint          # Biome lint
bun run check         # lint + format 检查
bun test              # 集成测试
bun run build         # 编译生产后端（含项目约定的 DuckDB external 处理）
```

> **执行链路**：Agent turn loop、工具准入、HITL、计划和 Agent delegation 在
> `crates/qubit-runtime/` 的 Rust Core 中执行；Bun `src/runtime/prime/` 负责启动、桥接和
> 将 Core 活动投影为 workflow / SSE。Bun Host 保留 API、持久化、MCP、Connector、行情、
> 交易和 UI 适配能力。

### Agent Benchmark

每次大幅修改 Agent、工具治理或研究产物链路后，建议运行 readiness benchmark。当前
覆盖 10 个任务：单标的研究、多标的对比、主题研究、long / short 选股、因子生成、
long-only / long-short 策略、做多 / 做空执行。

```bash
# 先启动桌面联调后端（默认 :17385）
bun run dev:backend

# 全量 10 场景；无额外 LLM judge 时可先跑确定性评分
bun run scripts/run-readiness-evaluation.ts --no-judge

# 只跑部分场景
QUBIT_READINESS_SCENARIOS=research,factor,strategy \
  bun run scripts/run-readiness-evaluation.ts --no-judge

# 对已有 workflow 重新评分或导出 trace
bun run scripts/agent-readiness-runner.ts \
  --scenario=research --workflow=<workflowRunId> --output-dir=./out/agent-readiness
bun run scripts/agent-readiness-runner.ts \
  --trace=<workflowRunId> --output-dir=./out/agent-readiness
```

输出位于 `out/agent-readiness/`，包含每个 workflow 的指标快照、Markdown 报告、
完整 trace、汇总健康报告和跨版本 diff。评分同时检查终态回复、有效数据、工具治理、
研究质量、结构化产物与执行效率，避免只用“是否跑完”判断 Agent 能力。

---

## 常用 API（节选）

<details>
<summary>展开 REST 端点列表</summary>

- `GET /api/v1/system/health` — Bun Host 健康检查
- `GET /api/v1/workflows/:id/events` — 工作流 SSE 步骤流
- `GET /api/v1/workflows/:id/stream/:runId` — 指定运行的步骤流
- `GET /api/v1/agents/definitions` — Agent 定义与草稿
- `GET /api/v1/chat/sessions` · `POST /api/v1/chat/sessions/:sessionId/turns` — 唯一对话执行入口
- `GET /api/v1/monitor/sessions/:id/overview` — 会话监控聚合
- `GET /api/v1/research-artifacts/workflow/:workflowId/team-graph` — 研究执行图、Plan 与历史活动
- `GET /api/v1/market/data-sources` — 行情源能力、健康、延迟、熔断与优先级
- `POST /api/v1/market/data-sources/health` — 执行真实样本健康检查
- `GET /api/v1/market/readiness` — 启动行情 readiness gate 状态
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
- [Agent Benchmark v2](docs/AGENT_BENCHMARK_V2.md)
- [Quant Research Integrity 项目规格](docs/QUANT_RESEARCH_INTEGRITY_PLAN.md)

---

## 参与贡献

欢迎 Issue 与 Pull Request。提交前请尽量通过 `bun run check` 与 `bun test`。

---

## 许可证

[Apache License 2.0](LICENSE)
