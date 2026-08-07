# Qubit Prime — Strategy 契约硬化（回测 ↔ 纸交易同源）

| 项 | 内容 |
|----|------|
| 文档状态 | **v0.3 · SC0–SC3（seed/prompt）+ 工坊/Team UI 缺口已补** |
| 日期 | 2026-08-07（修订 2026-08） |
| 对标 | QuantDinger Strategy API V2 |
| 依赖 | [01](./01-runtime-core-rust.zh-CN.md) · [03](./03-quant-agent-data-decision-upgrade.zh-CN.md) · [07](./07-execution-trader-agent.zh-CN.md) / [08](./08-data-catalog-pit.zh-CN.md) |
| 非目标 | Crypto 双腿；策略 DSL 进 Rust `run_turn`；本轮 SC3 自动编排评测收口 |

---

## 1. 问题陈述

> **一份 Python 源码 → 编译成不可变 StrategyManifest → 回测与纸交易共享 OrderIntent 中间层。**

与量化工作台 / 团队研究的关系：

| 路径 | 角色 |
|------|------|
| Composer / `strategy.compose` + `backtest.run` | 因子配方（既有） |
| Strategy API V2 + `strategy.compile` / `contract_backtest` / `paper_*` | 可运行源码契约（本篇） |
| `def-strategy-coder`（on-demand subagent） | Orchestrator `agent.invoke(callee_spec_id)` 写码验证；**不进**固定编组 |
| 脚本工坊「验证契约 / 进引擎」 | UI：看代码、Manifest、纸交易 Session、strategy_runtime |

---

## 2. 已实现落点

| 能力 | 路径 |
|------|------|
| Compile / SimBroker backtest | `src/runtime/strategy/v2/strategy_contract_runner.py` + `contract-service.ts` |
| PaperSession（固定纸本金） | `paper-session-service.ts` |
| HOST 工具 | `strategy.compile` · `strategy.verify` · `strategy.contract_backtest` · `strategy.paper_deploy` · `strategy.paper_run` |
| REST（工坊） | `POST .../compile` · `.../backtest` · `.../paper-deploy` · `.../paper-run` |
| Agent | `def-strategy-coder`（on-demand subagent；Orchestrator `agent.invoke`）；Orchestrator / Prime HOST surface 已授权契约工具 |
| 示例 | `examples/strategy_v2/ma_cross_spy.py` |
| UI · 脚本工坊 | 看代码 · 验证契约 · 契约回测 · 纸交易部署/回放 · 启动/停止纸交易引擎 |
| UI · Team | 脚本 tab 可见代码（优先 Strategy API）· 徽章 · 「打开工坊」handoff |

**Q-SC1 拍板**：纸交易 percent 用 **固定纸本金**（默认 `100_000`，会话字段 `paperCapital`）。

---

## 3. Agent 工作流

```
研究/MSA 产出假设
    → Orchestrator agent.invoke({ callee_spec_id: "def-strategy-coder", goal })
    → （画布此时才出现 strategy_coder 节点；idle 不展示）
    → 写 Strategy API 源码
    → strategy.compile
    → strategy.contract_backtest
    → （可选）strategy.paper_deploy → strategy.paper_run（dispatch=paper）
    → 源码落入脚本工坊 / Workspace
```

**不要**用 `assign_task(role=research)` / `call_team_research` 派写码任务——同 role 会绑到 `def-research`。

因子配方仍走编组内 `def-research` 的 `strategy.create_version` → `compose` → `backtest.run`，两条链并存。
`def-strategy-coder`：`executionKind=subagent`，**不进** `grp-strategy-pipeline.memberDefinitionIds`。

---

## 4. 里程碑状态

| ID | 产出 | 状态 |
|----|------|------|
| **SC0** | Manifest + compile 拒非法 initialize | ✅ |
| **SC1** | 同码回测 + HOST/API/UI | ✅ |
| **SC2** | PaperSession + paper order_intent（需 workflow+version） | ✅ 主干 |
| **SC3** | 场景 seed + recipe checklist：compile→contract_backtest 与 compose 双路径 | ✅ seed/prompt/recipe |

---

## 5. 契约表面（摘要）

硬规则：`initialize` 禁 `get_history` / `order_*`；必须有 `handle_data` | `on_rebalance`；`# @param` 面板参数。

示例见 `examples/strategy_v2/ma_cross_spy.py` 与本文档 v0.1 骨架。

---

## 6. 修订记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-08-07 | v0.1 | 规划稿 |
| 2026-08 | v0.2 | SC0–SC2 实现主干：工具 / Agent / 工坊 / 固定纸本金纸交易 |
