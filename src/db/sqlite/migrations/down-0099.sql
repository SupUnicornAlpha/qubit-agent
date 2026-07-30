-- down-0099: remove backfilled default `*` bindings that have no custom timeout.
-- Conservative: only delete `*` rows with null timeout (migration inserts) to avoid
-- wiping user/seed customised wildcards (e.g. qubit-broker timeout_ms=120000).
DELETE FROM mcp_tool_binding
WHERE tool_name = '*'
  AND definition_id IS NULL
  AND timeout_ms IS NULL
  AND retry_policy_json = '{}'
  AND rate_limit_json = '{}';
