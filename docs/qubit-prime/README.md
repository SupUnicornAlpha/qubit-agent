# Qubit Prime — 原仓绞杀式升级

| 项 | 内容 |
|----|------|
| 文档状态 | **规划稿 v0.1 · 待拍板** |
| 日期 | 2026-08-04 |
| 仓库策略 | **不新开仓**；在 `qubit-agent` monorepo 内新增包并绞杀迁移 |
| 交付约束 | 迁移期间 **继续维护 / 交付** 现有 Bun + React 产品 |
| 代号含义 | `qubit-prime` = 架构代号 / feature flag / 发布品牌，不是第二个 Git 仓库 |

---

## 1. 文档地图

| 文档 | 内容 | 状态 |
|------|------|------|
| [01-runtime-core-rust.zh-CN.md](./01-runtime-core-rust.zh-CN.md) | Rust Agent Runtime Core：**§2 边界**、§4 Codex 对照、**§6.6 ExecutionKind**、**§6.8 HITL Inbox**、**§11.4 进程级双核（TS 过渡）**、**§15 Context Protocol** | **v0.8 · M0–M6 ✅ · Bun 接入🚧** |
| [02-ui-cursor-workbench.zh-CN.md](./02-ui-cursor-workbench.zh-CN.md) | UI：双壳 simple/pro、Workspace FS、PageHost、Monaco、Provider | **v0.5 · U0–U7 ✅ · U8 未完** |
| [03-quant-agent-data-decision-upgrade.zh-CN.md](./03-quant-agent-data-decision-upgrade.zh-CN.md) | 量化 Agent、实时数据质量、确定性决策与归因闭环；明确 Core / Tool Host / 外部数据面的归属；券商行情桥可插拔骨架 | v0.2 · 归属已对齐 01 |
| [04-internet-tools-and-plugin-system.zh-CN.md](./04-internet-tools-and-plugin-system.zh-CN.md) | 联网 P0 + 插件双轨 P1 + **OAuth 连接器 P2 已落地** | v0.5 · P2 已落地 |
| [05-framework-storage-memory-health.zh-CN.md](./05-framework-storage-memory-health.zh-CN.md) | 核心框架健康度 · JSON/FS vs SQLite 分层 · 长期记忆与 Workspace 关联 | **v0.3 · O1 SSE + Recipe 单源 + Bridge 扩** |
| （后续）`06-protocol-json-schema/` | Session/Turn/Event 的 JSON Schema / protobuf 草案 | 拍板后落地 |

上游基线（必读）：

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — 当前系统架构
- [`../AGENT_RUNTIME_QUALITY_AND_THIN_LOOP_PLAN.zh-CN.md`](../AGENT_RUNTIME_QUALITY_AND_THIN_LOOP_PLAN.zh-CN.md) — 薄 Loop + DeliveryVerdict
- [`../AGENT_RUNTIME_A2A_COHESION_REFACTOR_PLAN.zh-CN.md`](../AGENT_RUNTIME_A2A_COHESION_REFACTOR_PLAN.zh-CN.md) — Loop / Policy / A2A / Tools 四包边界
- [`../AGENT_RUNTIME_FRAMEWORKS_ARCHITECTURE_AND_CODE.zh-CN.md`](../AGENT_RUNTIME_FRAMEWORKS_ARCHITECTURE_AND_CODE.zh-CN.md) — Codex 等上游对照
- [`../architecture/CURRENT-CODE-ARCHITECTURE-AND-PROTOCOLS.zh-CN.md`](../architecture/CURRENT-CODE-ARCHITECTURE-AND-PROTOCOLS.zh-CN.md)

---

## 2. 已拍板共识（对话冻结）

