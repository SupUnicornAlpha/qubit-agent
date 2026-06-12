-- 0084_tool_call_log_error_class.sql — 给 tool_call_log 加 error_class 一等列 + 索引
--
-- 背景（agent 架构治理 #6「工具错误排查」2026-06）：
--   `classifyToolError` 把工具错误分成 transient / permanent / blocked / unknown，
--   但结果原本只埋在两处：
--     1. tool_call_log.response_json.toolError / errorSource（非结构化 JSON）
--     2. agent_step.action_json 的 observation（喂回 LLM 用）
--   导致"工具错误排查"类查询（按错误类别切分、统计可重试错误占比、找出某个
--   工具/MCP 的 permanent 失败聚集）必须 `response_json LIKE '%"toolError":true%'`
--   全表扫，既慢又拿不到分类维度。
--
-- 本列：把 error_class 提成一等列，写入端（tool-call-log-service.ts）在终态
--   record* 函数里直接落：
--     - recordToolCallSuccess        → NULL
--     - recordToolCallError          → classifyToolError(errorMessage)
--     - recordToolCallTimeout        → 'transient'（超时天然可重试）
--     - recordToolCallSandboxBlocked → 'blocked'
--   旧行保持 NULL（不回填）；监控端在列为 NULL 时 fallback 读 response_json。
--
-- 索引 idx_tool_call_log_status_class_created：覆盖 (status, error_class, created_at)，
--   服务"近 N 天按错误类别切分"这类时间窗聚合。

ALTER TABLE `tool_call_log`
  ADD COLUMN `error_class` TEXT;
--> statement-breakpoint
CREATE INDEX `idx_tool_call_log_status_class_created`
  ON `tool_call_log` (`status`, `error_class`, `created_at`);
