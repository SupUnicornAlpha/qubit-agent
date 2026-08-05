-- down-0104: drop connector_auth
DROP INDEX IF EXISTS `idx_connector_auth_mcp_server`;
DROP INDEX IF EXISTS `idx_connector_auth_project_plugin`;
DROP TABLE IF EXISTS `connector_auth`;
