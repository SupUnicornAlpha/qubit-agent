-- LLM 网关 P1 — agent_definition 加 per-Agent 采样配置 JSON 列
--
-- 背景：
--   P0 阶段把 sampling 入参打通到 gateway，但 reason 节点目前还是写死的默认值
--   （temperature=0.1 / maxOutputTokens=1024）。要让"不同 Agent 用不同配置"真正
--   落到 DB，需要在 agent_definition 上有一列存采样偏好。
--
--   采用单一 JSON 列而不是 N 个独立 column 的原因：
--     - 字段会持续扩展（top_p / reasoning_effort / vendor 私有 knob 等）；
--     - 老 agent 行 ALTER 加多列会污染 audit；
--     - 网关只 spread 已知字段，未知 knob 直接忽略，前向兼容。
--
--   形态举例：
--     { "temperature": 0.2, "maxOutputTokens": 8192, "reasoningEffort": "high" }
--
-- 关键设计：
--   1. notNull + default '{}'：旧行 / seed 不写 → 等价空对象 → 网关走默认值；
--   2. 不建索引：纯配置字段，没有按 JSON key 查询的需求；
--   3. ALTER 列 default 在 SQLite 上"老行不回填 default"是 quirk，
--      用 UPDATE 兜底确保现有行也是 '{}' 而不是 NULL。
--
-- 回滚：down-0067.sql（DROP 列）。

ALTER TABLE `agent_definition` ADD COLUMN `llm_config_json` TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
UPDATE `agent_definition` SET `llm_config_json` = '{}' WHERE `llm_config_json` IS NULL OR `llm_config_json` = '';
