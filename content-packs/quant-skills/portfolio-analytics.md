---
description: >
  组合绩效分析：从权益曲线算 CAGR、波动、Sharpe/Sortino、回撤、VaR，并对照基准。
  用于回测后报告与 live 复盘。触发：portfolio analytics、Sharpe、最大回撤、绩效报告。
roles: [research, risk, backtest]
tags: [portfolio, analytics, performance, risk]
adaptedFrom: https://github.com/agiprolabs/claude-trading-skills/tree/main/skills/portfolio-analytics
---

# 组合绩效分析

> 改编自 agiprolabs/claude-trading-skills · portfolio-analytics；用 `code.run_python`
> 计算，不强制 quantstats；证据写入 thesis / 研究笔记。

## 输入
时间索引的 **equity** 序列（策略 NAV）与可选基准：
```python
returns = equity.pct_change().dropna()
```

## 必算指标
| 类 | 指标 |
|----|------|
| 收益 | Total return、CAGR、累计曲线 |
| 风险 | 年化波动、Max DD、Calmar |
| 风险调整 | Sharpe（rf）、Sortino |
| 尾部 | 历史 VaR / CVaR（95%） |
| 交易 | 胜率、盈亏比、换手（有成交日志时） |

```python
import numpy as np
vol = returns.std() * np.sqrt(252)
sharpe = (returns.mean() * 252 - rf) / vol
dd = equity / equity.cummax() - 1
max_dd = dd.min()
```

## 步骤
1. 确认 equity 无未来函数（先跑 leakage / walk-forward skill）
2. `code.run_python` 输出指标表 + 关键图数据（不必一次画完）
3. 对照基准（指数 / 等权）：超额收益、跟踪误差、信息比率
4. `research.thesis.write` 或研究笔记：结论 + 失效情景（高相关熊市等）
5. 若服务 live：对照 `quant:risk-concentration-var-checklist` 看是否超限

## 输出
- 指标字典（可 JSON）
- 一段可读结论（是否达到目标 Sharpe / DD 预算）
