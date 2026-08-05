---
description: >
  配对交易协整检验：Engle-Granger / Johansen / 滚动稳定性，输出 hedge ratio 与
  spread z-score 进出场规则。适配 Qubit 证据链（snapshot → thesis）。触发关键词：
  pairs trading、协整、cointegration、统计套利、stat arb。
roles: [analyst_technical, research, backtest]
tags: [pairs, cointegration, mean-reversion, alpha]
adaptedFrom: https://github.com/agiprolabs/claude-trading-skills/tree/main/skills/cointegration-analysis
---

# 配对交易 · 协整检验

> 改编自开源 Agent Skill（agiprolabs/claude-trading-skills · cointegration-analysis），
> 工具面改为 Qubit Prime（`market.snapshot.get` / `code.run_python` / thesis），非原仓库脚本依赖。

## 何时用
- 用户要做 pairs / 统计套利 / 「找协整对」
- 已有两只（或多只）标的的长序列收盘价

## 核心定义
两列价格各自非平稳，但线性组合平稳 → 协整；可对 **spread** 做均值回归。

| | 相关 | 协整 |
|---|---|---|
| 测什么 | 短窗共变 | 长期均衡 |
| 交易 | 动量/对冲粗糙 | 价差均值回归 |

## 步骤

### 1. 锚定数据
- `market.snapshot.get` 固定 snapshotId（证据链第 1 步）
- 用 `qubit-data` / `investor-agent` / `code.run_python` 拉 ≥252 日收盘价

### 2. Engle-Granger（两标的）
```python
from scipy import stats
from statsmodels.tsa.stattools import adfuller
slope, intercept, *_ = stats.linregress(x, y)
resid = y - slope * x - intercept
adf_stat, p, *_ = adfuller(resid, autolag="AIC")
# EG 临界值 ≠ 标准 ADF：n=2 时约 5% ≈ -3.34
```
- 双向测 Y~X 与 X~Y，取更强一侧；`β` = hedge ratio

### 3. Johansen（≥3 标的）
```python
from statsmodels.tsa.vector_ar.vecm import coint_johansen
res = coint_johansen(data, det_order=0, k_ar_diff=1)
# 看 trace / max-eigen vs 临界值
```

### 4. 交易规则（价差）
- `spread_t = y_t - β x_t - α`
- `z = (spread - mean) / std`（滚动 60d）
- 入场：`|z| > 2`；出场：`|z| < 0.5`；止损：`|z| > 3.5` 或协整破灭（滚动 ADF 失败）

### 5. 落证据
- `research.thesis.write`：写清 hedge ratio、p-value、样本窗、失效条件，绑定 snapshotId
- 回测前强制跑 `quant:backtest-leakage-self-check` / `quant:walk-forward-validation`

## 失效
- 结构性断点（并购、指数成分变更）
- 仅高相关无协整
- 样本不足（< 1 年日线）

## 输出
- thesis（含 β、z 规则）+ 可选 factor 名 `pairs_spread_z`
