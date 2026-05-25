# HITL 重构设计（v2 — 智能触发 + 多形态交互）

> **背景**：v1 HITL 只在 `loopOptions.hitlTeam === true` 时把"每一次"Orchestrator
> 规划都暂停成 approve/reject，没有"AI 自己判断要不要问"，也没有"问什么"，
> 用户实际体验是不停弹同一个审批卡片直到死循环。本文档记录 v2 的目标 / 决策 /
> 拆解，作为后续多文件改动的锚点。
>
> **决策日期**：2026-05-25
> **作者**：吴佳峻 / Cursor Agent
> **关联故障**：`fa4c33f` 修复了 graph 路径漏 `parseHitlApproval` + 漏 import 引发的
> ReferenceError，但 v1 设计本身的"过严 + 单形态 + 位置割裂"问题需要本次重构解决。

## 1. 目标

| 维度 | v1 现状 | v2 目标 |
| --- | --- | --- |
| **触发** | 开关一开就每次规划都问 | **3 档**：关 / 由 AI 决定（默认） / 每次都问；AI 模式下叠加硬规则兜底 |
| **形态** | 只有 approve / reject | 4 种 `inputKind`：`approve_only` / `single_choice` / `multi_choice` / `free_form`；本期落 3 种（multi_choice 留 P2） |
| **位置** | 卡片在左侧"启动团队分析"面板下方 | 移到画布下方 / 对话流上方的横幅，左侧仅留小提示锚点 |
| **AI 主动权** | 完全被动 | Orchestrator 在 plan 时主动输出"是否需要 HITL / 什么形态 / 选项是什么 / 为什么" |

## 2. 默认行为

- **首次开 app 默认 = "由 AI 决定"**：既不打扰、也不放任。
- 切到 "关闭" 后**硬规则仍然生效**（资金 / 规模 / 失败重试三类强制问），避免高风险操作被静默执行。

## 3. 三档 HITL 模式

```
[ ] 关闭         永不主动询问；但硬规则（资金/规模/失败重试）仍触发
[*] 由 AI 决定   Orchestrator 输出 hitlNeeded=true 或命中硬规则才问
[ ] 每次都问     保持 v1 行为，每次规划都暂停
```

存储：`workflow.loopOptionsJson.hitlMode: 'off' | 'ai' | 'always'`；老 `hitlTeam: true` 映射到 `'always'` 做兼容。

## 4. 硬规则兜底（无视 hitlMode 都触发）

| 类别 | 命中条件 | 文案 |
| --- | --- | --- |
| **资金** | `workflow.mode === 'trade'` 且 `loopOptions.amount > userThreshold`；或动作含做空/衍生品 | "本次涉及真实下单 $X，需人工确认" |
| **规模** | `scope.symbols.length > 5` 或 `analystSlots.length > 6` | "本次涉及 X 个标的 / Y 名分析师，规模较大" |
| **失败重试** | 同 `(ticker, mode)` 最近一次 workflow status === 'failed'，且时间 < 24h | "上次该标的分析失败，是否调整规划再跑？" |

> 用户未勾选的 confidence < 0.6 / 新标的首次研究 两条留作 P2 兜底，先观察 LLM 主动判断的准确率。

## 5. Orchestrator LLM 输出结构（强制）

修改 `runOrchestratorPlanning` 的 system prompt，要求 LLM 输出 JSON：

```json
{
  "planBrief": "...（保持原内容）",
  "confidence": 0.0,
  "hitlNeeded": false,
  "hitlReason": "已识别为常规多头 + 4 个标准分析师，无需打断",
  "hitlInputKind": "approve_only",
  "hitlOptions": []
}
```

- `hitlNeeded` 为 `false` 且 `loopOptions.hitlMode !== 'always'` 且硬规则未命中 → 直接派单，不创 HITL request
- `hitlNeeded` 为 `true` → 必带 `hitlInputKind` + （若是 choice 类）`hitlOptions: [{label, value, description?}]`
- `confidence` 仅用于运营观察，不做触发判定（P2 再决定要不要纳入硬规则）

## 6. 新增 inputKind 形态

| inputKind | 用例 | 后端 inputSchema | 前端组件 |
| --- | --- | --- | --- |
| `approve_only` | 批准 / 拒绝（兼容现有） | `{}` | 两个按钮 |
| `single_choice` | "优先看 A 还是 B？" | `{ options: [{label, value, description?}] }` | radio + 提交 |
| `free_form` | "请用一句话告诉我侧重点" | `{ placeholder?, maxLength?: 500 }` | textarea + 提交 |
| `multi_choice`（P2） | "勾选要追加的分析师" | `{ options: [...], minSelect?, maxSelect? }` | checkbox + 提交 |

