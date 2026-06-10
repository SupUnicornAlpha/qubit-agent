---
description: Piotroski F-Score 9 项财务质量评分法，把基本面健康度量化成 0-9 分，专门用于价值股质量过滤。适合 analyst_fundamental 在 deep value / 烟蒂股策略里剔除"价值陷阱"。触发关键词：Piotroski、F-Score、财务质量、价值陷阱。
roles: [analyst_fundamental, research]
tags: [fundamental, quality, screening]
---

# Piotroski F-Score 9 项财务质量

## 9 个二元指标（每项命中 +1）

### Profitability（4 项）
1. ROA（净利/总资产）> 0
2. Operating Cash Flow > 0
3. ROA 同比改善
4. OCF > Net Income（盈利质量：现金流支撑利润）

### Leverage / Liquidity（3 项）
5. Long-term Debt / Assets 同比下降
6. Current Ratio（流动比率）同比上升
7. 没增发股本（shares outstanding 同比 ≤）

### Operating Efficiency（2 项）
8. Gross Margin 同比上升
9. Asset Turnover（营收 / 总资产）同比上升

## 用法

### Step 1：拉财务数据
- 工具：`publicfinance.company_facts(ticker)` 取 XBRL 标准化指标（Revenue/NetIncome/Assets/CashFlow 等）
- 工具：`us-gov-open-data.sec.company_facts` 作 fallback
- 缺指标时：`investor-agent.get_stock_info` 兜底

### Step 2：算 9 项
对每项二元判定 → 累加得 F-Score（0-9）

### Step 3：筛选规则
- **价值 + 高质量**：P/B < 1.0 ∧ F-Score ≥ 7 → 高置信买入候选
- **价值陷阱排除**：P/B < 1.0 ∧ F-Score ≤ 3 → 警告，避免买入
- **质量改善**：F-Score 同比 +3 以上 → momentum-like 信号

### Step 4：落 factor + signal
- `factor.register({ name: "f_score_<as_of>", expr: "<DSL>", lang: "qlib_expr" })`
- `factor.compute({ factorId, symbols, asof })`
- `analyst_signal`：把当期 top/bottom 各 N 标的 + F-Score 详情写入

## 适用与不适用
- ✅ 美股大中盘有完整 XBRL 数据
- ✅ banking / insurance 行业要换专门版本（CAMELS、ROAE）
- ❌ 高成长股（云、生物科技）不合适——盈利质量未必体现
- ❌ A 股需先用同花顺/Wind 数据补 XBRL 缺失字段

## 输出
- factor 1 条
- analyst_signal 至少 3 条（top + bottom + watchlist）
