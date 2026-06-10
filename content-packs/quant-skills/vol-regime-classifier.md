---
description: 波动率 regime 三分类器（low-vol / ranging / high-vol crisis），所有 mean-reversion 与 trend-following 策略的前置过滤器。基于 VIX/ATR + 60d 历史百分位，输出当前 regime 标签 + 切换概率。触发关键词：vol regime、波动率体系、VIX、市场环境、regime switch。
roles: [analyst_macro, analyst_technical, research]
tags: [regime, vol, macro, gating]
---

# 波动率 Regime 三分类

## Regime 定义
| Regime | VIX 区间 | 单股 ATR%(20d) 百分位 | 适合策略 |
|---|---|---|---|
| **low-vol** | VIX < 15 | 标的 ATR% < 25 分位 | trend following、carry |
| **ranging** | 15 ≤ VIX < 25 | 标的 ATR% 在 25-75 分位 | mean reversion、vol selling |
| **high-vol crisis** | VIX ≥ 25 或单日 > 30 | ATR% > 75 分位 | 减仓、tail-hedge、wait |

## 计算步骤

### Step 1：拉 VIX 与标的波动率
- 工具：`investor-agent.historical_prices("^VIX", period="3mo", interval="1d")` ← VIX 现货
- 工具：`investor-agent.historical_prices(target, period="3mo", interval="1d")` 取标的 ATR
- 必要时：`us-gov-open-data.fred.series.observations("VIXCLS")` ← FRED VIX 历史长期

### Step 2：算指标
```python
atr14 = compute_atr(high, low, close, 14)
atr_pct = atr14 / close
atr_60d_percentile = percentile_rank(atr_pct, lookback=60)
vix_now = vix_close[-1]
```

### Step 3：分类
```python
if vix_now >= 25 or atr_60d_percentile >= 0.75:
    regime = "high-vol-crisis"
elif vix_now < 15 and atr_60d_percentile < 0.25:
    regime = "low-vol"
else:
    regime = "ranging"
```

### Step 4：切换概率（可选 LLM judgment）
- 用 `us-gov-open-data.fred.series.observations` 取 30d 的 VIX 一阶差分
- 若过去 5d 内 VIX 突破上行 30% → switch_prob_to_crisis 高
- 若过去 10d ATR% 持续下降 → switch_prob_to_low_vol 高

### Step 5：把 regime 写入上下文 / playbook
- `analyst_signal({ rationale: "current regime=...", confidence: ... })`
- 后续 trade idea skill 必须读这一条 signal、refuse 不匹配的策略

## 关键用法
**永远在 mean-reversion / breakout 类 skill 之前先跑一次 vol-regime-classifier，把 regime 作为前置门禁。** 不做这一步是绝大多数量化策略实盘表现远逊于回测的核心原因之一。

## 输出
- analyst_signal 1 条（包含 regime + 切换概率 + 建议禁用 / 启用的策略族）
