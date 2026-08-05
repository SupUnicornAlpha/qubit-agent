---
description: >
  用 qlib_expr 注册 MACD、KDJ 近似与量价/买卖量因子（非口头描述）。
  适合 research / analyst_technical / orchestrator 在因子挖掘轮次补齐技术面与成交量族。
  触发关键词：MACD、KDJ、量价、买卖量、technical factor、factor.register。
roles: [research, analyst_technical, orchestrator]
tags: [technical, macd, kdj, volume, factor, alpha]
---

# MACD / KDJ / 量价因子（必须落库）

只做「口头因子表」不算完成。每轮至少 `factor.register` 成功 ≥1 条，优先覆盖技术 + 量价，不要整轮只有 `close/Ref/Std` 动量。

## 工具名（点号，禁止下划线假名）

- 正确：`factor.register` / `factor.compute` / `factor.autoEvaluate` / `factor.mine.llm` / `factor.list`
- 错误：`factor_register` / `factor_compute` / `factor_autoEvaluate`（不存在，写进 gaps 会被判失败）

参数**平铺**在工具 args 顶层（`name` / `expr` / `category` / `lang`），不要再包一层 `arguments: { ... }`。`project_id` 通常由 runtime 注入，可省略。

## 推荐表达式（lang=`qlib_expr`）

算子白名单含：`Ref Mean Std Sum Max Min Rank Corr Delta Abs Log EMA Slope Sign IfPos`。

### 1) MACD 族（category=`momentum` 或自建 technical）

```text
# DIF
EMA(close, 12) - EMA(close, 26)

# 柱线方向（离散）
Sign(EMA(close, 12) - EMA(close, 26))

# 短长 EMA 差相对波动
(EMA(close, 12) - EMA(close, 26)) / (Std(close, 26) + 1e-8)
```

### 2) KDJ / 随机指标近似（category=`reversal`）

```text
# RSV(9)
(close - Min(low, 9)) / (Max(high, 9) - Min(low, 9) + 1e-8)

# K 近似：RSV 平滑
Mean((close - Min(low, 9)) / (Max(high, 9) - Min(low, 9) + 1e-8), 3)

# J 风格极端：3K - 2D 的简化用 Slope 代理超买超卖
Slope((close - Min(low, 9)) / (Max(high, 9) - Min(low, 9) + 1e-8), 5)
```

### 3) 量价 / 买卖量代理（category=`volatility` 或 volume 语义）

```text
# 相对成交量
volume / Mean(volume, 20)

# 量价相关
Corr(volume, Abs(Delta(close, 1)), 20)

# 上涨日成交量占比（买卖量不平衡代理）
Sum(IfPos(Delta(close, 1), volume, 0), 20) / (Sum(volume, 20) + 1e-8)

# 放量突破
(close / Ref(close, 5) - 1) * (volume / Mean(volume, 20))
```

## 最小闭环

1. `factor.register({ name, category, expr, lang: "qlib_expr", dry_run: false })` → 拿 `factor_id`
2. `factor.compute({ factor_id, symbols, start_date, end_date })`
3. `factor.autoEvaluate({ factor_id, symbols, start_date, end_date, horizon_days: 5 })`

批量：`factor.mine.llm` 必须传 `expressions: string[]`（≥5）、`symbols`、`start_date`、`end_date`——不要只传 `task`/`targets`。

## 禁止

- 用 MCP `technical_indicator` 算出 MACD 后只写在聊天里，不 `factor.register`
- 整轮只有 mom / 乖离 / 波动率比，却在终答宣称「已创建技术因子」
- 把工具缺口写成终答主结论（`forbid_gap_as_final_answer`）
