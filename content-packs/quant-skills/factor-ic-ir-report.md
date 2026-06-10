---
description: 因子标准化评估三段式报告：IC（信息系数）/ IR（信息比率）/ turnover（换手率），是判断一个新因子能否进入策略组合的最低门槛。适合 research / backtest 出因子前必跑。触发关键词：IC、IR、信息系数、因子评估、factor evaluation。
roles: [research, backtest, analyst_technical, analyst_fundamental]
tags: [factor, evaluation, report]
---

# 因子 IC / IR / Turnover 三段式

## 评估目标
判断因子 f 是否值得纳入策略组合，三大门槛：
- **IC** = corr(f_t, return_{t+1})；通常 |IC| ≥ 0.03 才有意义
- **IR** = mean(IC_t) / std(IC_t)（时间维度上）；IR ≥ 0.5 视为稳健
- **Turnover** = mean(|w_t - w_{t-1}|)；衡量交易成本可行性，≤ 0.5 为佳

## 计算步骤

### Step 1：注册因子
- `factor.register({ name, expr, lang, projectId })`
- 必填 expr 例：`Rank(close - REF(close, 20)) / 20` （动量 20d 因子）

### Step 2：自动评估（首选）
- `factor.autoEvaluate({ factorId, lookbackDays: 252, universe: "CN-A" })`
  - 内部跑：daily compute → 横截面 rank → 算 IC（rank-IC）+ IR + turnover

### Step 3：手动校验（必要时）
若 autoEvaluate 结果可疑：
- `factor.compute({ factorId, symbols, asof_list })` 拿历史值
- `code.run_python` 算：
  ```python
  ic_series = [corr(f[t], ret[t+1]) for t in days]
  ic_mean, ic_std = mean(ic_series), std(ic_series)
  ir = ic_mean / ic_std
  ```

### Step 4：三段式报告（每段 3 行）

```
## IC
mean(IC) = X.XXX  (基准 ±0.03)
hit rate = XX%   (>50% 为正向稳健)
IC by season = 春 X.XX / 夏 X.XX / 秋 X.XX / 冬 X.XX

## IR
IR = X.XX  (基准 0.5)
IR by year = 2022 X.XX / 2023 X.XX / 2024 X.XX
draw down period = YYYY-MM ~ YYYY-MM (max IC drawdown XX%)

## Turnover
mean turnover = X.XX  (基准 ≤0.5)
top-decile holding days = X.X
sector concentration (HHI) = X.XX
```

### Step 5：决策树
| IC | IR | Turnover | 行动 |
|---|---|---|---|
| ≥ 0.05 | ≥ 0.7 | ≤ 0.3 | 强候选：进 strategy.compose 主因子 |
| ≥ 0.03 | ≥ 0.5 | ≤ 0.5 | 候选：与其他因子配多因子 ensemble |
| ≥ 0.03 | ≥ 0.5 | > 0.5 | 候选但需 transaction-cost adjusted backtest |
| < 0.03 | — | — | 不进入 |
| ≥ 0.03 | < 0.3 | — | 不稳定，先做 regime 分析再决定 |

### Step 6：归档
- `factor_evaluation` 表自动落（autoEvaluate 时）
- 若有结论 → 写 `analyst_signal` 一条注明决策

## 常见坑
- 用 calendar day return 而非 trading day return → IC 系统性偏低
- forward return 用 close-to-close 而非 next-day-open-to-close → 引入 lookahead bias
- 单一 universe（全市场）跑出来的 IC 在小盘股 universe 上可能完全反转

## 输出
- factor_evaluation 1 条
- analyst_signal 1 条（建议是否入库 + 配套理由）
