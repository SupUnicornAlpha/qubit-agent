---
description: >
  Kelly / 分数 Kelly 仓位：由胜率与盈亏比估 edge，给出 f* 与推荐 0.25–0.5x 分数。
  接 portfolio.construct / order.create_intent 前的 sizing 闸门。触发：Kelly、仓位、
  position size、下注比例。
roles: [research, risk]
tags: [sizing, kelly, risk, portfolio]
adaptedFrom: https://github.com/agiprolabs/claude-trading-skills/tree/main/skills/kelly-criterion
---

# Kelly 仓位 · 分数 Kelly

> 改编自 agiprolabs/claude-trading-skills · kelly-criterion；落地到 Qubit risk / portfolio 工具。

## 公式（二元）
```
f* = (p * b - q) / b
```
- `p` 胜率，`q = 1-p`，`b` = 平均盈利 / 平均亏损
- edge = `p*b - q`；edge ≤ 0 → **仓位为 0**

## 实务铁律
- **禁止 full Kelly**：估计误差会严重超额下注
- 默认 **0.25x–0.5x** Kelly；样本 <30 笔 → ≤0.10x 或不交易
- 过赌 2×f* 长期增长≈0；欠赌 0.5×f* 仍可保留约 75% 增长

| 分数 | 场景 |
|------|------|
| 0.10x | 新策略、样本稀缺 |
| 0.25x | 常规研究 → intent |
| 0.50x | ≥100 笔、稳定 Sharpe |
| 1.00x | 永不用于实盘 |

## 步骤

### 1. 估 p、b
- 回测或 live 成交日志：至少 50 笔（推荐 100+）
- `code.run_python` 算 win_rate、avg_win、avg_loss

### 2. 算 f* 与建议仓位
```python
f_star = (p * b - (1 - p)) / b
f_use = max(0.0, min(f_star * fraction, hard_cap))  # hard_cap 如 0.15 NAV
```

### 3. 与组合约束求交
- 先过 `quant:risk-concentration-var-checklist`
- `portfolio.construct`：单票/行业上限 ∩ Kelly 建议
- live：`order.create_intent` 绑定 thesis；sizing 写入 thesis 正文

## 输出
- 一段 thesis 附录：`p,b,f*,fraction,f_use,hard_cap`
- 拒绝条件清单（edge≤0 / 样本不足 / 与风控冲突）
