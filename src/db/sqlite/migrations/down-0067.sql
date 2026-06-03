-- Rollback agent_definition.llm_config_json（详见 0067_agent_def_llm_config.sql）

ALTER TABLE `agent_definition` DROP COLUMN `llm_config_json`;
