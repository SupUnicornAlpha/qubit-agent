-- MCP config is identified by (scope, name). SQLite UNIQUE permits duplicate
-- NULL values, so global and project-scoped rows need separate partial indexes.
-- Keep the oldest row when repairing historical duplicates.
DELETE FROM mcp_server_config
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM mcp_server_config
  GROUP BY COALESCE(project_id, '__qubit_global_mcp_scope__'), name
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_server_global_name
ON mcp_server_config(name)
WHERE project_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_server_project_name
ON mcp_server_config(project_id, name)
WHERE project_id IS NOT NULL;
