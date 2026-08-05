---
description: >
  Walk-forward / purged CV：拒绝随机 k-fold 在金融时序上的偷看偏差；滚动/扩展窗、
  purge+embargo、过拟合诊断。触发：walk-forward、样本外、过拟合、CPCV、时序交叉验证。
roles: [backtest, research]
tags: [backtest, validation, overfitting, walk-forward]
adaptedFrom: https://github.com/agiprolabs/claude-trading-skills/tree/main/skills/walk-forward-validation
---

# Walk-Forward 与时序校验

> 改编自 agiprolabs/claude-trading-skills · walk-forward-validation；与
> `quant:backtest-leakage-self-check` 互补（泄漏自检 vs 验证框架）。

## 为什么不能用普通 CV
1. 随机折让测试「看见未来」
2. 相邻 bar 自相关 → 泄漏
3. regime 依赖：牛市训 / 牛市测无意义
4. 标签窗重叠（如 5 日前瞻收益）

## 框架

### Rolling（固定训练窗）
```
[===TRAIN===][=TEST=]
   [===TRAIN===][=TEST=]
```
适合加密/快速失效因子。

### Expanding（训练窗增长）
```
[==TRAIN==][=TEST=]
[====TRAIN====][=TEST=]
```
样本稀缺时优先。

### Purge + Embargo
- **Purge**：删掉标签窗碰到测试期的训练样本
- **Embargo**：训练结束与测试开始之间留空窗（日线常 2–5 日；≥ 2× 标签 horizon）

## 步骤
1. 明确标签 horizon 与特征窗，写入 thesis
2. `code.run_python` 实现 rolling/expanding；报告每折 Sharpe / 最大回撤 / 换手
3. 汇总：**OOS 均值 vs IS**；若 OOS ≪ IS → 疑过拟合，拒绝上线
4. 可选 CPCV（Lopez de Prado）：多路径测试，看策略是否「路径敏感」
5. 与 `quant:backtest-leakage-self-check` 串联后再 `research.thesis.write`

## 输出
- 折表（日期、IS/OOS 指标）
- 过拟合判定：pass / fail + 理由
