-- 回滚脚本：手动执行（drizzle 自身不支持自动 down）。配套 0077_consolidate_user_workspaces.sql。
--
-- ⚠️ 0077 是数据收口性单向迁移：把 25 个脏 workspace 下的实体全部 reparent 到 default workspace
-- 后删掉原 workspace。**原 workspace 的 id / name / owner / created_at 无法复原**，down 也无法
-- 把已经迁过来的 project / chat_session 重新关联回它们原来的 workspace（mapping 丢了）。
--
-- 本 down 脚本仅能做的事：
--   - 删掉 0077 创建的 default workspace（前提：当前没有任何实体 reference 它，否则会 FK 违约）。
--
-- 想要真正回滚 0077，唯一方式是从 0077 执行前的备份恢复 core.sqlite。

DELETE FROM workspace
WHERE id = '00000000-0000-4000-8000-localuser0001'
  AND NOT EXISTS (SELECT 1 FROM project WHERE workspace_id = '00000000-0000-4000-8000-localuser0001')
  AND NOT EXISTS (SELECT 1 FROM chat_session WHERE workspace_id = '00000000-0000-4000-8000-localuser0001')
  AND NOT EXISTS (SELECT 1 FROM agent_group WHERE workspace_id = '00000000-0000-4000-8000-localuser0001')
  AND NOT EXISTS (SELECT 1 FROM scheduled_job WHERE workspace_id = '00000000-0000-4000-8000-localuser0001')
  AND NOT EXISTS (SELECT 1 FROM mcp_catalog_install WHERE workspace_id = '00000000-0000-4000-8000-localuser0001');
