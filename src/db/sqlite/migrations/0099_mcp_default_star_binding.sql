-- MCP 配完即用：为已启用、尚无 toolName='*' 的 server 补默认通配 binding。
-- project 作用域与 mcp_server_config.project_id 对齐；definition_id 一律 NULL。
-- 幂等：仅插入缺失的 (server_name, project_id, '*') 行。

INSERT INTO mcp_tool_binding (
  id,
  project_id,
  definition_id,
  server_name,
  tool_name,
  enabled,
  timeout_ms,
  retry_policy_json,
  rate_limit_json,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-' ||
    '4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  s.project_id,
  NULL,
  s.name,
  '*',
  1,
  NULL,
  '{}',
  '{}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM mcp_server_config AS s
WHERE s.enabled = 1
  AND NOT EXISTS (
    SELECT 1
    FROM mcp_tool_binding AS b
    WHERE b.server_name = s.name
      AND b.tool_name = '*'
      AND b.definition_id IS NULL
      AND (
        (s.project_id IS NULL AND b.project_id IS NULL)
        OR (s.project_id IS NOT NULL AND b.project_id = s.project_id)
      )
  );
