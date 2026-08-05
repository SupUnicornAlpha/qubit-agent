# Qubit Prime — 核心框架健康度 · 存储分层 · 长期记忆

| 项 | 内容 |
|----|------|
| 文档状态 | **落地跟踪 v0.3 · Core 保持薄；传输/数据/L2 外置** |
| 日期 | 2026-08-05 |
| 目的 | 盘点 Runtime / 工具 / Harness 健康度；厘清 JSON(FS) vs SQLite 边界；说明长期记忆现状与 Workspace 关联路径 |
| 上游 | [README](./README.md) · [01 Runtime](./01-runtime-core-rust.zh-CN.md) · [02 Workbench](./02-ui-cursor-workbench.zh-CN.md) · [04 Plugins](./04-internet-tools-and-plugin-system.zh-CN.md) |

---

## 目录

1. [总判](#1-总判)
2. [核心框架健康度](#2-核心框架健康度)
3. [存储分层：JSON / FS vs SQLite](#3-存储分层json--fs-vs-sqlite)
4. [长期记忆：现状与 Workspace 关联](#4-长期记忆现状与-workspace-关联)
5. [建议拍板项](#5-建议拍板项)
6. [证据索引](#6-证据索引)

---

## 1. 总判

当前系统处于 **绞杀式双路径中后期**（相对 v0.1 已推进一轮健康度修复）：

| 层 | 一句话 |
|----|--------|
| **TS 产品 Runtime** | 厚、偏 late，仍是生产热路径主体（ReAct / A2A / MCP / Memory V2） |
| **Rust Prime Core** | **偏 late**：Session/HITL 持久 + BridgeRecall/Workspace + SSE 事件；harness 仍薄 |
| **工具面** | Bridge L2 已含 market/memory/screener/thesis/portfolio 等；Tool Host 仍无进程隔离 |
| **Harness / UI 壳** | 进程阀门 mid–late；Pro Workbench 壳 mid-early |
| **存储** | agents/sandbox/recipe：**JSON 真源**；会话/Experience/交易仍 SQLite |
| **长期记忆** | Core 经 Bridge 双召回；`scope=workspace` + workflow `fsWorkspaceId` |

**仍不宜宣称「可删 TS Core」**：A2A/MSA 仍外置、事件无 fromSeq replay、Bridge 未覆盖交易/回测等高危面。

### 1.1 本轮已落地（2026-08-05）

| ID | 项 | 状态 |
|----|----|------|
| C2/S5 | Core 单库 Session + HITL + Checkpoint（`QUBIT_CORE_DB` / `~/.qubit/core/runtime.sqlite`） | ✅ |
| — | app-server `recover_on_boot` + 默认开库 | ✅ |
| Bridge | `memory.recall` / `workspace.memory.search` allowlist 双端同步 | ✅ |
| Recall | `BridgeRecallPort` 注入 ContextAssembler（有 bridge 时） | ✅ |
| S1 | `resolveEffectiveAgentDefinitions`：JSON 真源 + DB overrides；A2APool 改读合成 | ✅ |
| S4/C | Experience 写 `scope=workspace`（有 fsWorkspaceId）；召回 workspace+project 双查 | ✅ |
| — | 协作式 cancel（去掉硬 abort 抢事件） | ✅ |

### 1.2 第二轮落地（同日 · 保持 Core 薄）

| ID | 项 | 状态 | 薄边界 |
|----|----|------|--------|
| O1 | `GET /events` SSE RuntimeEvent；Bun `awaitTurnTerminal` 优先 SSE、回退 poll | ✅ | 传输仅在 app-server |
| — | `packages/protocol-ts` + `bun run gen:protocol` | ✅ | 手同步子集；不进 harness |
| S2 | Recipe JSON 单源：`crates/qubit-policy/recipes/*.json`；TS `load-recipe-json` | ✅ | 数据 OUT |
| Bridge L2 | + screener / thesis / forecast_book / portfolio / recommendation / context.snapshot | ✅ | L2 走 Bun bridge |
| WorkspacePort | `BridgeWorkspacePort` → `workspace.context.snapshot` | ✅ | FS 仍在 Bun |
| — | workflow `loopOptionsJson.fsWorkspaceId` + `QUBIT_ACTIVE_FS_WORKSPACE_ID` | ✅ | 纯 Bun |
---

## 2. 核心框架健康度

### 2.1 架构关系（现状）

```text
Tauri / frontend
       │
       ▼
Bun (src/index.ts) ──spawn──► qubit-app-server (HTTP JSON-RPC :8787)
       │                            │
       │ QUBIT_CORE_BACKEND=rust    │ L0 + TurnEngine + BridgeRecall
       │                            ▼
       │                     Legacy Bridge ──► /api/v1/prime-bridge
       │                            │         market.* + memory.* + MCP
       ▼                            ▼
  TS ReAct / A2A / MSA         crates/qubit-runtime
                                    │
                                    └─ CoreDb SQLite（Session / HITL / Checkpoint）
```

阀门：`QUBIT_CORE_BACKEND=ts|rust|auto`（默认 rust 自启）。编排 / 产品 HITL UI / 多数 L2 工具仍在 Bun。

### 2.2 Runtime Core

| 子系统 | 成熟度 | 健康信号 | 主要风险 |
|--------|--------|----------|----------|
| `qubit-protocol` + schemas | **late-mid** | 跨端类型单源；含 WorkingMemory / ContextEnvelope / ExecutionKind | `packages/protocol-ts` codegen **未落地**；TS 手写类型易漂移 |
| TurnEngine 薄 loop | **late-mid** | stall fingerprint、policy/delivery、HITL 暂停；协作式 cancel | 与产品 ReAct 行为未做完整 conformance 双跑 |
| Session / Store | **late-mid** ↑ | MemoryStore + CoreDb 写穿；boot hydrate | 与 Bun 应用库仍分离 |
| Checkpoint HA | **late-mid** ↑ | 同 CoreDb WAL | turn resume 执行仍弱 |
| HITL Inbox（Rust） | **late-mid** ↑ | `SqliteHitlInbox` 权威 | 产品 IDE HITL 仍走 Bun 投影 |
| Context assemble | **mid** ↑ | BridgeRecall 非空（需 bridge） | WorkspaceContextPort 仍偏空 |
| Model | **mid** | OpenAI-compatible | 无凭证时 FakeModel（已有 sanitize，仍是运维陷阱） |
| App Server | **mid** ↑ | `/rpc` + `/health` + 默认开库 + recover | **无** WS `events.subscribe`（O1 未兑现） |
| TS ReAct / orchestration | **late（产品）** | 大量测试；CapabilityGate / ToolSurface 成熟 | 删除闸门未满足；`TsCoreStub` 非同构 Core |

**相对 01 仍缺（再下一轮）**

1. ~~Session + HITL 持久化闭环~~ ✅
2. ~~事件订阅传输面~~ ✅（SSE `/events`；完整 `fromSeq` replay 仍待）
3. ~~WorkspaceContextPort~~ ✅（Bridge 实现）
4. Bridge L2 继续扩（回测/交易类仍缓）
5. protocol-ts 全量 codegen（现为手同步子集）
6. RuntimeEvent 加 `session_id` 便于过滤
### 2.3 工具能力

| 层 | 成熟度 | 说明 |
|----|--------|------|
| CapabilityGate → resolveEffectiveTools → ToolSurface → sandbox | **late** | 生产授权链清晰 |
| MCP dispatcher + OAuth | **late-mid** | 重试、binding、Bearer 注入已落地（见 04） |
| Plugins 管理面 | **mid** | Registry / 导入 / UI 齐；执行测试偏薄 |
| Market contracts | **mid** | snapshot / thesis / evidence / DQ gate 契约在涨 |
| `prime-tool-host-surface` 规划面 | **mid（规划）** | Orchestrator「应有」工具一大套 |
| Bridge 实际 allowlist | **mid** ↑ | market.* + **memory.recall** + **workspace.memory.search** + MCP | 仍远小于 Orchestrator 规划面 |
| `qubit-tool-host` | **early–mid** | Legacy HTTP 适配器；无进程隔离、无 MCP stdio 宿主 |

**健康结论**：工具 **产品路径健康**；Core 已能经 Bridge 召回记忆；业务工具面仍需继续扩 allowlist。

### 2.4 Harness 外壳

| 组件 | 成熟度 | 说明 |
|------|--------|------|
| Bun 自启 Core + STRICT | **mid–late** | `ensureRustCoreRunning` / `attachPrimeCore` / `prime-up.sh` |
| Tauri 薄壳 | **transitional** | Core 随 Bun 生命周期，未内嵌 runtime |
| Agent control / InteractionMode | **solid（TS）** | `update_plan` 等控制面工具例外清晰 |
| A2A / MSA / topology | **late 产品 / early Core** | 故意 OUT of harness（B1/O5） |
| Core→UI 投影 | **dual-path** | graph / activity / monitor 投影胶水 |
| Pro Workbench UI | **mid-early** | Activity/Agent/Status 雏形；U8 未完 |
| Workspace config（`.qubit/*.json`） | **late-mid** ↑ | **JSON 真源** + DB overrides；与 FS Workspace 是不同概念 |

### 2.5 子系统评分总表

| 子系统 | 阶段 |
|--------|------|
| Rust protocol | late-mid |
| Rust turn harness | **late-mid** ↑ |
| Rust context / recall | **mid** ↑ |
| Rust tool-host | early–mid |
| Bun↔Rust 阀门 | mid–late |
| Session/HITL 持久 | **late-mid** ↑ |
| TS ReAct / tools / MCP | late |
| Policy / Delivery（TS） | late-mid |
| Policy（Rust） | mid（双源） |
| Plugins / OAuth | mid |
| A2A / MSA | late 产品 · early Core |
| Workspace FS / config | **late-mid** ↑ |
| Memory（WM + LTM） | **mid–late** ↑ |
| App Server 事件面 | early–mid |
| 端到端「默认 rust 删 TS」 | mid ↑ |

---

## 3. 存储分层：JSON / FS vs SQLite

### 3.1 三套存储并存

```text
┌─────────────────────────────────────────────────────────────┐
│ A. 应用 SQLite（src/db/sqlite · ~100 表）                      │
│    会话 / 工作流 / 交易 / Experience / 审计 / 密钥 / 安装态     │
├─────────────────────────────────────────────────────────────┤
│ B. 文件系统 / JSON                                            │
│    .qubit/{agents,sandbox,model}.json                         │
│    $DATA/workspaces/<slug>/   ← FS-first 课题空间             │
│    content-packs/ · agent packs · policy recipes · seed JSON  │
├─────────────────────────────────────────────────────────────┤
│ C. 侧车                                                       │
│    LanceDB（Experience / legacy embedding）                   │
│    Rust CoreDb（Session/HITL/Checkpoint，默认 ~/.qubit/core/） │
└─────────────────────────────────────────────────────────────┘
```

**两个「workspace」不要混用**：

| 概念 | 含义 | 位置 |
|------|------|------|
| **DB `workspace`** | 租户边界（默认 `local-user`） | SQLite |
| **FS Workspace** | 课题目录树（策略/因子/memory/entries） | `$QUBIT_DATA_DIR/workspaces/<slug>/` |

### 3.2 可以直接 / 应以 JSON（或 Markdown）承接的内容

原则：**可版本化、可 git、可 seed、变更低频、无并发写冲突、不含机密** → FS/JSON 为真源；DB 至多做投影或安装态。

| 候选 | 现状 | 建议 |
|------|------|------|
| Builtin Agent 定义（prompt/tools/skills 模板） | `.qubit/agents.json` ↔ `agent_definition` 双写 | **JSON 为真源**；DB 投影 + `user_overrides_json` |
| Sandbox 白名单模板 | `.qubit/sandbox.json` ↔ `sandbox_policy` | 同上 |
| Policy Recipe | Rust `crates/qubit-policy/recipes/*.json`；TS `policy/recipes/*.ts` | **统一 JSON 单源**（对齐 O3） |
| Prime AgentSpec seed | `crates/qubit-app-server/seed/prime-agent-specs.json` | 保持 JSON |
| Quant / FSI Skill 正文 | `content-packs/**/*.md` → seed 进 `agent_skill` | **Markdown 为正文真源**；DB 存安装态与 metrics |
| FS Workspace 指令链 | `QUBIT.md`、`.qubit/rules/*.md`、manifest | 已是文件，保持 |
| Research scenario / risk rule **模板**（无运行统计） | 多在 DB | 可迁 JSON 包 + 可选导入 |
| Provider registry **内置清单** | 部分已常量化 | 继续常量化 / JSON catalog |
| 官方插件 pack 清单 | `official-packs.ts` + content-packs | 保持包内声明 |

### 3.3 必须进 SQLite 的内容

原则：**并发、关联查询、事务、TTL/decay、审计时序、resume、密钥、用户可变运行态** → SQLite（未来可拆，但不应纯 JSON）。

| 必须 | 理由 |
|------|------|
| `chat_*` / `workflow_*` / HITL / A2A task | 会话权威、resume、关联 |
| `experience*` + `experience_op_log` + `reflection_run` | 召回过滤、质量分、反馈环 |
| Skill runs / recall logs / PnL 归因 | 进化闭环 |
| Orders / fills / broker / risk / execution | 交易完整性 |
| `*_call_log` / `audit_log` / eval | 时序审计 |
| Secrets：`llm_provider_config.apiKey`、`connector_auth`、channel secrets | 本地机密；未来可 keychain，**不宜进 git JSON** |
| Checkpoint（TS `agent_checkpoint_snapshot` + Rust checkpoints） | HA |
| 用户覆盖与安装态：`user_overrides_json`、enabled、MCP/Skill 安装记录 | 可变运行配置 |
| `mcp_catalog_install` / `skill_market_install` | 安装态 ≠ 包正文 |

### 3.4 灰区（短期双写，不宜「只留一边」）

| 双写对 | 说明 |
|--------|------|
| `agent_definition` ↔ `.qubit/agents.json` | sync 尊重 overrides；删一边会丢用户覆盖 |
| `sandbox_policy` ↔ `.qubit/sandbox.json` | 同上 |
| `agent_skill.body_md` ↔ content-packs | 正文可 FS；召回指标必须 DB |
| `longterm_memory` ↔ pack `memory.md` | 冷镜像已收窄；勿再扩 |
| FS `memory/entries` ↔ Experience | **尚未统一**（见 §4） |

### 3.5 决策简表（给实现用）

```text
静态 / 可 git / seed / 无机密     → JSON 或 Markdown（真源）
用户覆盖 / enabled / 安装记录     → SQLite（或 JSON patch 层，仍建议 DB）
会话 / 工作流 / HITL / A2A        → SQLite
Experience / 向量元数据           → SQLite + LanceDB
交易 / 风控 / 审计                → SQLite
API Key / OAuth token             → SQLite（或 OS keychain），永不进仓 JSON
FS Workspace 课题资产与用户笔记   → 文件系统；DB 可选投影
Rust Core 热路径 checkpoint       → 独立 SQLite（可与 O2 合并评估）
```

---

## 4. 长期记忆：现状与 Workspace 关联

### 4.1 分层模型（今天实际存在的）

| 层 | 实现 | 归属（对齐 B4） | 状态 |
|----|------|-----------------|------|
| **WorkingMemory** | TS `context/working-memory.ts`；协议 `working_memory.schema.json` | Core IN（组装骨架） | 回合内假设/决策/trail；**非**长期持久 |
| **Memory V2 Experience** | `experience` 表 + Writer/Extractor/Reflector/Janitor/Recall | HOST / 工具 OUT of Core | **长期记忆主热路径** |
| **Legacy 三层** | `session_memory` / `midterm_memory` / `longterm_memory` | 过渡 | consolidation 可双写；召回已转向 Experience |
| **FS memory** | `builtin.fs_memory` → `memory/entries/*.json` + `MEMORY.md` | Workspace Provider | 用户可编辑课题记忆；**未进 reason 主召回** |
| **Agent pack memory** | `agents/<id>/memory.md` 等 | Identity 冷镜像 | 与 FS MEMORY.md 职责不同，易混淆 |
| **Rust RecallPort** | `EmptyRecallPort` 默认 | 端口 IN，实现 OUT | Core 路径默认空召回 |

Experience `kind`：`episodic | semantic | procedural | reflective | identity`。  
`scope` 枚举含 **`workspace`**，但 pipes **实际多用 `project` / `workflow` + projectId**，未见稳定绑定 FS workspace id。

### 4.2 写入 / 召回热路径（TS）

```text
Workflow / step
    │
    ├─► Writer        → episodic（workflow 维）
    ├─► Extractor     → semantic / procedural（scope≈project）
    ├─► Reflector     → reflective（agent_private）
    └─► Janitor       → decay / qualityScore

Reason 节点
    └─► experience.recall (+ finance_recall)
            ├─ 关键词 / JSON path
            └─ LanceDB hybrid（按 scopeId≈projectId 过滤）
```

Legacy：`memory-consolidation.ts` 仍可写 midterm；可用开关关停。金融结论禁止灌 system prompt 的护栏仍有效。

### 4.3 与 Workspace 的关联强度

| 机制 | 关联键 | 强度 | 是否进 Agent 召回 |
|------|--------|------|-------------------|
| Experience | `scopeId` → **projectId** / workflowRunId | 强（运行时） | **是** |
| Legacy longterm | org/project/strategy + scopeId | 中（过渡） | 弱 / 转向 V2 |
| `memory_backend_config.workspaceId` | FK → **DB workspace** | 弱（外挂配置） | 视后端 |
| Agent pack `memory.md` | definitionId | 中（identity） | 间接 |
| `builtin.fs_memory` | **FS workspace 目录** | 强（文件/UI） | **否（主路径）** |
| Context `WorkspaceContextPort` | open files / symbols / conventions | 上下文切片 | 非 LTM store |

**结论**：今天 **可关联但未统一**——进化记忆挂 **project**；用户课题记忆挂 **FS 目录**；DB 租户 workspace 是第三套 ID。产品意图（02：长期结论进 `memory/`，transcript 不当记忆）已有 FS 骨架，但与 Experience 召回未打通。

### 4.4 能否与 Workspace 模块关联？——可以，建议三条落点

按侵入性从低到高：

| 方案 | 做法 | 收益 | 成本 |
|------|------|------|------|
| **A. 双召回（推荐先做）** | Reason / RecallPort 同时查 Experience（project）+ `MemoryProvider.search`（FS workspace） | 用户笔记立即进入上下文；不动表结构 | 需把 FS workspace id 传入 turn/context |
| **B. 投影写入** | Extractor 后把高质量 semantic 摘要投影到 `memory/entries`（`source=agent_proposal`） | 课题树可见、可人工编辑 | 去重与冲突策略 |
| **C. scope=workspace 真绑定** | Experience 写入使用 `scope=workspace` + `scopeId=FS manifest.id`；project 作次级标签 | 真正「workspace 级 LTM」 | 迁移、召回过滤、与现 project 维度并存 |

**不建议**：再开第三套长期记忆表；或把 Experience 全文镜像成大量 markdown（V2 已明确 content 进 JSON 字段）。

**与 Core 的边界（保持 B4）**：

- WorkingMemory 组装 / compact：**IN Core**
- Experience 持久化与向量：**OUT**（Bun HOST 或独立 memory 服）
- FS Workspace 读写：**OUT**（Workspace Provider）
- Rust 侧通过 `RecallPort` / `WorkspaceContextPort` **注入切片**，不实现存储

### 4.5 记忆健康度小结

| 项 | 评估 |
|----|------|
| Memory V2 模型清晰度 | **高**（五 kind + visibility） |
| 生产召回可用性 | **mid–late**（project 维） |
| Legacy sunset | **未完**（双写仍在） |
| FS ↔ Experience 统一 | **early**（最大产品缺口） |
| Core 路径记忆 | **early**（Empty ports） |
| 文档真源 | schema 注释引用 `docs/MEMORY_V2_DESIGN.md`，仓库内 **未见该文件**——建议补回或改指向本文件 §4 |

---

## 5. 建议拍板项

| ID | 问题 | 建议默认 | 状态 |
|----|------|----------|------|
| S1 | Agent/Sandbox 真源 | **JSON 真源 + DB 投影**；overrides 仅 DB | ✅ agents 已落地 |
| S2 | Recipe 真源 | **仅 `crates/qubit-policy/recipes/*.json`** | ✅ |
| S3 | 机密存放 | **SQLite / keychain**；禁止进 git | 维持 |
| S4 | LTM ↔ Workspace | 双召回 + `scope=workspace` | ✅ 骨架落地 |
| S5 | Core HA 库 | 单 SQLite Session/HITL/Checkpoint | ✅ |
| S6 | 删 TS Core 前置 | Bridge L2 + Session/HITL + WS + Recall | 部分完成 |

讨论方式与 README 一致：**描述 → 答 → 改文档 → 回写已拍板 → 再动代码**。

---

## 6. 证据索引

| 主题 | 路径 |
|------|------|
| Rust crates 状态 | `crates/README.md` |
| TurnEngine / Store / Checkpoint | `crates/qubit-runtime/src/{engine,store,checkpoint,session}.rs` |
| Context ports | `crates/qubit-runtime/src/context/ports.rs` |
| App Server | `crates/qubit-app-server/src/main.rs` |
| Core 阀门 | `src/runtime/prime/core-runtime.ts`, `src/index.ts` |
| Bridge | `src/routes/prime-bridge.routes.ts`, `crates/qubit-tool-host/` |
| Tool 授权链 | `src/runtime/tools/capability-gate.ts`, `orchestration/resolve-effective-tools.ts`, `policy/tool-surface.ts` |
| Plugins | `src/runtime/plugins/` |
| Schema / Experience | `src/db/sqlite/schema.ts`（~100 `sqliteTable`；Experience @ Memory V2 段） |
| Workspace JSON sync | `src/runtime/config/workspace-config.ts`, `config-sync.ts` |
| FS Workspace | `src/runtime/workspace/**`（`types.ts`, `providers/fs-memory.ts`） |
| WorkingMemory | `src/runtime/context/working-memory.ts` |
| Experience pipes | `src/runtime/experience/**` |
| Legacy memory | `src/runtime/memory/*`, `src/connectors/memory/native/*` |
| Recipes | `crates/qubit-policy/recipes/`, `src/runtime/policy/recipes/` |
| UI Pro shell | `frontend/src/shell/pro/` |

---

## 7. 修订记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-08-05 | v0.1 | 初稿：框架健康度 + 存储分层 + 长期记忆与 Workspace 关联分析 |
| 2026-08-05 | v0.2 | 落地：CoreDb Session/HITL、BridgeRecall、JSON 真源 agents、scope=workspace |
| 2026-08-05 | v0.3 | O1 SSE `/events`、protocol-ts、Recipe JSON 单源、Bridge L2 扩、BridgeWorkspacePort、fsWorkspaceId |
