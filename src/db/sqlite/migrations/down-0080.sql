-- down-0080.sql — no-op
--
-- SQLite DROP COLUMN 代价高（需要重表），且这些 lineage 字段默认值对老代码完全无害
-- （SELECT * 路径上仅多几列）。所以回滚保留 placeholder。
SELECT 1;
