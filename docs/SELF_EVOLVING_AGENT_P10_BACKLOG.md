# Self-Evolving Agent — P10+ Backlog（待评估）

| 文档状态 | Backlog（**未排期**，看 P9 上线后实际数据再决定是否做） |
|---|---|
| 创建日期 | 2026-06-03 |
| 父文档 | [SELF_EVOLVING_AGENT_DESIGN.md](./SELF_EVOLVING_AGENT_DESIGN.md)（P4a–P9 已交付） |
| 触发条件 | P9 上线 ≥ 30 天，**且**至少满足下面"何时做"的某个信号 |

---

## 一、为什么要有这个文档

P4a–P9 把"数据飞轮 + 自进化"的**主干**已经全部交付（PnL 反馈环 → skill 晋升 → 工具自配置 → reason 引导 → 召回观察期 auto enable）。

剩下的两个候选项不是闭环必须，但能让闭环**更稳更可控**：

- **P10-A**：把 `SkillBaselineObserver` 的"召回观察期"升级成"dataset replay"（真的跑回测）
- **P10-B**：把"MCP allowlist"从隐式（`mcp_catalog.risk_level='low'`）改成显式表 + 前端 CRUD

为了避免 P9 一上线就盲目排期，把两个项目落到本文档，**看实际用起来是否真的需要**再说。

---

## 二、候选项 P10-A：SkillBaselineObserver dataset replay 档

### 2.1 现状（P9 召回观察期口径）

```
evolved skill (pending_review)
  → 在 reason 节点被真实召回 ≥ minRecallCount(3)
  → 真实执行后的 agent_skill_run.outcome 中 success/(success+fail+partial) ≥ 60%
  → 满足 minSignaledRuns(2)
  → SkillBaselineObserver.runOnce 自动 approveSkillPromotion(actor='skill_baseline_observer')
```

**优点**：零基建，复用 P5 现有数据；信号都是真用过的。
**缺点**：等数据自然累积（典型 7–14 天）；只能"事后判定"，不能"上线前 dry-run"。

### 2.2 P10-A 提案：dataset replay 第二档

并行加一档：**离线把 evolved skill 在标准 dataset 上跑一遍**，对比"用 base skill"和"用 evolved skill"的关键指标，过线才 approve。

```
evolved skill (pending_review)
  → SkillBaselineObserver 跑两档：
       档 1（已有）：召回观察期         → 软通过（需 7-14 天）
       档 2（P10-A）：dataset replay   → 硬通过（< 1 小时；上线前就能跑）
  → 任一档通过 → approveSkillPromotion
  （也可以改成"两档都通过"，更严但更慢）
```

### 2.3 关键设计点

| 项 | 说明 |
|---|---|
| **dataset 来源** | 复用 `eval/pipeline.ts` 的 `datasetId`（目前 `runEval` 是 toggle 打分 mock，需要先升级成"真跑 reason→act 链路"） |
| **回归指标** | 至少 4 个：成功率 / 平均 PnL / 关键 tool 调用数 / 平均 token 用量 |
| **baseline 取数** | `agent_skill.parentSkillId` 指向的 base skill 跑同 dataset 作为对照组 |
| **过线条件** | `evolved.successRate ≥ base.successRate` **且** `evolved.avgPnL ≥ base.avgPnL × 0.95`（不能比 base 差） |
| **失败留痕** | 写 `skill_evolution_run.baselineScore` / `bestScore`（字段 schema 里已留位） |
| **性能** | 单个 evolved skill 跑 dataset 最多 N 步；超 budget 就标 timeout 不算过线 |

### 2.4 工时估算

| 子任务 | 估算 |
|---|---|
| 升级 `eval/pipeline.ts:runEval` 从 mock 打分变真跑 reason→act 链路 | 2 人/日 |
| `BaselineReplayRunner`（取 evolved + parent + dataset → 跑两组 → 算指标 → 写 evolution_run） | 1 人/日 |
| 集成进 SkillBaselineObserver（新增 `baselineMode: 'recall' \| 'replay' \| 'either'`） | 0.5 人/日 |
| cron + metrics + 单测 + 集成测 + docs | 1 人/日 |
| **合计** | **~4.5 人/日** |

### 2.5 何时做

**触发信号**（任一满足）：

- P9 上线 30 天后，evolved skill `pending_review` 平均"停留天数"≥ 21 天（说明召回观察期太慢，需要离线快通道）
- 出现 ≥ 1 个 evolved skill 被 SkillBaselineObserver `approveSkillPromotion` 后线上 PnL 转负（说明召回观察期信号不准，需要更硬的指标）
- 业务方明确提出"上线前要看 evolved skill 比 base 强多少"的诉求

**不做的信号**：

- evolved skill 数量 < 10 / 月（基数小，dataset replay ROI 不正）
- 召回观察期能 ≤ 14 天 enable 多数 skill（说明 P9 口径够用）

---

## 三、候选项 P10-B：mcp_server_allowlist 显式表 + CRUD

### 3.1 现状（P9 隐式 allowlist）

AutoInstaller auto 模式判定：

