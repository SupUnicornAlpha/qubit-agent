-- Per-agent MCP tool bindings (nullable = project-wide / all agents).
ALTER TABLE `mcp_tool_binding` ADD COLUMN `definition_id` text REFERENCES `agent_definition`(`id`) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS `idx_mcp_binding_definition` ON `mcp_tool_binding` (`definition_id`);
