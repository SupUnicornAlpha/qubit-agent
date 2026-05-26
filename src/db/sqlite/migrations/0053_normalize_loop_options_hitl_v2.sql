-- P1-H 尾巴：一次性把 workflow_run.loop_options_json 内的 v1 HITL 字段
-- (`hitlChat` / `hitlTeam`) 改写成 v2 (`hitlChatMode` / `hitlMode`)，并删除 v1 字段。
--
-- 等价映射（与 src/runtime/workflow/hitl-service.ts 之前的 v1 兼容分支一致）：
--   hitlChat  === true  →  hitlChatMode = 'always'
--   hitlChat  === false →  hitlChatMode = 'off'
--   hitlTeam  === true  →  hitlMode     = 'always'
--   hitlTeam  === false →  hitlMode     = 'off'
--
-- 行为约束：
--   1) 仅当目标 v2 字段缺失时才注入；存在则尊重 v2 设置（v2 优先级高）
--   2) v1 字段一律删除，迁移后再无 hitlChat / hitlTeam
--   3) loop_options_json 为 NULL / 空 / 非 JSON 时跳过
--
-- 分三步执行，每步 WHERE 严格筛行；避免 json_set 把 NULL 当成真值写入键。

-- Step 1: hitlChat → hitlChatMode（仅当 v1 字段存在且 v2 未设）
UPDATE workflow_run
SET loop_options_json = json_set(
  loop_options_json,
  '$.hitlChatMode',
  CASE
    WHEN json_extract(loop_options_json, '$.hitlChat') = 1 THEN 'always'
    WHEN json_extract(loop_options_json, '$.hitlChat') = 0 THEN 'off'
  END
)
WHERE
  json_extract(loop_options_json, '$.hitlChat') IS NOT NULL
  AND json_extract(loop_options_json, '$.hitlChatMode') IS NULL;

-- Step 2: hitlTeam → hitlMode（同上）
UPDATE workflow_run
SET loop_options_json = json_set(
  loop_options_json,
  '$.hitlMode',
  CASE
    WHEN json_extract(loop_options_json, '$.hitlTeam') = 1 THEN 'always'
    WHEN json_extract(loop_options_json, '$.hitlTeam') = 0 THEN 'off'
  END
)
WHERE
  json_extract(loop_options_json, '$.hitlTeam') IS NOT NULL
  AND json_extract(loop_options_json, '$.hitlMode') IS NULL;

-- Step 3: 删除 v1 字段（不论 v2 是否注入，v1 都退场）
UPDATE workflow_run
SET loop_options_json = json_remove(loop_options_json, '$.hitlChat', '$.hitlTeam')
WHERE
  json_extract(loop_options_json, '$.hitlChat') IS NOT NULL
  OR json_extract(loop_options_json, '$.hitlTeam') IS NOT NULL;
