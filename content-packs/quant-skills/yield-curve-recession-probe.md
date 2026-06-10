---
description: 美国国债收益曲线（10Y - 3M / 10Y - 2Y）倒挂程度 + 持续时间 + 美联储基金利率角度，估计未来 12 个月衰退概率。NY Fed 经典 yield curve model 的简化版。适合 analyst_macro / research 做大周期判断。触发关键词：yield curve、收益曲线倒挂、衰退、recession probability、宏观、recession.
roles: [analyst_macro, research]
tags: [macro, recession, fixed-income]
---

# 收益曲线倒挂 → 衰退概率

## 信号定义
- **倒挂幅度**：spread = yield(10Y) - yield(3M)；负值表示倒挂
- **持续天数**：连续倒挂的交易日数
- **衰退概率（NY Fed simplified）**：`P(recession in 12m) = Φ(-0.5 - 0.5 * spread)`

## 计算步骤

### Step 1：拉收益曲线
- 首选：`publicfinance.treasury_rates(date=today)` ← 当日全曲线（1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y, 30Y）
- 历史：`us-gov-open-data.fred.series.observations("DGS10")` 与 `("DGS3MO")` 拉过去 24 个月
- Fed Funds：`us-gov-open-data.fred.series.observations("FEDFUNDS")` 或 `("DFEDTARU")`

### Step 2：算 spread 与持续
```python
spread_10y_3m = dgs10 - dgs3mo  # 历史每日 series
spread_10y_2y = dgs10 - dgs2y
inverted_days = consecutive_count(spread_10y_3m < 0, until=today)
```

### Step 3：估计衰退概率
```python
from scipy.stats import norm
spread_now = spread_10y_3m[-1]
p_recession = norm.cdf(-0.5 - 0.5 * spread_now)  # NY Fed 简化
```

### Step 4：与 BLS 数据交叉验证
- `publicfinance.labor_statistics({ series: ["UNRATE", "PAYEMS"], lookback: 12 })`
- 若 失业率 trough + 12m 已过 ∧ payroll YoY 减速 → 提升衰退置信

### Step 5：写宏观 signal
- `analyst_signal({ rationale: "P(recession 12m)=X% based on yield-curve + labor", confidence: ... })`
- 配套建议：
  - P > 60%：增配 long duration treasury / defensive sectors (XLU, XLP)、降 high-beta 仓位
  - P 30-60%：观察期、保持 60/40 配置 + 增 short put 收 premium
  - P < 30%：可继续 risk-on

## 历史 baseline
- 2007（次贷前）：倒挂持续 200+ 个交易日，spread 低点 -50bp
- 2019：倒挂 90+ 个交易日，spread 低点 -30bp
- 2022-2024：倒挂 500+ 个交易日，spread 低点 -160bp（历史最深）

## 输出
- analyst_signal 1 条（含 spread / inverted_days / p_recession / 跨指标确认）