| # | 决策 | 选择 |
|---|------|------|
| D1 | 新开仓 vs 原仓 | **原仓 monorepo + 新包** |
| D2 | 桌面壳 | **继续 Tauri v2**（薄壳可逐步内嵌 / 旁路 Rust runtime） |
| D3 | 旧产品 | **继续交付**；绞杀，不大爆炸替换 |
| D4 | Runtime 语言方向 | 热路径 / harness **迁 Rust**；行情 / 券商 / Python sandbox **外挂保留** |
| D5 | UI 方向 | **Cursor 级 Workbench**：三栏 + Agent 右栏 + 高密度字体 + Monaco/LSP 路线 |
| **O1** | App Server 传输 | **WebSocket + JSON-RPC 主通道**（旧 REST/SSE 经适配器） |
| **O4** | UI 工程落点 | **在现有 `frontend/` 上改造**（`data-qb-shell="prime"` / 渐进换壳），不新建 `apps/workbench` |
| **O5** | A2A 进 Rust Core | **单会话 Core 稳后再做**（约 M6 之后）；此前团队编排走旧桥 |
| **B1** | A2A / MSA / 拓扑 | **OUT**：不进 harness；旧桥 / 后期独立编排（与 O5 一致） |
| **B2** | 官方 Tool | **L0 元工具 IN**（plan/文件/HITL helper）；**量化官方工具 HOST**（可 Bun 桥） |
| **B3** | Artifact gate / 交付底线 | **求值引擎 IN**；谓词/schema/soft-delivery **DATA（Recipe）** |
| **B4** | 上下文 / 长期记忆 | **WorkingMemory + 组装/compact 骨架 IN**；向量/LTM **OUT（工具或 memory 服）** |
| **B5** | Agent 分类 | Core 只认 **ExecutionKind**：`primary` / `subagent` / `reactor`；**primary 可被其他 Agent 调用**；业务角色外置 |
| **B6** | 双核迁移 | **进程级** `QUBIT_CORE_BACKEND`；TS 仅过渡；Rust 稳后 **删除 TS Core**（保留 protocol-ts 给 UI） |
| **B7** | HITL 出口 | **HitlInbox 审批缓冲**；IDE 与 IM 同消费；primary / reactor 共用（subagent 上交） |
| **U1** | UI 壳模型 | **双壳**：简洁=对话优先；专业=IDE 工作区；共享会话/数据 |
| **U2** | 风格与页面 | **全部保留**：现有 `data-qb-style` + 现有页面；双模式均可达到 |
| **U3** | 专业工作区 | Workspace 树可浏览；SideBar/编辑器可操作 **策略 / 因子 / 持仓** 等 |
| **P1** | 扩展安装模型 | **双轨**：自建 Plugins 管理（`PluginManifest`）**且** Skill/MCP **可直装**；不互斥、共底层表；Codex/Claude 包仅导入适配 |

边界明细见 [`01` §2](./01-runtime-core-rust.zh-CN.md#2-边界什么是-core什么不是)；UI 明细见 [`02`](./02-ui-cursor-workbench.zh-CN.md)；插件双轨见 [`04`](./04-internet-tools-and-plugin-system.zh-CN.md)。

---

## 3. 仍待拍板

> 细节见 01 / 02；拍板后回写本节。

| ID | 问题 | 建议默认 | 影响 |
|----|------|----------|------|
| O2 | Checkpoint 存储：单 SQLite vs SQLite + segment 文件 | 单 SQLite 起步 | HA |
| O3 | Policy 配方：JSON vs YAML vs DSL | JSON（对齐现 policy） | 迁移成本 |
| O6 | HA 部署：desktop-first vs 同时远端 | desktop-first | 进程模型 |
| O7 | Reasoning 崩溃：Failed+retryable vs 自动重采样 | Failed+retryable | 费用/HA |
| O8 | App Server 框架 | axum 轻量 JSON-RPC 或 jsonrpsee | 实现成本 |
| O-U1 | StatusBar：经典蓝底 vs 深灰底 | 深灰底 + 蓝点 | 视觉 |
| O-U2 | 分栏库：自研 vs `react-resizable-panels` | `react-resizable-panels` | 工期 |
| O-U6 | （已废止）旧「Prime 不带皮肤」 | — | 被 **U2 保留全套风格** 取代 |
| O-U3 | 默认密度 | A) Default 13/14  B) Compact 12/13 | **仅作用于 pro chrome** |

