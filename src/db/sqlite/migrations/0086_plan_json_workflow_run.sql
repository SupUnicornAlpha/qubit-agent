-- 0086_plan_json_workflow_run — 给 workflow_run 加 plan_json 列
--
-- 背景（Coding-Agent 体验改造 P1，docs/CODING_AGENT_EXPERIENCE_DESIGN.md）：
--   编排器通过新增 builtin 工具 `update_plan` 维护一份对用户可见的分步计划/TODO，
--   写入本列并经 SSE `type:"plan"` 推流给右栏「计划卡片」。刷新/重连后据此水合。
--
-- 形如 `{"steps":[{"id","title","status","note?"}],"updatedAt"}`；
-- 可空（NULL = 暂无计划），向后兼容，旧行不受影响。

ALTER TABLE `workflow_run`
  ADD COLUMN `plan_json` TEXT;
