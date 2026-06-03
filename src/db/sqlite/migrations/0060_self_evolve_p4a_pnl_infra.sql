-- Self-Evolving Agent P4a — PnL 基础设施（详见 docs/SELF_EVOLVING_AGENT_DESIGN.md §P4a）
--
-- 背景：飞轮的"燃料"是真实 PnL。现状 fill.fee=0、无 daily_close 物化、
-- strategy_position_snapshot 不是时序快照、strategy_runtime 无 NAV 字段，
-- 导致 P4b 的 PnlAttributor worker 根本没有路面可跑。本期先铺设 3 张基础表：
--
--   1) daily_mark_price       — 物化各 market/symbol 的 EOD 收盘价，让 PnL
--                                跑批与 broker connector 解耦（跑批 ≠ 实时拉）。
--   2) strategy_pnl_snapshot  — 真正的时序日度 PnL 快照（runtime × symbol × day），
--                                带 realized/unrealized/cum/market_value/fee/turnover。
--   3) fee_schedule           — broker × market × asset_class × side 多维查表的
--                                内置费率表（fill.fee 现在全 0，全靠它兜底）。
--
-- 设计取舍：
--   - 选 1：表名/字段全部 v0 命名，所有外键 ON DELETE CASCADE 跟随 strategy_runtime
--          生命周期；fee_schedule 不挂任何 runtime，独立维度。
--   - 选 2：daily_mark_price 只存 EOD 单价，不存盘中分笔；intraday PnL 由 worker
--          实时 mark 不持久化。
--   - 选 3：fee_schedule 用 priority 字段做"通配 + 精确"两段命中（'*' 通配优先级低）；
--          种子默认覆盖 CN/US/HK/CRYPTO 主流。
--   - 选 4：strategy_pnl_snapshot 一行 = (runtime, day, symbol)；NAV 维度（不分
--          symbol 汇总）由 worker 在 read 时 GROUP BY 算出，避免双源真相。
--
-- 兼容性：3 张表均新增；旧 fill / broker_order / order_intent / strategy_runtime
-- 不动。回滚见 down-0060.sql。

