# QUBIT Agent Token 效率治理 P0-P2

| 项目 | 内容 |
|---|---|
| 目标 | 在不删除研究、团队、回测、HITL、交易等既有能力的前提下，降低重复上下文、解析重试和无效扇出 |
| 北极星 | 单次有效结论 Token、单工作流 Token、Prompt 占比、重试浪费、失败工具恢复成本 |
| 状态 | Engineering complete |
| 完成日期 | 2026-07-24 |

状态标记：`[x]` 已完成；`[-]` 持续验证；`[ ]` 未开始。

## 总览

| 阶段 | 状态 | 工程进度 | 结果 |
|---|---|---:|---|
| P0 调用与预算收口 | `[x]` | 100% | 原生工具调用、工作流硬预算、Prompt 组件限额、动态 FSI |
| P1 上下文与扇出优化 | `[x]` | 100% | 增量观测、工具检索、默认迭代下降、自适应团队扇出 |
| P2 成本归因与持续验证 | `[x]` | 100% | 组件打点、浪费估算、预算利用率、监控 API |

## P0：调用与预算收口

- [x] `LoopOptionsJson.tokenBudget` 支持工作流级覆盖：
  - `maxTotalTokens`
  - `softLimitRatio`
  - `maxPromptTokensPerCall`
  - `maxSystemPromptChars`
  - `maxUserPromptChars`
- [x] 默认预算按工作流类型区分：chat、live、backtest/simulation、研究场景、完整研究。
- [x] 每轮 LLM 调用前查询 `llm_call_log` 累计 Token；达到硬预算后停止新调用并返回 `token_budget_exhausted`。
- [x] 达到软预算后向 Agent 注入收口指令，禁止继续扩展新分支。
- [x] Token 估算由统一 `chars/4` 升级为 CJK 感知估算。
- [x] system/user Prompt 分别执行首尾保留式硬截断，关键角色契约和输出约束不会同时丢失。
- [x] FSI 从按角色全量注入改为按任务检索，默认最多 2 个 skill、1 个 playbook。
- [x] FSI skill 默认总注入上限由 24,000 字符下降为 6,000 字符。
- [x] ReAct 优先使用 Gateway 已支持的原生 structured tool calling。
- [x] 原生工具调用统一通过 `qubit_action` schema，兼容内部 sentinel/act 链，不修改现有工具执行语义。
- [x] 原生工具模式下没有 tool call 即视为最终文字响应，不再为缺少 sentinel 重发完整 Prompt。
- [x] 保留 `QUBIT_NATIVE_TOOL_CALLING_DISABLED=1` 和旧文本协议作为兼容回退。

## P1：上下文与扇出优化

- [x] observations 从默认保留最近 6 条下降为 3 条。
- [x] 单条 observation 注入上限从 4,000 字符下降为 2,500 字符。
- [x] session history 从 8 条下降为 6 条，单条最多 1,600 字符。
- [x] slot context 注入上限从 12,000 字符下降为 6,000 字符。
- [x] 实时追加指令仅保留最近 3 条。
- [x] 根据任务目标从授权工具中选择最多 16 个相关工具；授权集合不变，因此已有能力不删除。
- [x] `assign_task`、`update_plan`、`call_mcp`、拓扑派单工具始终保留在候选工具面。
- [x] 默认 Agent 最大迭代按角色下调；工作流可通过 `maxIterations` 显式覆盖。
- [x] 团队 slot 默认档位调整为 3/4/5 轮，硬上限 6 轮。
- [x] 未显式选择分析师时，完整 MSA 默认只运行最相关的 2 位信号分析师。
- [x] 用户显式传入 `analystRoles` / `analystDefinitionIds` 时保留完整团队能力。
- [x] 可通过 `QUBIT_ADAPTIVE_TEAM_FANOUT_DISABLED=1` 恢复旧的默认全量扇出。

## P2：成本归因与持续验证

- [x] 每次 reason 调用在 `llm_call_log.request_meta_json` 记录：
  - `promptComponentChars`
  - `promptEstimatedTokens`
  - `promptCompacted`
  - `nativeToolCallingUsed`
  - `tokenBudgetSoftLimitReached`
  - 调用前工作流预算使用量与上限
- [x] Prompt 组件包含 base system、FSI、运行时规则、工具、目标上下文、observations、最终 system/user 长度。
- [x] `/api/v1/monitor/workflows/:id/observability` 增加 `efficiency`：
  - 平均 Token/调用
  - Prompt Token 占比
  - 缓存 Prompt 占比
  - 原生工具调用比例
  - Prompt 压缩调用数
  - 工作流预算利用率
  - Prompt 组件字符聚合
  - parse retry、失败工具恢复、重复静态上下文的估算浪费
- [x] 新增 Token、工作流预算、FSI 检索、工具检索/原生调用和 observability 回归测试。
- [-] 生产样本持续验证：比较改造前后 Token/有效产物、推荐命中率、因子晋级率和回测产物完整率。

## 默认配置

| 配置 | 默认值 |
|---|---:|
| Chat 工作流总 Token | 100,000 |
| Live 工作流总 Token | 120,000 |
| Backtest / Simulation | 250,000 |
| 聚焦研究场景 | 300,000 |
| 其它完整研究 | 400,000 |
| 单次 Prompt Token | 18,000 |
| System Prompt 字符 | 20,000 |
| User Prompt 字符 | 24,000 |
| 软预算比例 | 80% |
| Prompt 工具数 | 16 |
| FSI Skills | 2 |
| FSI Playbooks | 1 |

## 环境变量

- `QUBIT_WORKFLOW_TOKEN_BUDGET`
- `QUBIT_MAX_PROMPT_TOKENS_PER_CALL`
- `QUBIT_MAX_SYSTEM_PROMPT_CHARS`
- `QUBIT_MAX_USER_PROMPT_CHARS`
- `QUBIT_MAX_PROMPT_TOOLS`
- `QUBIT_FSI_MAX_SKILL_CHARS`
- `QUBIT_NATIVE_TOOL_CALLING_DISABLED=1`
- `QUBIT_ADAPTIVE_TEAM_FANOUT_DISABLED=1`

## 验收口径

工程完成不等于效果验收。上线后至少按周比较：

1. 单次调用平均 Prompt Token 与 p95。
2. 单工作流总 Token、调用次数和成本。
3. `parseRetryUsed` 发生率。
4. 工具失败后新增 LLM 调用量。
5. Token/结构化推荐、Token/晋级因子、Token/有效回测。
6. 推荐命中率、Brier/ECE、OOS Sharpe 等核心效果不得因压缩明显下降。

## 工程验证记录

- [x] Token 治理与核心链路定向回归：95 passed / 0 failed。
- [x] 全量回归：2080 passed；18 个既有失败仍集中在外部行情网络/依赖、旧工具路由断言、自演进默认配置、因子沙箱、推荐评估和 loop driver 对象身份，与本批改动无新增失败。
- [x] `git diff --check` 通过。
- [-] 生产工作流 A/B：需积累真实研究样本后持续比较效果指标与 Token 效率。
