-- 0078_consolidate_user_workspaces_part2.sql
--
-- 补刀 migration 0077。0077 包含 1 条 INSERT + 5 条 UPDATE + 1 条 DELETE，但因为
-- 缺少 drizzle 多语句分隔符注释，drizzle bun-sqlite migrator 把整个 .sql 文件整段
-- 交给 `bun:sqlite.prepare(sql).run()` —— 该 API 在多分号语句时**只跑第一条**，剩余
-- 语句被静默跳过（详见 0055 复盘）。
--
-- 结果：0077 只跑了第一条 `INSERT OR IGNORE INTO workspace(default)`，后续 reparent
-- + DELETE 全部没执行。drizzle 仍然把 0077 标记成 applied，无法 redo。
--
-- 修复策略：复制 0077 后续 statement，每条之间用 drizzle 识别的标记拆开（注意：本说明
-- 中刻意不把该字面标记写出来，避免被 drizzle migrator 当成真正分隔符把这段注释切走 ——
-- 0078 第一次提交即栽在此处，写"`-> statement-breakpoint`"被识别成分隔符后报
-- "Statement has finalized"）。所有 UPDATE/DELETE 严格 WHERE 筛行幂等，重跑 no-op。
--
-- 不动 0077.sql，避免 drizzle hash drift 阻塞启动。

-- Step 1: reparent chat_session
UPDATE chat_session
SET workspace_id = '00000000-0000-4000-8000-localuser0001'
WHERE workspace_id NOT IN (
  '00000000-0000-4000-8000-localuser0001',
  '00000000-0000-4000-8000-a2a000000003'
);
--> statement-breakpoint

-- Step 2: reparent project
UPDATE project
SET workspace_id = '00000000-0000-4000-8000-localuser0001'
WHERE workspace_id NOT IN (
  '00000000-0000-4000-8000-localuser0001',
  '00000000-0000-4000-8000-a2a000000003'
);
--> statement-breakpoint

-- Step 3: reparent agent_group
UPDATE agent_group
SET workspace_id = '00000000-0000-4000-8000-localuser0001'
WHERE workspace_id IS NOT NULL
  AND workspace_id NOT IN (
    '00000000-0000-4000-8000-localuser0001',
    '00000000-0000-4000-8000-a2a000000003'
  );
--> statement-breakpoint

-- Step 4: reparent scheduled_job
UPDATE scheduled_job
SET workspace_id = '00000000-0000-4000-8000-localuser0001'
WHERE workspace_id NOT IN (
  '00000000-0000-4000-8000-localuser0001',
  '00000000-0000-4000-8000-a2a000000003'
);
--> statement-breakpoint

-- Step 5: reparent mcp_catalog_install
UPDATE mcp_catalog_install
SET workspace_id = '00000000-0000-4000-8000-localuser0001'
WHERE workspace_id IS NOT NULL
  AND workspace_id NOT IN (
    '00000000-0000-4000-8000-localuser0001',
    '00000000-0000-4000-8000-a2a000000003'
  );
--> statement-breakpoint

-- Step 6: 删除空 workspace（保留 default + a2a）
DELETE FROM workspace
WHERE id NOT IN (
  '00000000-0000-4000-8000-localuser0001',
  '00000000-0000-4000-8000-a2a000000003'
);
