-- 0077_consolidate_user_workspaces.sql
--
-- 2026-06-05 单租户 workspace 收口（详见 src/runtime/bootstrap/ensure-default-workspace.ts）。
--
-- 背景：前端 3 处 boot 各自有一段 `if (!workspaces[0]) createWorkspace(owner:"local-user")` 兜底，
-- 因为 A2A Pool（owner=system）永远占着 workspaces[0]，那段兜底**从未触发** —— 桌面用户上车
-- 默认用了 system workspace，所有 workflow 错挂到 `A2A Pool Project` 下；叠加 22 个单测把
-- `db.insert(workspace).values({owner:'test'/'t'/'tester'})` 直接打到 prod DB，加上旧 eval 脚本
-- `createWorkspace({name:'eval-batch-3-${Date.now()}'})` 每跑必新建，最终积出 26 个 workspace ×
-- 26 个 project（基本 1:1，没起到"单租户多 project"层级语义）。
--
-- 本次收口（运行时已配套修复）：
--   1. 后端 ensureDefaultUserWorkspace() 在 bootstrap 期 INSERT OR IGNORE 一个稳定 ID 的 default
--      workspace（DEFAULT_USER_WORKSPACE_ID = '00000000-0000-4000-8000-localuser0001'）。
--   2. 后端 `GET /api/v1/workspaces/default` 端点返回该 workspace。
--   3. 前端 4 处 boot 改成 `getDefaultWorkspace()`；删掉 createWorkspace 兜底。
--   4. eval 脚本改成 `GET /workspaces/default + ensure project by name`，不再每跑都 createWorkspace。
--
-- 本 migration 做数据侧收口：
--   a) ensure default workspace 存在（与运行时双保险，迁移先于 ensure 跑也 OK）。
--   b) 把所有用户 chat_session / project / agent_group / scheduled_job / mcp_catalog_install
--      reparent 到 default workspace（除了 a2a-pool 系统 workspace 下的实体）。
--   c) 删除全部空 workspace（除了 default + a2a-pool）。
--
-- ⚠️ 注意：**不删 project**，因为部分 0-workflow 的 test 残留 project 下挂着 factor_definition /
--    strategy / agent_skill / rule_definition 等业务数据（sc-proj 11 factor、fs-proj 10 factor、
--    skill_proj 4 skill 等）。这些可能是 dev 测试时无意产物，但保守起见保留，让用户在 UI 上自己
--    决定要 archive 哪些（project.status='archived'）。完整 cleanup 留给后续手动迁移。
--
-- ⚠️ 不可回滚：down-0077.sql 只能 DELETE 掉 default workspace（如果你重跑 0077 又删它），
--    无法把原 25 个 workspace + 它们的 name/owner/created_at 复原。本次清理是单向的。

-- ─── Step 0: 确保 default workspace 存在 ─────────────────────────────────────
INSERT OR IGNORE INTO workspace (id, name, owner)
VALUES ('00000000-0000-4000-8000-localuser0001', 'Default Workspace', 'local-user');

-- ─── Step 1: reparent chat_session ──────────────────────────────────────────
UPDATE chat_session
SET workspace_id = '00000000-0000-4000-8000-localuser0001'
WHERE workspace_id NOT IN (
  '00000000-0000-4000-8000-localuser0001',
  '00000000-0000-4000-8000-a2a000000003'
);

-- ─── Step 2: reparent project ───────────────────────────────────────────────
UPDATE project
SET workspace_id = '00000000-0000-4000-8000-localuser0001'
WHERE workspace_id NOT IN (
  '00000000-0000-4000-8000-localuser0001',
  '00000000-0000-4000-8000-a2a000000003'
);

-- ─── Step 3: reparent agent_group（workspace_id 可空，仅迁非空且非 default/a2a）──
UPDATE agent_group
SET workspace_id = '00000000-0000-4000-8000-localuser0001'
WHERE workspace_id IS NOT NULL
  AND workspace_id NOT IN (
    '00000000-0000-4000-8000-localuser0001',
    '00000000-0000-4000-8000-a2a000000003'
  );

-- ─── Step 4: reparent scheduled_job ─────────────────────────────────────────
UPDATE scheduled_job
SET workspace_id = '00000000-0000-4000-8000-localuser0001'
WHERE workspace_id NOT IN (
  '00000000-0000-4000-8000-localuser0001',
  '00000000-0000-4000-8000-a2a000000003'
);

-- ─── Step 5: reparent mcp_catalog_install（workspace_id 可空）────────────────
UPDATE mcp_catalog_install
SET workspace_id = '00000000-0000-4000-8000-localuser0001'
WHERE workspace_id IS NOT NULL
  AND workspace_id NOT IN (
    '00000000-0000-4000-8000-localuser0001',
    '00000000-0000-4000-8000-a2a000000003'
  );

-- ─── Step 6: 删除清空后的 workspace（保留 default + a2a）─────────────────────
-- 此时所有非系统 workspace 下都已经没有任何引用（上面 5 个 reparent 完成），可以安全删。
DELETE FROM workspace
WHERE id NOT IN (
  '00000000-0000-4000-8000-localuser0001',
  '00000000-0000-4000-8000-a2a000000003'
);
