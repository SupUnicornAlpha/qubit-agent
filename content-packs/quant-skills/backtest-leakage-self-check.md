---
description: 回测前 / 回测后必跑的数据泄露 self-check，预防 lookahead / survivorship / restatement / lookahead embedding 四类常见 bias。所有 backtest_run 之前都应该过这个 checklist，否则回测美如画、实盘哭瞎眼。触发关键词：回测、backtest、数据泄露、leakage、lookahead bias、survivorship、out-of-sample。
roles: [backtest, research, analyst_technical]
tags: [backtest, integrity, validation]
---

# 回测数据泄露 Self-Check

## Bias 类型与检查项

### 1. Lookahead Bias（前视）
- ❌ 用 t 日才公布的 EPS 信号交易 t-1 日开盘 → 必须用 EPS 公布日 + 1 个交易日才能交易
- ❌ 财报 restatement 用最新版数据回测过去 → 用 point-in-time 数据
- ❌ 当日 close 入信号、当日 close 成交 → 改成 t 日 close 入信号、t+1 日 open 成交

**检查方法**：
```python
for trade in trades:
    assert trade.execution_time > signal.timestamp
    assert signal.timestamp >= data.point_in_time_release_date
```

### 2. Survivorship Bias（幸存者）
- ❌ 只用现存的 S&P 500 成分股回测 → 必须用 historical S&P 500 constituent list
- ❌ 已退市标的不在 universe → 用 CRSP / WRDS 历史 universe 数据

**检查方法**：
```python
universe_history = load_historical_constituents(index="SP500", as_of=t)
assert all(s in universe_history for s in backtest_symbols)
```

### 3. Look-Ahead Embedding（参数前视）
- ❌ 用 2020-2024 全期数据做 hyperparameter grid search 然后在同期回测
- ✅ 必须 train/val/test 时间切分；不允许参数调优用到 test 期数据
- ✅ Walk-forward：每年用过去 3 年 train + 当年 test，参数滚动重选

### 4. Restated Earnings（财报修正）
- ❌ 2024 年获取的 2018 年 EPS = restated 后的值（一些公司事后修正）
- ✅ 用 EPS as-reported（首次披露值）；公司若 restatement → 单独标记

## Step-by-Step Self-Check

### Pre-backtest
1. 信号时间戳 ≥ 数据 PIT 发布时间（所有信号）
2. universe = historical constituents（不用现成 list）
3. 参数固定（不在回测期内 grid search）
4. 财报数据 = as-reported

### Post-backtest
5. IS / OOS Sharpe gap ≤ 30%（gap 太大 = 过拟合）
6. 回测期内 / 期外样本表现差异在 95% CI 内
7. 把同一策略加 random noise 重跑 N=100 次，看 Sharpe 分布；如果原结果在 top 5% → 可能 lucky / 过拟合

## 工具
- `backtest.run({ config: {...}, strict_pit: true })`
- 若框架不支持 strict_pit，至少手动验证上面 1-4
- `code.run_python` 跑 Step 5-7 的 IS/OOS gap 检测

## 决策树
| 检查项 | 失败 | 行动 |
|---|---|---|
| 1 lookahead | 严重 | 修代码重跑 |
| 2 survivorship | 严重 | 换数据源 |
| 3 embedding | 严重 | walk-forward 重做 |
| 4 restatement | 中等 | 替换数据后再回测 / 标记结论可信度 |
| 5-7 后置 | 中等 | 减少参数 / 缩短回测期 |

## 输出
- analyst_signal 1 条（注明本次回测是否 leakage-free + 备注）
- 必要时：`reflective experience` 1 条记录失败原因
