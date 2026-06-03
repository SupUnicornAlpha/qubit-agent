# Self-Evolving Agent + Data Flywheel 技术方案

| 文档状态 | 草稿（持续迭代，每期落地后更新） |
|---|---|
| 版本 | v0.1（P4a 落地） |
| 作者 | Cursor Agent + maintainer |
| 更新日期 | 2026-06-03 |
| 关联文档 | [MEMORY_V2_DESIGN.md](./MEMORY_V2_DESIGN.md) / [MONITORING_V2_DESIGN.md](./MONITORING_V2_DESIGN.md) |

---

## 一、背景

### 1.1 目标定义

把 Qubit Agent 从"听话的 ReAct 执行者"升级为"用得越多越聪明、缺什么自己补"的自进化系统。具体三大能力：

| 能力 | 含义 | 飞轮角色 |
|---|---|---|
| **A. 闭环数据采集** | 从「选股 → 因子 → 策略 → 下单 → 实盘成交 → PnL」全链路打通 lineage | 飞轮的"燃料" |
| **B. Skill 自进化** | 每次任务沉淀为可复用 skill，自动演化 / 淘汰 / 晋升 | 飞轮的"本体" |
| **C. 工具自配置** | Agent 发现工具缺口 → 自主装配 MCP / 升级 builtin tool | 飞轮的"自愈" |

### 1.2 现状评估（2026-06-03）

记号：✅ 已具备 / 🟡 骨架在但断点 / ❌ 不存在。

| 模块 | 现状 | 关键证据 |
|---|---|---|
| Memory V2（5 pipes + hybrid recall） | ✅ | P0-P3 全量落地（[MEMORY_V2_DESIGN.md](./MEMORY_V2_DESIGN.md)） |
| Skill schema + 谱系（4 表） | ✅ | `agent_skill / _run / curator_run / evolution_run`（`schema.ts:2343`） |
| Skill 维护（Curator + Evolver） | ✅ | `skill-curator.ts` + `skill-evolve.ts` |
| Skill 召回 + 注入 prompt | ✅ | `reason.ts:225-267` + `skill_recall_log` |
| Factor / Strategy / Backtest 分层 | ✅ | `factor_definition` → `strategy_version` → `strategy_composition` → `strategy_runtime` |
| 工具调用观测（tool/mcp/acp log） | ✅ | 3 张 log 表 + `workflow_quality_snapshot` 聚合 |
| **🟡 Procedural Experience → Skill 晋升** | 🟡 | Extractor 写 `experience(kind=procedural)`，但**无 Promoter** |
| **🟡 Reflective Experience → Skill 修订** | 🟡 | Reflector 写 reflective，但**不会自动调 SkillEvolver** |
| **❌ PnL 反馈回灌** | ❌ | `fill / execution_report` 只到撮合；无 PnL 时序；`analyst_accuracy_log` 0 writer |
| **❌ Skill / Strategy 真实收益指标** | ❌ | `agent_skill.successCount` 只代表"调用成功"≠"赚钱" |
| **❌ Agent 自主装配工具** | ❌ | 仓库 0 处 `autoInstall`；MCP / Skill Market 全是 UI 手动装 |
| **❌ Tool 失败 → 自动修复 / 替代** | ❌ | reason 解析失败仅重试 1 次，无替代工具推荐 |

### 1.3 飞轮三处断点

```
 ┌─────────────┐   ✅采集    ┌─────────────┐   ❌断点1: PnL 不聚合    ┌─────────────┐
 │  选股决策     │ ─────────→ │ 实盘成交/回测 │ ─────────────────────→ │  收益归因     │
 └─────────────┘             └─────────────┘                          └─────────────┘
        ▲                                                                     │
        │                                                                     ▼
 ┌─────────────┐  🟡断点2: 经验→skill 不晋升  ┌─────────────┐  ❌断点3: agent 不会自配工具
 │ Reason + Skill │ ←────────────────────── │  Memory V2   │ ←──────────────────────┐
 │   召回注入     │                          │  experience  │                          │
 └─────────────┘                            └─────────────┘                          │
        │                                                                              │
        ▼                                                                              │
 ┌─────────────┐                                                                       │
 │ Tool / MCP  │ ──────────────────────────────────────────────────────────────────────┘
 │   调用       │
 └─────────────┘
```

