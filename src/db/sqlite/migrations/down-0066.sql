-- Rollback LLM 网关 P0 打点字段（详见 0066_llm_gateway_p0_telemetry.sql）
--
-- 这 5 列没有索引、没有外键，DROP 顺序无关。

ALTER TABLE `llm_call_log` DROP COLUMN `response_id`;
ALTER TABLE `llm_call_log` DROP COLUMN `finish_reason`;
ALTER TABLE `llm_call_log` DROP COLUMN `first_token_latency_ms`;
ALTER TABLE `llm_call_log` DROP COLUMN `reasoning_tokens`;
ALTER TABLE `llm_call_log` DROP COLUMN `prompt_cached_tokens`;
