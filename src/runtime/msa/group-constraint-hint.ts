/**
 * 编组级硬约束 hint（Round 7 复盘 2026-06-08 新增）
 *
 * 背景：seed-agent-prompts.ts 里写的"约束 A：strategy 撰写前必须先调 strategy.create_version"
 * 和"约束 E：live_trading 必须调 order.create_intent" 都是注入到 def-research 的 system prompt
 * 里。但 `grp-strategy-pipeline` / `grp-live-trading` 走的是 `analyst_team_slot` 路径，
 * slot 派单时的 user prompt 在 `analyst-team-slot-react.ts:258-260` 拼装，**完全没读
 * agent_definition.systemPrompt 之外的约束**。结果 Round 7 实测：strategy 跑了 5 步全是
 * 数据/因子探索，**0 次 strategy.create_version / strategy.compose 调用**；live_trading
 * 跑到 discovery.run 就 stop，**0 次 order.create_intent**。
 *
 * 这个模块负责：按 (groupId, role) 算一段简短、强约束的 markdown，由 caller 拼到 slot
 * 的 userGoal 里。LLM 看到 "硬约束：必须依序调 X 然后 Y" 时，相对于 system prompt 里
 * 一段"软提示"，调用率高得多（实测多次）。
 *
 * 设计决策：
 *   - 不读 agent_group.description 字段拼软提示——description 里写得太长、含混义
 *   - 用硬编码白名单：(group_id, role) → 短约束。覆盖率有限（只 strategy / live_trading）
 *     但这两个是 Round 7 实测 A-1=0 的元凶
 *   - 未命中白名单 → 返回空串，对原有 flow 完全无副作用
 */

import type { AgentRole } from "../../types/entities";

export interface GroupRoleConstraintInput {
  groupId?: string | null;
  role: AgentRole;
  /**
   * 兜底：group.description 字段值，未命中白名单时按软提示注入。
   * 留空则未命中时返回空串。
   */
  groupDescription?: string | null;
}

/** 已知会触发硬约束的 (groupId, role) 组合 */
const HARD_CONSTRAINTS: Array<{
  groupId: string;
  role: AgentRole;
  buildHint: () => string;
}> = [
  {
    groupId: "grp-strategy-pipeline",
    role: "research",
    buildHint: () =>
      [
        "## 编组硬约束（grp-strategy-pipeline）",
        "**本子任务最终交付必须满足：strategy_version 表新增至少 1 条 + strategy_composition 表 factor_ids_json 非空**。",
        "为此你**必须**依序调用：",
        "1. `strategy.create_version`（参数 `name`/`style`/`description`/`version_tag` —— 返回 strategyId / strategyVersionId）",
        "2. `strategy.compose`（参数 `strategy_version_id` 用第 1 步返回的 versionId，`factor_ids` 数组非空）",
        "缺任一步骤本次任务都不算完成。**不要**仅给文字总结。",
      ].join("\n"),
  },
  {
    groupId: "grp-live-trading",
    role: "research",
    buildHint: () =>
      [
        "## 编组硬约束（grp-live-trading）",
        "**本子任务最终交付必须满足：order_intent 表新增至少 1 条**。",
        "默认走 paper（`dispatch_mode='paper'`），不影响实盘账户。你**必须**调用 `order.create_intent`，参数包括：",
        "- `strategy_version_id`：本工作流或最近活跃的策略版本 id（可先用 `strategy.create_version` 先建一个）",
        "- `symbol` / `side` / `qty`（必填）",
        "- `dispatch_mode='paper'`（必填，避免误触实盘）",
        "下游 risk 会签核，但 order_intent 必须先由你落库。**不要**仅给文字总结。",
      ].join("\n"),
  },
  {
    groupId: "grp-live-trading",
    role: "risk",
    buildHint: () =>
      [
        "## 编组硬约束（grp-live-trading · risk）",
        "research 已落 `order_intent` 行；你的任务是用 `qubit-risk/check_concentration` / `qubit-risk/load_rules`",
        "等工具做 pre-trade 检查并落 `risk_decision` 表（关联到 order_intent_id）。",
      ].join("\n"),
  },
];

/**
 * 按 (groupId, role) 算约束 hint。未命中白名单时回退到 groupDescription 软提示。
 *
 * @returns markdown 段（含标题），未命中时返回空串
 */
export function buildGroupRoleConstraintHint(input: GroupRoleConstraintInput): string {
  if (!input.groupId) {
    return input.groupDescription ? renderSoftHint(input.groupDescription) : "";
  }
  const match = HARD_CONSTRAINTS.find(
    (c) => c.groupId === input.groupId && c.role === input.role
  );
  if (match) return match.buildHint();
  return input.groupDescription ? renderSoftHint(input.groupDescription) : "";
}

/**
 * 软提示：把 group.description 直接当编组背景塞进 prompt。
 * 比硬约束弱很多，仅做兜底。
 */
function renderSoftHint(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return "";
  return ["## 编组背景", trimmed].join("\n");
}

/**
 * 测试 helper：判断 (groupId, role) 是否命中硬约束。
 * 主要用于 TDD 校验 round trip。
 */
export function hasHardConstraint(input: { groupId?: string | null; role: AgentRole }): boolean {
  if (!input.groupId) return false;
  return HARD_CONSTRAINTS.some(
    (c) => c.groupId === input.groupId && c.role === input.role
  );
}