---

## 二、名词解释

| 名词 | 释义 |
|---|---|
| **飞轮 (Flywheel)** | 数据 → 经验 → skill → 决策 → 更多数据 的正向循环 |
| **PnL Attribution** | 把实盘/回测的 PnL 按"哪个 decision / 哪个 skill / 哪个 strategy" 拆分归因 |
| **Skill Promotion** | 把高价值 `experience(kind=procedural)` 晋升为 `agent_skill(state=pending_review)` |
| **Tool Gap** | Agent 在 reason 阶段发现缺工具的事件（unknown_tool / repeated_fail / explicit_report） |
| **Self-Provisioning** | Agent 自主装配工具：propose → 审批 → install → 回归 → enable |

---

## 三、产研协作信息

| 项 | 内容 |
|---|---|
| 文档状态 | 草稿 |
| 相关文档 | MEMORY_V2_DESIGN.md / MONITORING_V2_DESIGN.md |
| 服务端 owner | TBD |
| 前端 owner | TBD |
| 外部依赖 | OpenAI embedding（已接入）；market data connector（已接入） |

---

## 四、需求分析

### 4.1 功能影响范围

| 类型 | 影响项 | 期 | 变更说明 |
|---|---|---|---|
| 数据库 | 新增 `daily_mark_price` / `strategy_pnl_snapshot` / `fee_schedule` | P4a ✅ | EOD 物化 + 时序 PnL + 内置费率 |
| 数据库 | 新增 `agent_pnl_attribution` | P4b | 一次决策的 PnL 归因到 skill |
| 数据库 | 改字段 `agent_skill` + `pnlAttributionJson`、`agent_skill_run` + `pnlDelta` | P4b | skill 真实收益指标 |
| 数据库 | 补 writer `analyst_accuracy_log` | P4a ✅ | 现有表 0 writer 修复 |
| 数据库 | 新增 `skill_promotion_run` | P5 | 经验→skill 晋升留痕 |
| 数据库 | 新增 `tool_gap_log` / `auto_install_proposal` | P7-P8 | 工具缺口与自装配审批 |
| 服务 | 新增 worker：`PnlAttributor` / `SkillPromoter` / `ToolGapWatcher` / `AutoInstaller` | P4b-P8 | 4 个新 worker 接入 `ExperienceMaintenanceWorker` 或独立 cron |
| 服务 | 新增 builtin tool：`skill.propose_promotion` / `tool.report_gap` / `tool.propose_install` | P5/P7/P8 | agent 主动上报通道 |
| 前端 | `MemoryTab` 加 sub-panel：Skill Promotions / Tool Gaps / PnL Attribution | P5/P7/P8 | 复用 P3 结构 |
| 观测 | metrics `self_evolve.*` 三组 | P4b/P5/P7 | 接 `experience/metrics.ts` |
| 开关 | `SELF_EVOLVE_ENABLED` / `AUTO_INSTALL_MODE`（off/propose/auto） | P4b/P8 | 灰度 + 安全护栏 |

### 4.2 问题拆解

