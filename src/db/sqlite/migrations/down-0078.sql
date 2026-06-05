-- 回滚脚本：手动执行（drizzle 自身不支持自动 down）。配套 0078_consolidate_user_workspaces_part2.sql。
-- 0078 同 0077 一样是数据单向收口，down 无法复原被删的 25 个 workspace + 原 reparent 关系。
-- 想真正回滚 → 从执行前的 core.sqlite.bak 备份恢复。本文件留作 placeholder。
SELECT 'no-op: 0078 is a one-way data cleanup; restore from db backup if needed';
