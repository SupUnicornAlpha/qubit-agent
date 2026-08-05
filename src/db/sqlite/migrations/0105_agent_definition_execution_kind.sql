-- Prime Core：agent_definition.execution_kind（primary | subagent | reactor）
--
-- Core 只按 ExecutionKind 分支，不再按 legacy role 调度。
-- role 仍保留作业务标签（映射进 AgentSpec.labels）。
-- 默认 subagent；按已知 role 回填 primary / reactor。

ALTER TABLE `agent_definition` ADD COLUMN `execution_kind` TEXT NOT NULL DEFAULT 'subagent';
--> statement-breakpoint
UPDATE `agent_definition`
SET `execution_kind` = 'primary'
WHERE `role` IN ('orchestrator', 'portfolio_manager');
--> statement-breakpoint
UPDATE `agent_definition`
SET `execution_kind` = 'reactor'
WHERE `role` IN ('news_event');
--> statement-breakpoint
UPDATE `agent_definition`
SET `execution_kind` = 'subagent'
WHERE `execution_kind` IS NULL
   OR `execution_kind` = ''
   OR `execution_kind` NOT IN ('primary', 'subagent', 'reactor');