```
大问题：让 agent 用得越多越聪明 + 缺什么自己补

├─ 子问题 1：怎么判断 workflow 真的有价值，值得固化为 skill？
│  ├─ 信号 1：procedural experience 被召回 ≥ N 次且 ≥ M 次促成成功
│  ├─ 信号 2：PnL 归因 > 0（需要先解决子问题 4）
│  └─ 信号 3：reflective experience 标 "this play works"
│
├─ 子问题 2：晋升的 skill 怎么保证不污染 Skill 库？
│  ├─ 强制 pending_review → Curator 评审 → active
│  ├─ A/B 影子上线：先 sandbox agent 跑 N 次
│  └─ 失败回滚：用 evolution_run baseline 对比
│
├─ 子问题 3：失败 skill 怎么自动修订？
│  ├─ 触发：skill_recall_log.executed=true + agent_skill_run.outcome=fail 累计 ≥ 阈值
│  ├─ 复用 SkillEvolver，但 prompt 改"基于失败 reflection 修订"
│  └─ parent_skill_id 链路
│
├─ 子问题 4：PnL 怎么归因到 skill / strategy / agent？
│  ├─ 数据源：fill + execution_report + strategy_position_snapshot + daily_mark_price (P4a 新建)
│  ├─ 归因维度：strategy → workflow_run → skill（被该 run 召回的）
│  ├─ 时序：T+1 日度快照 + 实时 1h/4h
│  └─ 算法 v0：等权（一次决策被 K 个 skill 召回，每个分 PnL/K）；v1：Shapley
│
├─ 子问题 5：怎么发现 tool gap？
│  ├─ 显式：tool_call_log.error 含 "unknown tool" / parse_retry 失败
│  ├─ 隐式：reflective experience 提"need tool X"
│  └─ 主动：agent 调 tool.report_gap 上报
│
└─ 子问题 6：怎么安全地让 agent 装工具？
   ├─ 3 档安全级别（off / propose / auto）
   ├─ propose 模式：写 auto_install_proposal 等用户审批
   ├─ auto 模式：仅 skill_market 已审 + MCP allowlist
   └─ 装完跑 SkillEvolver baseline 回归，通过才 enable
```

### 4.3 数据库表结构变更（增量汇总）

| 表 | 类型 | 期 | 关键字段 |
|---|---|---|---|
| `daily_mark_price` | 新增 | P4a ✅ | `market / symbol / trading_day / close / source` + uniq(m,s,d) |
| `strategy_pnl_snapshot` | 新增 | P4a ✅ | `(runtime, day, symbol)` 时序 + realized/unrealized/cum/fee/turnover + market_value |
| `fee_schedule` | 新增 | P4a ✅ | `(broker, market, asset_class, side)` 多维匹配 + priority + 8 行 seed |
| `agent_pnl_attribution` | 新增 | P4b | `workflow_run_id / definition_id / skill_ids_json / strategy_runtime_id / pnl_attributed / attribution_method / as_of_date` |
| `agent_skill` | 改字段 | P4b | + `pnlAttributionJson` / `lastPromotedAt` / `evolutionMode` |
| `agent_skill_run` | 改字段 | P4b | + `pnlDelta` / `attributionConfidence` |
| `skill_promotion_run` | 新增 | P5 | `id / candidate_experience_id / signals_json / decision / decided_by / result_skill_id` |
| `tool_gap_log` | 新增 | P7 | `workflow_run_id / agent_role / gap_kind / signature / suggested_tool / status` |
| `auto_install_proposal` | 新增 | P8 | `gap_log_id / proposal_kind / payload_json / safety_level / approval_state` |

---

## 五、总体设计

### 5.1 飞轮架构

