-- Rollback Schema 收敛 C9（详见 0068_drop_agent_role_catalog.sql）

CREATE TABLE IF NOT EXISTS agent_role_catalog (
  role TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  default_prompt_template TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT 'ops',
  is_builtin INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
INSERT OR IGNORE INTO agent_role_catalog (role, display_name, description, team) VALUES
  ('orchestrator', '基金经理', '工作流编排与辩论主持', 'ops'),
  ('analyst_fundamental', '基本面研究员', '财报、估值、行业分析', 'analyst'),
  ('analyst_technical', '量化策略师', 'K线、指标、形态分析', 'analyst'),
  ('analyst_sentiment', '舆情分析师', '新闻、社媒情绪分析', 'analyst'),
  ('analyst_macro', '宏观策略师', '宏观经济与政策面分析', 'analyst'),
  ('researcher_bull', '多方研究员', '多方论据汇总与推演', 'researcher'),
  ('researcher_bear', '空方研究员', '空方风险论据汇总', 'researcher'),
  ('risk_manager', '风控主管', '风控规则裁决与一票否决', 'risk'),
  ('portfolio_manager', '组合经理', '仓位管理与资产配置', 'portfolio'),
  ('stock_screener', '量化选股助手', '条件过滤与综合评分', 'research'),
  ('backtest_engineer', '量化工程师', '策略回测与绩效评估', 'research'),
  ('execution_trader', '交易员', '订单拆分与择时下单', 'execution'),
  ('memory_curator', '知识管理员', '研究成果归档与知识库维护', 'ops'),
  ('market_data', '行情数据员', '市场数据采集与快照', 'ops'),
  ('news_event', '事件追踪员', '新闻事件采集与提取', 'ops'),
  ('research', '研究员', '因子研究与策略迭代', 'research'),
  ('backtest', '回测工程师', '历史回测执行', 'research'),
  ('simulation', '模拟交易员', 'Paper Trading 验证', 'execution'),
  ('risk', '风控员', '订单意图风控评估', 'risk'),
  ('execution', '执行员', '订单路由与经纪商接入', 'execution'),
  ('memory', '记忆管理员', '记忆读写与 TTL 清理', 'ops'),
  ('audit', '审计员', '全链路审计与报告', 'ops');
