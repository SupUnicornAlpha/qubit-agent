-- 回滚 0073：删除 agent_group.pipeline_kind / agent_definition.outputs_json
--
-- SQLite 不支持 DROP COLUMN 直接做，需要 CREATE 新表 → 复制数据 → 删旧表 → 重命名。
-- 但因 Phase A 没有任何代码读这两列、default 值都是中性，工程上更稳的回滚是
-- **保留列**让旧代码无感（多读一列零成本）。本文件保留为 no-op，必要时用
-- recreate-table 流程手工 rollback。

SELECT 1;