```mermaid
flowchart TB
    subgraph Capture["采集层"]
      A1[Reason Node<br/>memory+skill+tool 注入]
      A2[Act Node<br/>tool_call_log]
      A3[Execution Worker<br/>fill / execution_report]
      A4[Backtest Run]
    end

    subgraph ExpV2["经验层 Experience V2 (已落地 P0-P3)"]
      B1[(experience)]
      B2[(experience_link)]
      B3[Writer/Extractor/<br/>Reflector/Janitor/Embedder]
    end

    subgraph Attribution["归因层 (P4a/b 新增)"]
      C0[DailyMarkPriceFetcher<br/>cron EOD]
      C1[PnlAttributor<br/>cron 日度+实时]
      C00[(daily_mark_price)]
      C2[(strategy_pnl_snapshot)]
      C3[(agent_pnl_attribution)]
      C4[(analyst_accuracy_log)]
      C5[FeeCalculator<br/>fee_schedule]
      C6[AnalystAccuracyWriter<br/>两阶段]
    end

    subgraph Evolution["进化层 (P5-P6 新增/补全)"]
      D1[SkillPromoter]
      D2[(skill_promotion_run)]
      D3[SkillEvolver<br/>已有,自动触发]
      D4[(agent_skill)]
      D5[SkillCurator<br/>已有,增强]
    end

    subgraph SelfProvision["自装配层 (P7-P9 新增)"]
      E1[ToolGapWatcher]
      E2[(tool_gap_log)]
      E3[AutoInstaller<br/>含审批]
      E4[(auto_install_proposal)]
    end

    subgraph Recall["Recall 回路 (已有)"]
      F1[ExperienceRecall<br/>hybrid]
      F2[SkillSearch]
      F3[ToolPolicy]
    end

    A1 --> B3
    A2 --> B3
    A3 --> C1
    A4 --> C1
    B3 --> B1
    B3 --> B2

    C0 --> C00
    C00 --> C1
    C5 --> C1
    C1 --> C2
    C1 --> C3
    C1 --> C6
    C6 --> C4

    B1 --> D1
    C3 -.PnL signal.-> D1
    D1 --> D2
    D1 -->|pending_review| D4
    D4 --> D3
    D3 --> D4
    D4 --> D5
    D5 --> D4

    A2 -->|fail signal| E1
    B1 -->|tool gap| E1
    E1 --> E2
    E2 --> E3
    E3 --> E4
    E4 -->|approved| F3

    D4 --> F2
    B1 --> F1
    C3 -.top-3 PnL.-> A1
    F1 --> A1
    F2 --> A1
    F3 --> A1

    style C0 fill:#ffe7c2
    style C1 fill:#ffe7c2
    style C5 fill:#ffe7c2
    style C6 fill:#ffe7c2
    style D1 fill:#ffe7c2
    style E1 fill:#ffe7c2
    style E3 fill:#ffe7c2
```

橙色 = 本规划新增的 6 个 worker / 服务。

### 5.2 关键 trade-off 与选型

#### Trade-off 1：Skill Promoter 触发器

| 方案 | 优点 | 缺点 | 选 |
|---|---|---|---|
| **A. 规则触发**（recall ≥ N ∧ success_rate ≥ X ∧ pnl > 0） | 可解释 / 可灰度 / 零成本 | 阈值难调 | ✅ v0 |
| B. LLM 评审（每周扫 procedural 让 LLM 评） | 召回全 | 成本高 / 重复 Curator | v1 |
| C. RL reward | 理论最优 | 周期长 / 冷启动难 | 远期 |

#### Trade-off 2：PnL 归因算法

| 方案 | 优点 | 缺点 | 选 |
|---|---|---|---|
| **A. 等权**（K 个 skill 各分 PnL/K） | 极简 / 立即可用 | 不区分重要性 | ✅ v0 |
| B. 时间衰减加权 | 反映决策序列 | 假设强 | v1 |
| C. Shapley | 严格 | O(2^K) | 远期 |
| D. 反事实 | 因果性 | 算力爆炸 | 不做 |

#### Trade-off 3：工具自装配安全级别

| 模式 | 含义 | 适用 |
|---|---|---|
| **off**（默认） | 只记 `tool_gap_log`，不提议 | 生产初期 |
| **propose** | 写 `auto_install_proposal`，前端 UI 审批 | 生产稳态（推荐） |
| **auto** | 仅 `skill_market` 已审 + MCP allowlist；自动跑 baseline 回归 | 实验环境 |

任何模式都禁止 agent 自主装：涉及 shell / fs / network 出站的 builtin；未在 `mcp_server_allowlist` 的 MCP；影响 `agent_definition.toolsJson` 的全局变更（必须人工）。