讨论方式：**你描述 → 我答 → 改文档 → 回写「已拍板」表 → 再动代码。**

---

## 4. 目标仓库布局（规划）

```text
qubit-agent/
  src/                          # 旧 Bun 后端（继续交付）
  frontend/                     # 旧 UI（继续交付，逐步减负）
  src-tauri/                    # Tauri 壳；后续改连 Rust runtime
  python_connectors/            # 外挂保留
  crates/
    qubit-protocol/             # 共享类型 + JSON schema 生成
    qubit-runtime/              # 薄 harness（loop / tools / HITL / checkpoint）
    qubit-app-server/           # JSON-RPC / WS App Server
    qubit-tool-host/            # 工具执行宿主边界（进程隔离预备）
  frontend/                     # UI 在此绞杀：prime shell + 旧页面并存
    src/shell/prime/            # （规划）Workbench 壳：Activity/Side/Agent/Status
  packages/
    protocol-ts/                # 从 schema 生成的 TS 客户端类型
  docs/qubit-prime/             # 本规划目录
```

---

## 5. 成功定义（产品级）

Prime 算「可用」至少同时满足：

1. **单会话闭环 HA**：进程被杀后，未完成 turn 可从 checkpoint 恢复，不丢 HITL 状态。
2. **薄 Loop**：Rust core 不知量化业务场景；成功 = 可验证副作用 + DeliveryVerdict。
3. **Cursor 风工作台**：Activity Bar + 中栏编辑/预览 + 右栏 Agent；密度与字体接近参考截图。
4. **旧产品不停服**：用户仍可通过现有 Tauri/Web 路径完成研究 / 回测；Prime 能力以 flag 渐进露出。

---

## 6. 修订记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-08-04 | v0.1 | 初稿：README + Runtime Core + UI Workbench 深度规划 |
| 2026-08-04 | v0.2 | 冻结 O1/O4/O5；01 增补 §4 Codex 对照 |
| 2026-08-04 | v0.3 | 冻结 B1–B4 模块边界；01 §2 扩为总表 |
| 2026-08-04 | v0.4 | 冻结 U1–U3：双壳 + 保留风格/页面 + 专业工作区资产 |
| 2026-08-05 | v0.5 | 01→v0.4：ExecutionKind、双核 CoreRuntime、Context Protocol（§15）；README 增 B5/B6 |
| 2026-08-05 | v0.6 | 拍板 O10–O13 → 01 v0.5；README 增 B7（HITL Inbox）；B5/B6 收紧为已拍表述 |
| 2026-08-05 | v0.7 | 新增 04：互联网工具包 P0 + 插件体系规划；原 protocol schema 顺延为 05 |
| 2026-08-05 | v0.8 | **开码**：`crates/` M0 protocol + M1 runtime/app-server 骨架落地（见 `crates/README.md`） |
| 2026-08-05 | v0.8 | 04→v0.2：拍板插件互操作（MCP/Skills 复用，Codex/Claude 包仅导入）；P1 为下一步 |
| 2026-08-05 | v0.9 | 04→v0.3 + README **P1**：自建插件管理与 Skill/MCP 直装双轨并存 |
| 2026-08-05 | v0.10 | 04→v0.4：P1 插件管理落地（registry/API/导入/Plugins UI） |
| 2026-08-05 | v0.11 | 04→v0.5：P2 OAuth 连接器（connector_auth + MCP Bearer 注入） |
| 2026-08-05 | v0.12 | 新增 05：框架健康度 / 存储分层 / 长期记忆与 Workspace；原 protocol schema 顺延为 06 |
| 2026-08-05 | v0.13 | 05→v0.2：CoreDb Session/HITL、BridgeRecall、JSON agents 真源、scope=workspace |
| 2026-08-05 | v0.14 | 05→v0.3：SSE `/events`、protocol-ts、Recipe JSON 单源、Bridge L2、WorkspacePort、fsWorkspaceId |