-- ───────────────────────── daily_mark_price ─────────────────────────
CREATE TABLE IF NOT EXISTS `daily_mark_price` (
  `id` TEXT PRIMARY KEY NOT NULL,
  -- CN | US | HK | CRYPTO，与 trading_account.market_scope / strategy_runtime.market 对齐
  `market` TEXT NOT NULL,
  `symbol` TEXT NOT NULL,
  -- ISO date 'YYYY-MM-DD'（按 market 本地交易日，CN=Asia/Shanghai 等）
  `trading_day` TEXT NOT NULL,
  `close` REAL NOT NULL,
  `open` REAL,
  `high` REAL,
  `low` REAL,
  `volume` REAL,
  -- klines data source meta：'eastmoney' / 'yfinance' / 'yahoo_chart' /
  -- 'tushare_daily' / 'akshare' / 'binance_crypto' / 'synthetic'
  `source` TEXT NOT NULL,
  `fetched_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

-- 唯一键：同一 market+symbol+day 不重复（fetcher upsert 走它）
CREATE UNIQUE INDEX IF NOT EXISTS `idx_daily_mark_price_unique`
  ON `daily_mark_price` (`market`, `symbol`, `trading_day`);
--> statement-breakpoint
-- 反查索引：PnL worker 按 symbol + day 范围扫
CREATE INDEX IF NOT EXISTS `idx_daily_mark_price_symbol_day`
  ON `daily_mark_price` (`symbol`, `trading_day`);
--> statement-breakpoint

-- ───────────────────────── strategy_pnl_snapshot ─────────────────────────
CREATE TABLE IF NOT EXISTS `strategy_pnl_snapshot` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `strategy_runtime_id` TEXT NOT NULL
    REFERENCES `strategy_runtime`(`id`) ON DELETE CASCADE,
  -- ISO date 'YYYY-MM-DD'
  `trading_day` TEXT NOT NULL,
  `symbol` TEXT NOT NULL,
  -- 当日收盘持仓数量（含未平仓）
  `qty` REAL NOT NULL DEFAULT 0,
  -- 移动平均成本（FIFO 简化）；qty=0 时为 null
  `avg_cost` REAL,
  -- 当日 mark：取 daily_mark_price.close；查不到时由 last_fill.fill_price 回退
  `mark_price` REAL,
  -- qty * mark_price
  `market_value` REAL NOT NULL DEFAULT 0,
  -- 当日已实现 PnL（卖出对应的成本差）
  `realized_pnl_daily` REAL NOT NULL DEFAULT 0,
  -- 当日未实现 PnL = (mark - avg_cost) * qty（持仓部分）
  `unrealized_pnl_daily` REAL NOT NULL DEFAULT 0,
  -- 累计已实现（建仓以来）
  `realized_pnl_cum` REAL NOT NULL DEFAULT 0,
  -- 累计未实现（=当前 unrealized；为方便 reader）
  `unrealized_pnl_cum` REAL NOT NULL DEFAULT 0,
  -- 当日手续费（fee_schedule 估算）
  `fee_daily` REAL NOT NULL DEFAULT 0,
  `fee_cum` REAL NOT NULL DEFAULT 0,
  -- 当日成交额（买卖绝对值之和 * fill_price）
  `turnover_daily` REAL NOT NULL DEFAULT 0,
  -- 'pnl_attributor_v0'；后续算法升级后改 v1/v2
  `source` TEXT NOT NULL,
  -- 自由附加：mark_source / partial_data_flag / fill_count 等
  `metadata_json` TEXT NOT NULL DEFAULT '{}',
  `computed_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

-- 唯一键：同 (runtime, day, symbol) 一行；worker 重跑走 upsert
CREATE UNIQUE INDEX IF NOT EXISTS `idx_strategy_pnl_snapshot_unique`
  ON `strategy_pnl_snapshot` (`strategy_runtime_id`, `trading_day`, `symbol`);
--> statement-breakpoint
-- 按 runtime + 时间范围扫（NAV 视图）
CREATE INDEX IF NOT EXISTS `idx_strategy_pnl_snapshot_runtime_day`
  ON `strategy_pnl_snapshot` (`strategy_runtime_id`, `trading_day`);
--> statement-breakpoint
-- 按 symbol + 时间范围扫（symbol 维度对账）
CREATE INDEX IF NOT EXISTS `idx_strategy_pnl_snapshot_symbol_day`
  ON `strategy_pnl_snapshot` (`symbol`, `trading_day`);
--> statement-breakpoint

-- ───────────────────────── fee_schedule ─────────────────────────
CREATE TABLE IF NOT EXISTS `fee_schedule` (
  `id` TEXT PRIMARY KEY NOT NULL,
  -- 'paper' | 'futu' | 'ib' | 'ccxt' | '*' 通配
  `broker` TEXT NOT NULL,
  -- 'CN' | 'US' | 'HK' | 'CRYPTO' | '*'
  `market` TEXT NOT NULL,
  -- 'stock' | 'crypto' | 'future' | 'option' | '*'
  `asset_class` TEXT NOT NULL,
  -- 'buy' | 'sell' | '*'
  `side` TEXT NOT NULL,
  -- 比例 commission：e.g. 0.00025 = 万 2.5
  `commission_rate` REAL NOT NULL DEFAULT 0,
  -- 最低收费（绝对值，本币单位）
  `commission_min` REAL NOT NULL DEFAULT 0,
  -- 印花税（CN A 股卖出 0.0005、HK 股 0.0013 等）
  `stamp_duty_rate` REAL NOT NULL DEFAULT 0,
  -- 过户费 / SEC fee / TAF 等其他
  `transfer_fee_rate` REAL NOT NULL DEFAULT 0,
  `enabled` INTEGER NOT NULL DEFAULT 1,
  -- 命中优先级（越大越优先）；精确匹配设 100，通配 '*' 设 10
  `priority` INTEGER NOT NULL DEFAULT 0,
  `effective_from` TEXT NOT NULL,
  -- null = 一直有效
  `effective_to` TEXT,
  `metadata_json` TEXT NOT NULL DEFAULT '{}',
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

-- 命中索引：worker 按 (broker, market, asset_class, side) 查 enabled 最高 priority
CREATE INDEX IF NOT EXISTS `idx_fee_schedule_match`
  ON `fee_schedule` (`broker`, `market`, `asset_class`, `side`, `enabled`, `priority`);
--> statement-breakpoint

-- ───────────────────────── seed 默认费率 ─────────────────────────
-- CN A 股：买万 2.5 + 卖万 2.5 + 卖印花税千一 + 双边过户费十万 2（沪市）
INSERT OR IGNORE INTO `fee_schedule` (
  `id`, `broker`, `market`, `asset_class`, `side`,
  `commission_rate`, `commission_min`, `stamp_duty_rate`, `transfer_fee_rate`,
  `priority`, `effective_from`
) VALUES
  ('fee_seed_cn_buy_v1',  '*', 'CN', 'stock', 'buy',  0.00025, 5.0, 0.0,    0.00002, 10, '2024-01-01'),
  ('fee_seed_cn_sell_v1', '*', 'CN', 'stock', 'sell', 0.00025, 5.0, 0.001,  0.00002, 10, '2024-01-01'),
  ('fee_seed_us_buy_v1',  '*', 'US', 'stock', 'buy',  0.0001,  0.0, 0.0,    0.0,     10, '2024-01-01'),
  ('fee_seed_us_sell_v1', '*', 'US', 'stock', 'sell', 0.0001,  0.0, 0.0,    0.0,     10, '2024-01-01'),
  ('fee_seed_hk_buy_v1',  '*', 'HK', 'stock', 'buy',  0.001,   0.0, 0.0,    0.00002, 10, '2024-01-01'),
  ('fee_seed_hk_sell_v1', '*', 'HK', 'stock', 'sell', 0.001,   0.0, 0.0013, 0.00002, 10, '2024-01-01'),
  ('fee_seed_crypto_v1',  '*', 'CRYPTO', 'crypto', '*', 0.001, 0.0, 0.0,    0.0,     10, '2024-01-01'),
  -- paper broker 兜底零费率（便于回测/单测）
  ('fee_seed_paper_v1',   'paper', '*', '*', '*',     0.0,     0.0, 0.0,    0.0,    100, '2024-01-01');