---

## 六、各模块详细设计

### 6.1 P4a — PnL 基础设施 ✅（已落地 2026-06-03）

#### 6.1.1 数据表

3 张新表 + 8 行 seed。详见 `src/db/sqlite/migrations/0060_self_evolve_p4a_pnl_infra.sql`。

| 表 | 关键设计 |
|---|---|
| `daily_mark_price` | uniq(market, symbol, trading_day)；EOD close 物化；记录 source（'eastmoney'/'yfinance'/'synthetic' 等） |
| `strategy_pnl_snapshot` | uniq(runtime, day, symbol)；时序快照；含 realized/unrealized/cum/fee/turnover/market_value；`source='pnl_attributor_v0'`（算法版本） |
| `fee_schedule` | (broker, market, asset_class, side) 多维匹配 + priority（精确 100 / 通配 10）；seed 覆盖 CN/US/HK/CRYPTO + paper 兜底零费率 |

#### 6.1.2 模块清单

| 模块 | 文件 | 职责 | 测试 |
|---|---|---|---|
| **time-util** | `src/runtime/attribution/time-util.ts` | epoch day / trading day 转换、跨市场时区、周末过滤、上一交易日回退 | 22 cases |
| **FeeCalculator** | `src/runtime/attribution/fee-calculator.ts` | (broker, market, asset_class, side) 多维匹配 fee_schedule；支持通配 + 优先级 + 最低收费 + effective window | 14 cases |
| **DailyMarkPriceFetcher** | `src/runtime/attribution/mark-price-fetcher.ts` | 批量从 connector 拉 EOD bar 物化；带 source 标记、upsert、失败隔离、batch 上限 | 9 cases |
| **AnalystAccuracyWriter** | `src/runtime/attribution/analyst-accuracy-writer.ts` | 两阶段：syncPlaceholders（同步占位）+ evaluatePending（按 mark 推断 outcome 回填 isCorrect）；end mark 不回退避免污染 | 33 cases |

**总计：78 个新单测全过；tsc 未引入新错误（预存在 976 → 实改 971）。**

#### 6.1.3 关键设计决策

1. **fill.fee 不改写**：PnlAttributor 跑批时 FeeCalculator 估算后写入 `strategy_pnl_snapshot.fee_daily`，不污染原始 fill 行（数据真相单源）。
2. **mark price 物化解耦**：Fetcher 在交易日结束后一次性物化，跑批只读本表，不再依赖 connector 实时健康度。
3. **AnalystAccuracyWriter 不侵入 fusion**：两阶段在 PnlAttributor 跑批时统一调用，零修改 `signal-fusion.ts` 热路径。
4. **agentInstanceId=null 严格跳过**：不写假 definition_id，保持 `analyst_accuracy_log` 与 `agent_definition` FK 真相一致；reader（`loadDynamicWeights`）按 definition_id 聚合时不会被污染。
5. **end mark 精确取**：评估日 mark 缺失时直接跳过（`skippedNoFutureMark`），避免回退取到 start mark 导致 `outcome` 计算错误（实测踩过坑）。

### 6.2 P4b — PnlAttributor Worker（下一期）

**目标**：扫 `fill` + `execution_report` → 算时序 position + NAV → 写 `strategy_pnl_snapshot` 与 `agent_pnl_attribution`。

**触发**：cron 每日 03:00（日度）+ 每 15 min（实时滚动，仅 active strategy）。

**数据流**：
```
fill + execution_report (with FeeCalculator 估 fee)
  → 算 strategy_runtime 日 PnL
  → 写 strategy_pnl_snapshot (runtime, day, symbol)
  → 反查 strategy_runtime → workflow_run（fill 那次的决策）
  → 反查 workflow_run.skill_recall_log（executed=true 的 skill）
  → 等权分配 PnL → agent_pnl_attribution + agent_skill_run.pnl_delta
  → 聚合到 agent_skill.pnl_attribution_json（30 天滚动）
  → 调 AnalystAccuracyWriter.syncPlaceholders + evaluatePending
```

