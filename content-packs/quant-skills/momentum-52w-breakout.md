---
description: 52 周新高（52-week high breakout）动量信号，结合成交量确认与波动率过滤。经典 Jegadeesh-Titman 动量的精炼版，最简单也是最稳健的 momentum 因子之一。适合 analyst_technical / research 做趋势跟随。触发关键词：52 周新高、52w high、breakout、动量。
roles: [analyst_technical, research]
tags: [momentum, technical, alpha]
---

# 52 周新高突破

## 信号定义
- **52w_high_pct** = close / max(close, 252) - 1
- 当 `52w_high_pct >= -0.02`（即距 52 周新高 ≤ 2%）且 `volume > 1.5 × avg_volume_20d` → 突破候选

## 计算步骤

### Step 1：拉 1 年日 K
- 工具：`investor-agent.historical_prices(ticker, period="1y", interval="1d")` ← 首选
- 工具：`qubit-data/fetch_klines(symbol, interval="1d", limit=252)` ← 现网内置 connector，最稳

### Step 2：算指标
```python
close, high = klines["close"], klines["high"]
high_52w = max(high[-252:])
pct_to_high = close[-1] / high_52w - 1
avg_vol_20 = mean(volume[-20:])
vol_ratio = volume[-1] / avg_vol_20
```

### Step 3：过滤 + 排序
- 必须 `pct_to_high >= -0.02`（在新高 2% 内）
- 必须 `vol_ratio >= 1.5`（量能放大）
- 排除 30 日波动率 > 6% 的高波幅噪声股
- 排除最近 3 日已暴涨 > 10% 的追高陷阱

### Step 4：信号生命周期
- 突破日 T0 进场
- 止损 T0 - 1.5 × ATR(20)
- 止盈 T0 + 3 × ATR(20)
- 最大持有 60 个交易日，避免变庄家割韭菜

### Step 5：落 factor / signal
- `factor.register({ name: "mom_52w_breakout", expr: "max(close, 252) / close - 1", lang: "qlib_expr" })`
- 多标的：循环 `factor.compute` 后 sort，top 候选写 `analyst_signal`

## 常见陷阱
- 单日成交量放大并不可靠：必须看 5 日平均 vol_ratio
- 微盘股容易被庄家拉升 → 用 free_float_market_cap > $500M 过滤
- 已确认要回避：财报日 ±2 个交易日内的突破（基本面 surprise 主导，不是动量）

## 输出
- factor 1 条
- analyst_signal top-5（含进出场、止损止盈）