```ts
mode === 'auto'
  && best.safetyLevel === 'low'      // = mcp_catalog.risk_level
  && best.targetKind === 'mcp_catalog' // 隐式：external catalog_item 永远走 propose
  && best.score >= cfg.minScoreForAuto
```

"白名单"就是 `mcp_catalog WHERE risk_level='low'`。

**优点**：零 schema 变更；用户改 catalog 元数据就能控；运维简单。
**缺点**：粒度只到"行业级 builtin catalog"；不能"针对单条 catalog 行单独黑名单 / 拉到白名单"；不能 audit"谁什么时候改了 allowlist"。

### 3.2 P10-B 提案：显式表 + 前端 CRUD

```sql
CREATE TABLE mcp_server_allowlist (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id),     -- nullable: NULL = 全局规则
  catalog_id TEXT REFERENCES mcp_catalog(id), -- 或 catalog_item_id 二选一
  catalog_item_id TEXT REFERENCES mcp_catalog_item(id),
  rule_kind TEXT CHECK(rule_kind IN ('allow','deny')),
  reason TEXT,
  created_by TEXT,
  created_at TEXT
);
```

AutoInstaller 判定升级：

```ts
const allowed = await checkAllowlist({
  projectId,
  catalogId: best.targetId,
  defaultPolicy: 'risk_low_only',   // 兜底：没显式规则时回 P9 隐式逻辑
});
if (mode === 'auto' && allowed && best.score >= ...) { ... }
```

### 3.3 关键设计点

| 项 | 说明 |
|---|---|
| **优先级** | `deny` > `allow` > 隐式 `risk_level='low'` |
| **作用域** | `project_id NULL` 全局；`project_id` 非空 → 单 project 覆盖 |
| **审计** | 每条 allowlist 行有 `created_by` + `created_at`；删的话改 `state='archived'` 不真删 |
| **前端** | `MemoryTab` 加 sub-tab "MCP Allowlist"，类似 ToolGapsPanel 风格的列表 + 添加/删除 dialog |
| **迁移** | 旧 risk_level 不变，只是多了一层"显式覆盖"；首次部署后 allowlist 表为空 = 行为等价 P9 |

### 3.4 工时估算

| 子任务 | 估算 |
|---|---|
| migration + schema + Drizzle 定义 + 单测 | 0.5 人/日 |
| `checkAllowlist` service + 单测 | 0.5 人/日 |
| AutoInstaller 集成 + 6 集成测调整 | 0.5 人/日 |
| 后端 4 routes（list / add / delete / audit） + 集成测 | 1 人/日 |
| 前端 MemoryTab 新增 sub-tab + dialog + i18n | 1.5 人/日 |
| docs + changelog | 0.5 人/日 |
| **合计** | **~4.5 人/日** |

### 3.5 何时做

**触发信号**（任一满足）：

- 用户提出"我想把某个 `risk_level='low'` 的 catalog 在我的 project 里禁掉"
- 出现 ≥ 1 起"AutoInstaller auto 装错"事件，事后 RCA 结论是"该 catalog 在当时业务场景下不该装"
- 多 project 共用同一 SQLite 实例后，运维要求"按 project 隔离 allowlist"

**不做的信号**：

- 长期只有 1 个 project（不存在跨 project 隔离需求）
- 没有出现"想单独禁某行 catalog"的真实场景

---

## 四、其它已经想到但没立项的小项

下面这些是 P4a–P9 期间发现的"小毛刺"，单独立 P10 太重，等"周边维护期"批量做：

| # | 内容 | 触发 |
|---|---|---|
| 1 | `frontend/src/components/team/HitlInputArea.tsx:12` 的 `'t' is declared but its value is never read` pre-existing 错误 | 周维护：跑一遍 tsc 顺手清 |
| 2 | `SkillBaselineObserver` 加一档"超 N 天没达标自动 archive"（防止 pending_review 越积越多） | 当 pending_review 总数 > 50 |
| 3 | AutoInstaller auto 模式真装后自动跑一次 `tool.test`（确认能 ping 通），失败回滚 | 当出现"装上但其实不能用"事件 |
| 4 | reason PnL skill block 加"近 7d 增量 PnL"和"30d 累计 PnL"双口径 | 业务方明确要双窗口 |
| 5 | `mcp_catalog_item`（external）也加一档"经 N 个用户手动 approve 后变 builtin candidate"的口径，让 external 也能进 auto | external proposal 总量 ≥ 50 |

---

## 五、决策记录

| 日期 | 决策 | 决策人 | 理由 |
|---|---|---|---|
| 2026-06-03 | P10-A / P10-B 暂不排期 | maintainer | P9 已交付完整闭环；先看实际运行数据再说，避免提前过度设计 |

---

## 六、参考

- 父设计：[SELF_EVOLVING_AGENT_DESIGN.md](./SELF_EVOLVING_AGENT_DESIGN.md)（§6.7 P9 + §8 排期表）
- P9 commit: `4233991` — `feat(self-evolve): P9 PnL-aware reason + AutoInstaller auto 模式 + SkillBaselineObserver`
- 相关：[MEMORY_V2_DESIGN.md](./MEMORY_V2_DESIGN.md) / [MONITORING_V2_DESIGN.md](./MONITORING_V2_DESIGN.md)