**异常处理**：跨日 fill / 撤单 / corp action → 写 `pnl_attribution_anomaly` 日志（落 metadataJson），不阻塞主流程。

**代码落点**：`src/runtime/attribution/pnl-attributor.ts` + `src/scripts/run-pnl-attribution.ts`。

### 6.3 P5 — SkillPromoter Worker

**目标**：扫 procedural / reflective experience，把高价值候选晋升为 `agent_skill(pending_review)`。

**触发**：接入 `ExperienceMaintenanceWorker`，每 30 min 跑一轮。

**规则 v0**：
```
candidate.recallCount >= 5
  && candidate.successCount / candidate.executedCount >= 0.7
  && (candidate.pnlSum > 0 || candidate.pnlSum === null /*尚无 PnL 信号*/)
  && !alreadyPromoted(candidate.id)
```

**审批**：MemoryTab 新增「Skill 晋升候选」tab；通过 → `state=active`；驳回 → `state=archived` + 写 reflection 反馈给 Promoter。

### 6.4 P6 — Skill 自动修订

Reflector 写 reflective + linkedSkillIds 时 → 自动 enqueue SkillEvolver（baseExperience=reflective.id）；新版本 parent_skill_id 指向旧版本。

### 6.5 P7 — ToolGapWatcher

订阅 `tool_call_log`（unknown tool / parse_retry_used）+ reflective experience（正则提"need tool X"）+ builtin `tool.report_gap` → 去重写 `tool_gap_log`。

### 6.6 P8 — AutoInstaller propose 模式

扫 `tool_gap_log.status=open` → 路由（unknown_tool / repeated_fail / explicit_report）→ 写 `auto_install_proposal` 入审批队列。MemoryTab 加 Tool Gaps sub-tab。

### 6.7 P9 — Reason 节点 PnL-aware + auto 模式

reason 注入"该 agent 最近 7 天最赚钱 top-3 skill"；MCP allowlist 全审通过的 + `safetyLevel=low` 自动装；SkillEvolver baseline 回归通过才 enable。

---

## 七、非功能设计

### 7.1 安全设计

| 安全项 | 设计 |
|---|---|
| **自装工具白名单** | `mcp_server_allowlist` + `skill_market_audit_pass` 双门禁；agent 不能装非白名单 MCP |
| **晋升 skill 不直接上线** | 默认 `state=pending_review`；只有 `AUTO_INSTALL_MODE=auto` + 回归通过才自动 active |
| **PnL 数据敏感性** | `agent_pnl_attribution` = 高（真实收益）→ DB 存储 + 项目内隔离；前端读必须经 monitor.routes 鉴权 |
| **审计** | 所有自装/自晋升必须留痕到 `skill_promotion_run` / `auto_install_proposal`，30 天后归档不删 |

### 7.2 稳定性 & 灰度

- **总开关**：
  - `SELF_EVOLVE_ENABLED=false`（默认）→ 4 个新 worker 全停
  - `SELF_EVOLVE_ENABLED=true` + `AUTO_INSTALL_MODE=propose`（稳态）
  - `SELF_EVOLVE_ENABLED=true` + `AUTO_INSTALL_MODE=auto`（限实验）
- **熔断**：4 个新 worker 复用 `ExperienceMaintenanceWorker` 的 budget + 失败计数；连续 3 次失败暂停 1 小时。
- **回滚**：每期都设回滚开关；新表只读不删，down 脚本配套提供。

### 7.3 监控（新增 metric）

