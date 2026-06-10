---
description: 生成 buy-side order_intent 的标准 checklist —— 从信号确认到 intent payload 到 risk_decision 签名，覆盖 long-only / pair-trade 两个场景。让 live_trading agent 走完整链路，不漏 risk gate。触发关键词：order_intent、做多、buy、live_trading、订单意图、风控签名。
roles: [research, risk]
tags: [live-trading, order, intent, checklist]
---

# Buy-side Order Intent 全链路 Checklist

## 触发场景
- 策略给出 long candidate（factor_score top / breakout signal / earnings beat 等）
- 收到 portfolio_manager 调仓请求

## Step 1：拿当前最新 strategy_version
- 工具：`factor.list({ projectId })` 看可用因子
- 工具：直接读 strategy_version 列表（API：`GET /api/v1/strategies/versions?project_id=...`）
- 若用户没指定，取最新 active strategy_version

## Step 2：决定标的 + size
- 多标的：按 factor_score top-N 等权或 IC 加权
- 单标的：必须从 signal 拿到 symbol + 方向；不允许凭空指定
- size：
  - 默认 = 风险预算 / abs(单股 95% VaR)
  - 简化版：账户 NAV × 1-3%（小仓 deep value 用 1%，大盘高质量用 3%）

## Step 3：拿当前价 + 流动性
- 工具：`investor-agent.get_stock_info(ticker)` 含 price + market_cap + volume
- 备：`qubit-data/fetch_klines(symbol, interval="1d", limit=1)`
- 必填校验：当前价 > 0；日均成交额 > $1M

## Step 4：构造 order_intent
- 工具：`order.create_intent({...})`
- payload：
  ```json
  {
    "strategy_version_id": "<uuid>",
    "symbol": "AAPL",
    "side": "buy",
    "quantity": 100,
    "order_type": "limit",
    "limit_price": 175.50,
    "tif": "day",
    "rationale": "factor_score top-3, 52w breakout confirmed",
    "expected_pnl_bps": 200,
    "stop_loss_pct": 0.05,
    "take_profit_pct": 0.15
  }
  ```

## Step 5：风控审查（必经）
- 工具：`evaluate_risk(strategy_version_id, [intentId])` ← orchestrator 调
- 自动跑：concentration / VaR / liquidity 三项；不通过 → 直接拒绝
- 通过 → 调 `sign_intent(intentId, signerRole="risk")`
- 失败 → 调用 risk-concentration-var-checklist skill 详细诊断

## Step 6：归档
- order_intent 表已落（create_intent 时）
- analyst_signal 1 条：注明该 intent 的入场逻辑 + risk 签名状态
- 实盘环境：进一步走 `qubit-broker/submit_order` 实际下单

## 失败救援
| 失败位置 | 救援动作 |
|---|---|
| Step 1 没找到 strategy_version | strategy.create_version + strategy.compose 现造一个 |
| Step 3 拿不到价 | fallback: fetch_klines；都拿不到 → 报告 N/A 并跳过 |
| Step 5 risk reject | 修改 size 减半重试一次；仍 reject → 终止 |

## 输出
- order_intent 1 条
- analyst_signal 1 条
- risk_decision 1 条
