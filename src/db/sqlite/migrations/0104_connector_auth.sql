-- P2 OAuth connectors: project-scoped connector_auth (plaintext local tokens, same policy as api_key_secret).
CREATE TABLE IF NOT EXISTS `connector_auth` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `project_id` TEXT NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `plugin_id` TEXT NOT NULL,
  `provider` TEXT NOT NULL DEFAULT 'generic_oauth2',
  `display_name` TEXT NOT NULL DEFAULT '',
  `status` TEXT NOT NULL DEFAULT 'pending'
    CHECK(`status` IN ('pending', 'connected', 'error', 'revoked')),
  `client_id` TEXT NOT NULL DEFAULT '',
  `client_secret` TEXT NOT NULL DEFAULT '',
  `authorize_url` TEXT NOT NULL DEFAULT '',
  `token_url` TEXT NOT NULL DEFAULT '',
  `scopes` TEXT NOT NULL DEFAULT '',
  `redirect_uri` TEXT NOT NULL DEFAULT '',
  `access_token` TEXT,
  `refresh_token` TEXT,
  `token_type` TEXT NOT NULL DEFAULT 'Bearer',
  `expires_at` TEXT,
  `state` TEXT,
  `error_message` TEXT,
  `mcp_server_name` TEXT,
  `meta_json` TEXT NOT NULL DEFAULT '{}',
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  `updated_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_connector_auth_project_plugin`
  ON `connector_auth` (`project_id`, `plugin_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_connector_auth_mcp_server`
  ON `connector_auth` (`project_id`, `mcp_server_name`);
