-- Schema 收敛复盘：恢复 `connector_call_log`
--
-- 0069 删 connector_call_log 当时的判断是"前端 0 消费 + 写入路径
-- installAcpMonitoringHook 已下线"——但忽略了它是 `src/connectors/` 整套子系统
-- （data / memory / risk / execution / backtest / research / simulation 七类）的
-- audit 落点。BaseConnector 的 init / healthcheck / execute / shutdown 4 阶段生命周期
-- hook 经典上需要 audit；之前是绕 ACP 协议层挂的 hook，ACP V2 废弃后失效。
--
-- 本 migration 把表建回来（**去掉 dangling 的 `acp_call_id` FK** —— acp_call 已被
-- 0070 删除），让未来 BaseConnector 直接写 audit 时有目标表。表当前没有写入路径，
-- 是"reserved 体系基础设施"。
--
-- 注意：本 migration 仅恢复表 schema，**不重接死代码**
-- （acp-monitoring-hook / connector-call-logger / connector-summary / timeseries
-- source / 前端 panel 都是 ACP 时代的实现，跟新 audit 设计不兼容）。

CREATE TABLE IF NOT EXISTS `connector_call_log` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text REFERENCES `connector_instance`(`id`),
	`connector_name` text DEFAULT '' NOT NULL,
	`workflow_run_id` text REFERENCES `workflow_run`(`id`),
	`trace_id` text NOT NULL,
	`operation` text NOT NULL,
	`request_json` text NOT NULL,
	`response_json` text,
	`latency_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CHECK (`operation` IN ('init', 'healthcheck', 'execute', 'shutdown')),
	CHECK (`status` IN ('success', 'error', 'timeout'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_connector_call_log_workflow_created` ON `connector_call_log` (`workflow_run_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_connector_call_log_instance_created` ON `connector_call_log` (`connector_instance_id`, `created_at`);
