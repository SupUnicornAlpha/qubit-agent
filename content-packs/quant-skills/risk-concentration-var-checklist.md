---
description: 实盘前必跑的风控四件套：集中度（HHI/单标的占比）+ VaR / CVaR + 流动性 + 压力测试。在 order.create_intent 之后、submit 之前作为门禁。适合 risk 角色统一审查所有 intent。触发关键词：风控、VaR、CVaR、集中度、stress test、压力测试、liquidity。
roles: [risk, research, backtest]
tags: [risk, checklist, pre-trade]
---

# 实盘前风控 4 件套 Checklist

## Step 1：集中度（concentration）
- 工具：`qubit-risk/check_concentration(positions)` ← 内置 connector，最直接
- 检查项：
  - 单标的 weight ≤ 10%
  - 单行业（GICS sector）weight ≤ 30%
  - 单 region 区域 weight ≤ 50%（除非策略明确专注美股或 A 股）
  - Herfindahl-Hirschman Index（HHI）≤ 0.15（即等价于至少 7 等权持仓）

## Step 2：VaR / CVaR
- 工具：`code.run_python` + 标的历史 returns（通过 `qubit-data/fetch_klines` 取）
- 方法：
  ```python
  from numpy import percentile, mean
  port_returns = sum(w_i * ret_i_t for i in portfolio for t in 252_days)
  var_95 = percentile(port_returns, 5)
  cvar_95 = mean([r for r in port_returns if r <= var_95])
  ```
- 门槛：
  - 单日 95% VaR ≤ -3%（即组合 1 日内 95% 概率下跌不超 3%）
  - 单日 95% CVaR ≤ -5%
- 工具：`qubit-risk/evaluate_risk(strategyId, intentList)` 内置，会一并算 VaR

## Step 3：流动性
- 工具：`qubit-risk/assess_liquidity(positions)` ← 内置 connector
- 检查项：
  - 单标的 position size ≤ 10% × 日均成交额（避免 market impact）
  - 退出周期：以 25% × ADV 估退仓时间，应 ≤ 5 个交易日
  - 微盘股（market cap < $300M）单仓 ≤ 2%

## Step 4：压力测试
- 用历史极端事件回放：
  - 2008-09（雷曼倒闭）
  - 2020-03（COVID 抛售）
  - 2022-01（鲍威尔鹰派）
  - 2024-08-05（日元 carry trade unwind）
- 工具：`code.run_python` 取这些日期 ±5d 的标的 return，按当前 weight 加权
- 门槛：单一极端日组合最大回撤 ≤ -10%；若 > -15% 必须减仓

## Step 5：签 intent / 拒绝
- 通过：`sign_intent(intentId, signerRole="risk", note="all 4 checks pass: HHI=X, VaR=X, ADV%=X, stress=-X%")`
- 拒绝：`reject_intent(intentId, reason="...")` 并写一条 `analyst_signal` 给 portfolio_manager

## 输出
- risk_decision 1 条
- analyst_signal 0-1 条（拒绝时附建议调整方案）
