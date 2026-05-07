-- V2 TradingAgent migration: extend agent roles, add MSA tables
-- Add signal_weight to agent_definition
ALTER TABLE agent_definition ADD COLUMN signal_weight REAL NOT NULL DEFAULT 1.0;
--> statement-breakpoint
-- Add signal_fusion_id to workflow_run
ALTER TABLE workflow_run ADD COLUMN signal_fusion_id TEXT;
--> statement-breakpoint
-- Agent role catalog
CREATE TABLE IF NOT EXISTS agent_role_catalog (
  role TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  default_prompt_template TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT 'ops',
  is_builtin INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
-- Analyst signal table (MSA)
CREATE TABLE IF NOT EXISTS analyst_signal (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id),
  agent_instance_id TEXT REFERENCES agent_instance(id),
  analyst_role TEXT NOT NULL,
  ticker TEXT NOT NULL,
  signal TEXT NOT NULL CHECK(signal IN ('buy','sell','hold')),
  confidence REAL NOT NULL DEFAULT 0.5,
  reasoning TEXT NOT NULL DEFAULT '',
  data_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
-- Signal fusion result table (MSA)
CREATE TABLE IF NOT EXISTS signal_fusion_result (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id),
  ticker TEXT NOT NULL,
  fused_signal TEXT NOT NULL CHECK(fused_signal IN ('buy','sell','hold')),
  fused_confidence REAL NOT NULL DEFAULT 0.5,
  weights_json TEXT NOT NULL DEFAULT '{}',
  debate_triggered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
-- Analyst accuracy log for dynamic weight adjustment
CREATE TABLE IF NOT EXISTS analyst_accuracy_log (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES agent_definition(id),
  ticker TEXT NOT NULL,
  signal_date INTEGER NOT NULL,
  predicted_signal TEXT NOT NULL CHECK(predicted_signal IN ('buy','sell','hold')),
  actual_outcome TEXT CHECK(actual_outcome IN ('up','down','flat')),
  is_correct INTEGER,
  evaluated_at INTEGER
);
--> statement-breakpoint
-- Seed V2 role catalog
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
--> statement-breakpoint
-- Indexes for MSA tables
CREATE INDEX IF NOT EXISTS idx_analyst_signal_workflow ON analyst_signal(workflow_run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_analyst_signal_ticker ON analyst_signal(ticker, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_signal_fusion_workflow ON signal_fusion_result(workflow_run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_accuracy_definition ON analyst_accuracy_log(definition_id, ticker);
