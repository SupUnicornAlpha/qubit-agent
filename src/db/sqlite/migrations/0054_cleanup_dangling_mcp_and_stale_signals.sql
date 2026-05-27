-- 监控复盘 #2 落表数据清洗（与 6cb35cb runtime 修复配套）：
--
-- 1) agent_definition.system_prompt 里历史 seed 写死的 `mcp-financex` 名称
--    原文是 "调 MCP（fsi-factset / mathjs / mcp-financex）做精确计算" 等示例，
--    导致 LLM 凭印象 call_mcp 一个根本没注册的 server，100% 失败浪费 reason。
--    runtime 的 buildAgentToolsPromptBlock 已注入"未启用 server 一律 not found"
--    强约束（commit 6cb35cb），但 prompt 自身仍含这个名字会让模型 attention 抓到。
--    这里把 prompt 里所有 `mcp-financex` 从分隔符列表中剔除，仅保留 fsi-factset /
--    mathjs 这两类**可能**真实启用的 server。
--
-- 2) 历史 21+ 条 analyst_signal 因为旧 parseJsonSignalFromText 把"LLM 没输出 JSON"
--    一律塌缩为 hold@0.4，全表"分析师永远 0.4 hold"污染下游 fusion + 辩论。
--    现已不再产生（commit 6cb35cb 改成 missing_signal 不入库），但老数据需要标
--    `parse_failed=true` 让 UI 与统计能跳过这些假信号。
--    判定条件：signal='hold' AND confidence=0.4 AND data_snapshot_json 没 rawResponse
--    （旧代码兜底时只塞了 rawResponse=text，但 confidence=0.4 的真实 hold 极少见）。
--    保守起见：仅当 reasoning 是 LLM 原文 prefix（不是模型规范化的内容）时再标记。
--
-- 设计原则：
--   - 只 in-place UPDATE，不 DELETE：保留历史可追溯
--   - 用 json_patch / replace 字符串两种安全方式
--   - 每条 UPDATE 加 WHERE 严格筛行，幂等，重跑不会反复改写

-- ─── Step 1: agent_definition.system_prompt 清洗 ─────────────────────────────
-- 1.a 把 "fsi-factset / mathjs / mcp-financex" → "fsi-factset / mathjs"
UPDATE agent_definition
SET system_prompt = REPLACE(
  system_prompt,
  'fsi-factset / mathjs / mcp-financex',
  'fsi-factset / mathjs'
)
WHERE system_prompt LIKE '%fsi-factset / mathjs / mcp-financex%';

-- 1.b 把 "mathjs / mcp-financex" → "mathjs"
UPDATE agent_definition
SET system_prompt = REPLACE(system_prompt, 'mathjs / mcp-financex', 'mathjs')
WHERE system_prompt LIKE '%mathjs / mcp-financex%';

-- 1.c 把 "（mathjs、mcp-financex" → "（mathjs"
UPDATE agent_definition
SET system_prompt = REPLACE(system_prompt, '（mathjs、mcp-financex', '（mathjs')
WHERE system_prompt LIKE '%（mathjs、mcp-financex%';

-- 1.d 把 "mcp-financex 等" → "已注册启用的 MCP server"
UPDATE agent_definition
SET system_prompt = REPLACE(
  system_prompt,
  'mcp-financex 等',
  '已注册启用的 MCP server'
)
WHERE system_prompt LIKE '%mcp-financex 等%';

-- 1.e 兜底：剩下的孤零零 "mcp-financex" 提及（任意上下文）→ "已注册启用的 MCP server"
UPDATE agent_definition
SET system_prompt = REPLACE(system_prompt, 'mcp-financex', '已注册启用的 MCP server')
WHERE system_prompt LIKE '%mcp-financex%';

-- ─── Step 2: 标记历史塌缩 hold@0.4 信号 ──────────────────────────────────────
-- 仅标记 data_snapshot_json 里有 rawResponse（旧 fallback 唯一会写的字段）
-- 且 signal='hold' AND confidence=0.4 的行；新代码已不再产生这种行。
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
