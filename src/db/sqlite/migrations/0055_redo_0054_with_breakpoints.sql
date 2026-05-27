-- 补刀 migration 0054。
--
-- 原因：drizzle bun-sqlite migrator 把 .sql 文件按 statement breakpoint 注释
-- 分割后整段交给 bun:sqlite 的 prepare(sql).run()。而 bun:sqlite 的
-- prepare(sql).run() 在 SQL 含多个分号分割语句时只跑第一条，剩余语句被静默
-- 跳过，run() 仍返回成功 —— drizzle 把这个 migration 标记为 applied 并写进
-- __drizzle_migrations，但 7 条 UPDATE 里只有第一条真正执行过。
--
-- 在我（jiajun）的本地生产 db 上抽查时发现：
--   - agent_definition.system_prompt 里仍有 2 条 mcp-financex 残留
--   - analyst_signal 里 12 条历史 hold@0.4 + rawResponse 行没有被标 stale
-- 也就是 0054 的 1.b ~ 2 都没跑。手动用 sqlite3 单条执行后立刻清干净，
-- 证实 SQL 没问题，是分号多语句被截断。
--
-- 修复策略（不动 0054 文件，避免 drizzle hash drift）：
--   - 新增 0055，含和 0054 同样的 6 条 UPDATE（1.a 已经跑过，跳过它无伤大雅）
--   - 用 statement breakpoint 注释把每条 UPDATE 拆成独立 statement，让
--     drizzle migrator 一条一条 prepare/run
--   - 所有 UPDATE 都是幂等的（严格 WHERE 筛行，重跑不会双写），所以已经手动
--     修干净的 db 上再跑一遍仍是 no-op
--
-- 长期：以后写多语句 in-place 数据修复 migration 时，必须在每条 SQL 后写
-- statement breakpoint 注释（drizzle 识别的那个标记），否则 drizzle 只跑第一条。
-- 注意：本说明中刻意不把那个字面标记写出来，避免被 drizzle migrator 当成
-- 真正的分隔符把这段注释切走（0055 第一次提交即栽在此处）。

-- ─── Step 1.b: "mathjs / mcp-financex" → "mathjs"
UPDATE agent_definition
SET system_prompt = REPLACE(system_prompt, 'mathjs / mcp-financex', 'mathjs')
WHERE system_prompt LIKE '%mathjs / mcp-financex%';
--> statement-breakpoint

-- ─── Step 1.c: "（mathjs、mcp-financex" → "（mathjs"
UPDATE agent_definition
SET system_prompt = REPLACE(system_prompt, '（mathjs、mcp-financex', '（mathjs')
WHERE system_prompt LIKE '%（mathjs、mcp-financex%';
--> statement-breakpoint

-- ─── Step 1.d: "mcp-financex 等" → "已注册启用的 MCP server"
UPDATE agent_definition
SET system_prompt = REPLACE(
  system_prompt,
  'mcp-financex 等',
  '已注册启用的 MCP server'
)
WHERE system_prompt LIKE '%mcp-financex 等%';
--> statement-breakpoint

-- ─── Step 1.e: 兜底剩下的孤零零 "mcp-financex" → "已注册启用的 MCP server"
UPDATE agent_definition
SET system_prompt = REPLACE(system_prompt, 'mcp-financex', '已注册启用的 MCP server')
WHERE system_prompt LIKE '%mcp-financex%';
--> statement-breakpoint

-- ─── Step 2: 标记历史塌缩 hold@0.4 信号
UPDATE analyst_signal
SET data_snapshot_json = json_patch(
  COALESCE(data_snapshot_json, '{}'),
  json_object(
    'parseFailed', json('true'),
    'parseFailedAt', '2026-05-27',
    'parseFailedNote', 'legacy hold@0.4 fallback (pre-6cb35cb); ignore in stats'
  )
)
WHERE
  signal = 'hold'
  AND confidence = 0.4
  AND json_extract(COALESCE(data_snapshot_json, '{}'), '$.rawResponse') IS NOT NULL
  AND json_extract(COALESCE(data_snapshot_json, '{}'), '$.parseFailed') IS NULL;
