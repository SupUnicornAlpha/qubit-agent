---
description: 新闻 / 公告事件情绪分级 + 影响半衰期估计，把非结构化新闻转成 -1/0/+1/+2 分级 signal。覆盖财报、并购、内部人交易、监管处罚、产品事件五类。适合 analyst_sentiment / news_event 做事件驱动信号。触发关键词：新闻情绪、event impact、analyze_news、并购、财报评论、监管处罚。
roles: [analyst_sentiment, news_event, research]
tags: [event-driven, sentiment, news]
---

# 新闻 / 事件情绪分级

## 输入
- 标的或主题
- 时间窗口（默认近 24h）

## 计算步骤

### Step 1：拉新闻
- 工具：`investor-agent.get_stock_info` 含最新 news 字段 ← 首选
- 工具：`qubit-news/fetch_news_sentiment(symbol)` 内置 connector
- 备用：`publicfinance.company_filings(ticker, formType="8-K")` 拉 SEC 8-K 重大事件
- 备用：`us-gov-open-data.sec.filings_list(ticker)`

### Step 2：事件分类（五类标签）
- **earnings_surprise**：财报 actual vs estimate 差 ≥ 5%
- **ma_announcement**：并购 / 拆分 / 私有化
- **insider_trade**：Form 4 内部人大额交易（≥ $1M）
- **regulatory_event**：罚款 / 召回 / 反垄断
- **product_news**：新产品 / 客户合同 / 专利

### Step 3：情绪分级
| 等级 | 含义 | 触发条件示例 |
|---|---|---|
| +2 | 强利好 | 财报大超 + guidance 上调；战略性并购溢价 ≥ 25% |
| +1 | 利好 | 财报小超；正面分析师上调；新产品发布 |
| 0 | 中性 | 一般性公告、业务展望维持 |
| -1 | 利空 | 财报 miss；高管离职；guidance 下调 |
| -2 | 强利空 | 大型监管处罚；做空报告引发 panic；财报严重 miss + 估值崩塌 |

### Step 4：影响半衰期
- earnings_surprise：T+1 ~ T+60（与 PEAD skill 关联）
- ma_announcement：T+1 即定价完成（折价 5-15% 反映成交风险）
- insider_trade：T+5 ~ T+30（学术：内部人小型增持 +1.5% / 月）
- regulatory_event：T+1 ~ T+10
- product_news：T+1 ~ T+5

### Step 5：写 signal
- `analyst_signal({ symbol, signalType: "event", direction: "+2", validUntil: "...", rationale })`
- 多条新闻 → 取最高优先级 + 合并 rationale

## 风险提示
- 单条 headline 不可靠：必须看 ≥ 2 个 source 交叉验证
- "rumor"、"speculation"、"may"、"reports" 等词降级 1 等
- 财报后 24h 内的卖方研报往往滞后 / 一致跟风，谨慎过度加权

## 输出
- analyst_signal ≥ 1 条（含事件类型 + 情绪分级 + 半衰期 + sources）
