-- LLM 网关 P0 — `llm_call_log` 打点字段升级
--
-- 背景：
--   原 `llm_call_log` 仅记录 prompt/completion/total tokens + latency 三项。OpenAI
--   Responses API（gpt-5* / o-series 推荐路径）和 Anthropic 4.x 暴露的额外 usage
--   字段（cached_input_tokens / reasoning_tokens）以及"首 token 延迟"、"终止原因"、
--   "服务端 response id"全部丢失，前端 monitor 页面无法定位"为什么这次回答被截断"
--   也无法做 reasoning ratio / TTFT / cache hit ratio 监控。
--
--   workflow 051d5cc8 复盘里看到 gpt-5.5 因 temperature 报 400 被熔断，调试时手上
--   只有 latency_ms 和 promptTokens，没有 finish_reason / response_id —— 必须每次
--   去 OpenAI 控制台对账。本期把这 5 个高频字段升正式列。
--
-- 关键设计：
--   1. 5 列全部 nullable / 无默认；旧行（迁移前的所有日志）不需要回填即可读。
--   2. 新写入路径（gateway.ts）已经按字段是否存在做扩展性 spread，所以「写入端
--      未启用 / 模型不返回该字段」时整列保持 NULL，与 promptTokens=0 的"真实零"
--      区分。
--   3. response_id 不建索引（仅做诊断字段，按 id 反查走二级表更便宜）；
--      finish_reason 同理（基数低 + 通常按时间窗口 + agent 切分）。
--
-- 回滚：down-0066.sql（DROP 5 列）。SQLite 3.35+ 才支持 ALTER TABLE DROP COLUMN，
-- 本仓 bun:sqlite ≥ 3.45 OK。

ALTER TABLE `llm_call_log` ADD COLUMN `prompt_cached_tokens` INTEGER;
--> statement-breakpoint
ALTER TABLE `llm_call_log` ADD COLUMN `reasoning_tokens` INTEGER;
--> statement-breakpoint
ALTER TABLE `llm_call_log` ADD COLUMN `first_token_latency_ms` INTEGER;
--> statement-breakpoint
ALTER TABLE `llm_call_log` ADD COLUMN `finish_reason` TEXT;
--> statement-breakpoint
ALTER TABLE `llm_call_log` ADD COLUMN `response_id` TEXT;
