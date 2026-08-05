-- down-0105: drop agent_definition.execution_kind
-- SQLite < 3.35 无 DROP COLUMN 时需重建表；本仓库迁移期使用较新 SQLite。
ALTER TABLE `agent_definition` DROP COLUMN `execution_kind`;
