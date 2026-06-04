-- Agent 编排 declarative 化（Phase A：schema-only，无 behavior 变更）
--
-- 背景：
--   2026-06-04 评估批次（5 case）发现 MSA 聚合层硬编码 3 套 role 集合：
--     1) `RESEARCH_TEAM_SLOT_ROLES`（哪些 role 能成为 slot）
--     2) `ANALYST_TEAM_ROLES` / `isMsAnalystRole`（哪些 role 进 MSA fusion）
--     3) `POST_FUSION_AUX_ROLES`（哪些 role 跑 post-fusion）
--   + 1 个 group 硬编码 `isStrategyPipelineGroup(id === 'grp-strategy-pipeline')`。
--
--   结果：`news_event` / `backtest_engineer` 等"非 4 类 analyst_*"角色虽然
--   在 group 里声明了，但执行层悄悄丢弃，前端 attendedRoles=[] / signals=0
--   （case 5 event-radar、case 4 discovery 实测复现）。
--
--   设计原则（来自 user review 2026-06-04）：
--     "agent 行为应该由角色定义 + 可用工具 / MCP 等定义，不要写特定 agent 的代码模块。"
--
-- 本 migration 加两列把这套"哪些 role 做什么"从代码里搬到 declarative 字段：
--   * `agent_group.pipeline_kind` —— 编组用哪种 dispatch 模式跑：
--       - 'msa_fusion'          : 4 analyst_* → fusion → 可选 aux（**当前默认行为**）
--       - 'sequential_research' : 按 memberRoles 顺序跑，无 MSA 投票
--       - 'event_radar'         : events contributors 主导 + signal confirm
--       - 'factor_discovery'    : research → factor_candidates → backtest_results
--   * `agent_definition.outputs_json` —— 角色产出能力（dispatcher 据此分桶）：
--       - 'signal'            : 输出方向性信号（hold/buy/sell + confidence）
--       - 'report'            : 输出 Markdown 报告段落
--       - 'events'            : 输出结构化事件/催化剂列表
--       - 'factor_candidates' : 输出候选因子（名称 + 表达式）
--       - 'strategy_dsl'      : 输出 JSON-DSL 策略
--       - 'backtest_results'  : 输出回测 run + 指标
--       - 'risk_assessment'   : 输出风控审核（approved/vetoed + 评分 + 原因）
--
-- 关键设计：
--   1) **不改任何 behavior**。Phase A 只加字段 + seed 默认值；
--      analyst-team.ts 的 dispatch 路径下一个 PR 才会 switch on pipeline_kind。
--   2) pipeline_kind default 'msa_fusion'：旧数据 / 用户自定义编组保持当前语义。
--   3) outputs_json default '[]'：dispatcher 在过渡期遇到空 outputs 时回退到
--      `isMsAnalystRole` 老判断（兼容路径），上线后用 seed 把 11 个内置 def 填齐。
--   4) 不建索引：纯配置字段，查询路径都按 group id / definition id 命中主键。
--
-- 回滚：down-0073.sql（DROP 两列；数据无法恢复，但因 default 值都是中性，
--       旧代码读这两列也用不到，删了后行为无影响）。

ALTER TABLE `agent_group` ADD COLUMN `pipeline_kind` TEXT NOT NULL DEFAULT 'msa_fusion';
--> statement-breakpoint
UPDATE `agent_group` SET `pipeline_kind` = 'msa_fusion' WHERE `pipeline_kind` IS NULL OR `pipeline_kind` = '';
--> statement-breakpoint
ALTER TABLE `agent_definition` ADD COLUMN `outputs_json` TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
UPDATE `agent_definition` SET `outputs_json` = '[]' WHERE `outputs_json` IS NULL OR `outputs_json` = '';