```
self_evolve.pnl_attributor.runs_total{status}
self_evolve.pnl_attributor.attributions_emitted_total
self_evolve.pnl_attributor.anomaly_total
self_evolve.analyst_accuracy.placeholders_inserted_total
self_evolve.analyst_accuracy.evaluated_total
self_evolve.analyst_accuracy.skipped_no_mark_total
self_evolve.mark_price.fetched_total{market}
self_evolve.mark_price.failures_total{market}
self_evolve.skill_promoter.candidates_scanned_total
self_evolve.skill_promoter.promoted_total
self_evolve.tool_gap.gaps_logged_total{kind}
self_evolve.tool_gap.proposals_created_total
self_evolve.tool_gap.auto_installed_total
```

接入 `src/runtime/experience/metrics.ts`，前端 MemoryTab 顶部展示。

### 7.4 数据一致性 / 对账

- **PnL ↔ Fill 对账**：每天 04:00 跑 `run-pnl-reconcile.ts`，对比 `Σ fill.notional` vs `Σ strategy_pnl_snapshot.cumPnl` 偏差 > 1% 报警。
- **Skill ↔ Experience 对账**：复用现有 `reconciliation.ts` 框架，加 procedural→skill 维度。

### 7.5 部署 / 灰度策略

| 阶段 | 操作 | 验证信号 |
|---|---|---|
| 接入 | `SELF_EVOLVE_ENABLED=true` + `AUTO_INSTALL_MODE=off` | metrics 看到 attributor / mark_price / accuracy 三组指标有数据 |
| 灰度 1 周 | 同上 | sharpe 数据出现；`agent_skill.pnl_attribution_json` 非空 |
| 灰度 2 周 | + 启 P5 SkillPromoter | 至少 1 个 skill 被晋升且被召回成功 |
| 上线 | `AUTO_INSTALL_MODE=propose` | 用户实际 approve ≥ 1 个 proposal |
| 实验 | `AUTO_INSTALL_MODE=auto`（仅实验 agent） | sandbox agent 完成端到端自装配 |

---

## 八、工作量和排期（6 期路线图）

| 期号 | 主题 | 核心交付 | 工时 | 状态 |
|---|---|---|---|---|
| **P4a** | PnL 基础设施（路面） | `daily_mark_price` / `strategy_pnl_snapshot` / `fee_schedule` + 4 模块 + 78 tests | 2-3 人/日 | ✅ 2026-06-03 |
| **P4b** | PnL 反馈环（燃料） | PnlAttributor worker + `agent_pnl_attribution` + skill 字段补齐 + 对账 + metrics + 后端只读接口 | 3-4 人/日 | 下一期 |
| **P5** | Skill 晋升（齿轮） | SkillPromoter + `skill_promotion_run` + 前端 Skill Promotions sub-tab | 3 人/日 | TBD |
| **P6** | Skill 自动修订 | Reflector → SkillEvolver 自动触发 + bodyMd diff 视图 | 2 人/日 | TBD |
| **P7** | Tool Gap 观测 | ToolGapWatcher + `tool_gap_log` + `tool.report_gap` builtin + 前端 Tool Gaps sub-tab | 2 人/日 | TBD |
| **P8** | Tool 自装配 propose | AutoInstaller + `auto_install_proposal` + 前端审批 UI | 4 人/日 | TBD |
| **P9** | PnL-aware reason + auto 模式 | reason 注入 top-3 skill + MCP allowlist + auto 模式 + SkillEvolver baseline 回归 | 3 人/日 | TBD |

**总计：17-18 人/日（不含 P4a 已完成的 3 人/日）。**

---

## 九、参考

| 标题 | 链接 |
|---|---|
| Memory V2 设计 | [MEMORY_V2_DESIGN.md](./MEMORY_V2_DESIGN.md) |
| Monitoring V2 设计 | [MONITORING_V2_DESIGN.md](./MONITORING_V2_DESIGN.md) |
| Environment Manager 设计 | [ENVIRONMENT_MANAGER_DESIGN.md](./ENVIRONMENT_MANAGER_DESIGN.md) |

---

## 十、变更日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-06-03 | 首版（含 P4a 已落地实现） |
