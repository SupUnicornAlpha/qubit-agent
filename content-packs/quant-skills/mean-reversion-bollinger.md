---
description: 布林带 + RSI 双重确认的均值回归信号，专门捕捉短期超买/超卖反转。适合在 sideways 震荡行情用，趋势行情会失效；务必配 vol-regime-classifier 先判 regime。触发关键词：mean reversion、均值回归、Bollinger Bands、RSI、超买超卖。
roles: [analyst_technical]
tags: [mean-reversion, technical, contrarian]
---

# 布林带 + RSI 均值回归

## 信号定义
- **多头反转**：close 跌破下轨（`close < SMA20 - 2σ`）∧ `RSI(14) < 30` → 短期反弹候选
- **空头反转**：close 突破上轨（`close > SMA20 + 2σ`）∧ `RSI(14) > 70` → 短期回撤候选

## 计算步骤

### Step 1：拉 60 日 K
- 工具：`investor-agent.historical_prices(ticker, period="3mo", interval="1d")`
- 或：`qubit-data/fetch_klines(symbol, interval="1d", limit=60)`

### Step 2：算指标
```python
sma20 = mean(close[-20:])
sigma20 = std(close[-20:])
upper, lower = sma20 + 2*sigma20, sma20 - 2*sigma20
rsi14 = compute_rsi(close, 14)
```

或工具：`investor-agent.technical_indicator(ticker, "BollingerBands")` + `technical_indicator(ticker, "RSI")`

### Step 3：regime 前置过滤（关键，不做就亏）
- 必须先调 `vol-regime-classifier` skill 判定当前 regime ∈ {ranging, low-vol}
- 若 regime ∈ {trending, high-vol crisis} → 拒绝交易（趋势行情布林反转必亏）
- 工具：可借 `investor-agent.fear_greed_index` 判 extreme greed/fear，作 sanity check

### Step 4：进出场
- 多头反转进场：close 收回中轨（SMA20）上方
- 止损：低于反转 K 的 low - 1×ATR(14)
- 止盈 1：触及中轨（SMA20）
- 止盈 2：触及上轨（SMA20 + 2σ）
- 持有期不超过 10 个交易日

### Step 5：落 factor / signal
- `factor.register({ name: "bb_rsi_reversal", expr: "...", lang: "qlib_expr" })`
- `analyst_signal`：注明是反转信号且依赖 ranging regime

## 失效场景（务必识别）
- 强势趋势中布林带"沿带行走" → 不进场
- 财报、央行会议、并购等基本面事件前后 → 不进场
- 流动性差的小盘 → 滑点吃光收益

## 输出
- factor 1 条
- analyst_signal（含 regime 判定 + 反转候选）