## 7. Schema 变更

新增 migration `0044_workflow_hitl_v2.sql`：

```sql
ALTER TABLE workflow_hitl_request ADD COLUMN input_kind TEXT NOT NULL DEFAULT 'approve_only';
ALTER TABLE workflow_hitl_request ADD COLUMN input_schema_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflow_hitl_request ADD COLUMN response_json TEXT;
```

- 老数据 `inputKind` 默认 `approve_only`，老 approve/reject 路径完全不影响
- `responseJson` 为 nullable；single_choice 写 `{ value: 'a' }`，free_form 写 `{ text: '...' }`

## 8. API 变更

- **新增** `POST /api/v1/workflows/:workflowId/hitl/:requestId/resolve`，body：
  ```ts
  { decision: 'approved' | 'rejected', response?: Record<string, unknown> }
  ```
- 老 `/approve` 和 `/reject` 内部转调 `/resolve`，前端无破坏
- `HitlApprovalPayload` 新增可选 `response?: unknown` 字段，沿原链路透传给 Orchestrator 下一轮 prompt：`已收到人工反馈：{response}`

## 9. UI 位置调整

```
旧布局：
┌──────────┬─────────────┬──────────┐
│ 左侧控制 │   画布       │ 右侧产出 │
│ ...       │   ...        │ ...      │
│ [启动]    │              │          │
│ [HITL 卡] │   对话流     │          │
└──────────┴─────────────┴──────────┘

新布局：
┌──────────┬─────────────┬──────────┐
│ 左侧控制 │   画布       │ 右侧产出 │
│ ...       │              │          │
│ [启动]    │ ─── HITL ────│          │
│ ⏸ 跳转   │   对话流     │          │
└──────────┴─────────────┴──────────┘
```

`<TeamHitlBanner />` 抽组件接收 `workflowRunId` + `onResolved` 回调，左侧仅保留：
> "⏸ 有 1 条待审批 ↑ 跳到画布查看"

## 10. 实施阶段（P0+P1，~3 工作日）

| # | 任务 | 文件 | 估时 |
| --- | --- | --- | --- |
| 1 | 落本文档 | `docs/HITL_REDESIGN.md` | 30min |
| 2 | schema + migration 0044 | `db/sqlite/schema.ts` + `db/sqlite/migrations/0044_*` | 1h |
| 3 | `/hitl/:id/resolve` 端点 + 老端点转调 + `HitlApprovalPayload.response` | `src/routes/workflow-hitl.routes.ts` + `runtime/workflow/hitl-service.ts` | 2h |
| 4 | 三档模式 + 硬规则 | `runtime/workflow/hitl-service.ts:resolveTeamOrchestratorHitl` | 2h |
| 5 | LLM 输出 JSON schema | `runtime/msa/analyst-team.ts:runOrchestratorPlanning` | 3h |
| 6 | `<TeamHitlBanner />` 抽组件 + 挂载位置调整 | 新建 `frontend/src/components/team/TeamHitlBanner.tsx` + `MainContent.tsx` | 4h |
| 7 | 三档开关 + localStorage 迁移 | `MainContent.tsx` 控制面板段 | 1h |
| 8 | 4 种 inputKind 渲染（先做 3 种） | `TeamHitlBanner.tsx` | 4h |
| 9 | 单测 + 手测 | `runtime/workflow/__tests__/hitl-trigger.test.ts` 新建 | 3h |

## 11. 风险 / 兼容性

- **老 HITL 请求**（v1）的 `inputKind` 自动落 `approve_only`，前端老 approve/reject UI 完全可用
- **LLM JSON 输出失败**：fallback 把整段 planBrief 当 `planBrief`，`hitlNeeded` 默认按 `hitlMode==='always'` 兜底
- **resume 路径**：`resolveHitlRequest` 重派 task 时把 response 一并塞进 `params.hitlApproval.response`，下一轮 plan prompt 注入"用户在第 N 步告诉你：{response}"

## 12. 后续 P2 候选

- multi_choice 形态
- LLM confidence 阈值兜底
- embedding(planBrief, userGoal) 偏离度判定
- 历史采纳率自适应（连续 N 次全 approve → 提示降级开关）
- HITL request 的"提醒人"机制（连接 Slack / 桌面通知）
