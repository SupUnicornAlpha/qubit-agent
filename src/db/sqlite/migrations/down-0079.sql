-- down-0079.sql — no-op
--
-- SQLite DROP COLUMN 需要重表，代价高且本字段对老代码无害（SELECT * 路径上仅多一列）。
-- 因此回滚不实际删列，仅保留 placeholder。
SELECT 1;
