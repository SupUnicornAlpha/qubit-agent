-- 0082_agent_skill_recommended_tools — 给 agent_skill 加 recommended_tools_json 列
--
-- 背景（W2 2026-06-11）：
--   `auto-skill-execution-hook` 旧版用 bodyMd 子串匹配判定"该 skill 是否被采纳执行"。
--   实测问题：
--     1. 通用步骤 skill（如 "调用 tool 完成任务"）会被任意工具命中 → 误标 executed
--     2. 工具改名 / split 后子串失配 → 漏标 executed → use_count 不涨 → SkillPromoter
--        看到使用率为 0 把 skill archive 掉
--
-- 本列：JSON 字符串数组，存 skill 推荐的 tool 全名白名单。
--   - 例：`["factor.register","factor.compute","qubit-data/fetch_klines"]`
--   - hook 优先精确 / 前缀匹配此列；列为空 `"[]"` 时 fallback 到旧的子串匹配。

ALTER TABLE `agent_skill`
  ADD COLUMN `recommended_tools_json` TEXT NOT NULL DEFAULT '[]';
