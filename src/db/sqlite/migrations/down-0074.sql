-- 回滚 0074：移除 agent_definition.user_overrides_json
--
-- 与 down-0073 同样的取舍：SQLite 不直接支持 DROP COLUMN，需要 CREATE 新表 →
-- 复制数据 → 删旧表 → 重命名。本字段对老代码完全无害（多读一列零成本），所以
-- 工程上更稳的回滚是 no-op，保留列。需要彻底回滚时用 recreate-table 流程手工做。

SELECT 1;
