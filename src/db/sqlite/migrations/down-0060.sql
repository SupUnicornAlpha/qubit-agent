-- 回滚脚本：手动执行（drizzle 自身不支持自动 down）。
-- 配套 0060_self_evolve_p4a_pnl_infra.sql。

DROP INDEX IF EXISTS `idx_fee_schedule_match`;
DROP TABLE IF EXISTS `fee_schedule`;

DROP INDEX IF EXISTS `idx_strategy_pnl_snapshot_symbol_day`;
DROP INDEX IF EXISTS `idx_strategy_pnl_snapshot_runtime_day`;
DROP INDEX IF EXISTS `idx_strategy_pnl_snapshot_unique`;
DROP TABLE IF EXISTS `strategy_pnl_snapshot`;

DROP INDEX IF EXISTS `idx_daily_mark_price_symbol_day`;
DROP INDEX IF EXISTS `idx_daily_mark_price_unique`;
DROP TABLE IF EXISTS `daily_mark_price`;
