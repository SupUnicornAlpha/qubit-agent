---
description: 利用财报后漂移（Post-Earnings Announcement Drift, PEAD）效应，识别 earnings surprise 显著的标的并跟踪后续 1-60 个交易日的超额收益。适合 analyst_fundamental / research 在财报季前后构建短/中期 alpha。触发关键词：PEAD、earnings drift、财报后漂移、SUE、surprise factor。
roles: [analyst_fundamental, research, news_event]
tags: [event-driven, alpha, fundamental]
---

# PEAD（Post-Earnings Announcement Drift）信号

## 核心机制
财报公布日（announcement day）若 earnings surprise（实际 vs 一致预期）显著为正/负，标的在公告后 1-60 个交易日会延续同向超额收益（信息缓慢扩散假说）。

## 计算步骤

### Step 1：拉财报数据
- 工具：`investor-agent.earnings_calendar`（近期日历）或 `mcp-financex.get_earnings_calendar`
- 工具：`investor-agent.get_stock_info`（取最新季度 EPS actual + estimate）
- 必要时：`publicfinance.company_filings(formType="8-K")` 找 earnings release 原文

### Step 2：算 SUE（Standardized Unexpected Earnings）
```
SUE = (EPS_actual - EPS_estimate) / σ(estimate_revisions)
```
- `σ` 用过去 4 季度的 estimate 标准差近似
- `|SUE| > 1.5` 视为显著

### Step 3：分组 + 持有期回测
- 把当季公告日的所有标的按 SUE 排序，前 20% 与后 20%
- 持有期 T+1 ~ T+60，每日算超额收益（vs sector ETF 或 SPY）

### Step 4：落 factor / strategy
- 工具：`factor.register({ name: "pead_sue_<asof>", expr: "...", lang: "qlib_expr" })`
- 工具：`factor.autoEvaluate({ factorId, lookbackDays: 60 })`
- 若 IC > 0.03 / IR > 0.5：`strategy.create_version` + `strategy.compose(kind="factor_score")`

## 风险提示
- 高 transaction cost 行业（小盘股）需要扣除滑点后再评估
- 财报季 cluster 时 PEAD 信号噪声大、需要按 GICS 行业去市场中性化
- 近 5 年 PEAD 强度在大盘股上明显衰减；优先做中小盘 + 高分析师覆盖差异的标的

## 输出
- factor_definition 1 条（pead_sue_X）
- analyst_signal 至少 1 条（含 SUE 排名 top/bottom 各 5 标的 + 持有期建议）
- 若进入 strategy 流：1 个 strategy_version + 1 个 composition
