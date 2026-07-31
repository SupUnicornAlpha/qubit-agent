import { asc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition } from "../../db/sqlite/schema";
import type { AgentRole } from "../../types/entities";

export const TOPOLOGY_TEAM_TOOL_PREFIX = "call_team_";
const TOPOLOGY_TIMEOUT_BUFFER_MS = 10_000;

/**
 * 任务墙钟：专家子任务硬上限（含 gather / child deadline）。
 *
 * 研究任务会包含多个数据源、MCP 降级及复核；六分钟在上游慢响应时不足以完成一次
 * 正常恢复。心跳 lease 仍会及时识别失联任务，用户也可随时取消，因此将常规研究
 * 窗口提升到 15 分钟，而非把慢任务直接标成失败。
 */
export const TOPOLOGY_TASK_WALL_CLOCK_MS = 900_000;
/** 通信 lease：连续无 TASK_PROGRESS 则视为失联（可被 progress/心跳续期） */
export const TOPOLOGY_TASK_LEASE_MS = 90_000;
/** 专家侧心跳间隔（发 TASK_PROGRESS phase=heartbeat） */
export const TOPOLOGY_TASK_HEARTBEAT_MS = 30_000;

const TOPOLOGY_TASK_TIMEOUT_BY_ROLE: Partial<Record<AgentRole, number>> = {
  market_data: TOPOLOGY_TASK_WALL_CLOCK_MS,
  news_event: TOPOLOGY_TASK_WALL_CLOCK_MS,
  analyst_macro: TOPOLOGY_TASK_WALL_CLOCK_MS,
  analyst_fundamental: TOPOLOGY_TASK_WALL_CLOCK_MS,
  analyst_technical: TOPOLOGY_TASK_WALL_CLOCK_MS,
  analyst_sentiment: TOPOLOGY_TASK_WALL_CLOCK_MS,
  research: TOPOLOGY_TASK_WALL_CLOCK_MS,
  backtest: TOPOLOGY_TASK_WALL_CLOCK_MS,
  risk: TOPOLOGY_TASK_WALL_CLOCK_MS,
  portfolio_manager: TOPOLOGY_TASK_WALL_CLOCK_MS,
  execution: TOPOLOGY_TASK_WALL_CLOCK_MS,
  memory: TOPOLOGY_TASK_WALL_CLOCK_MS,
};

/** 已合并/退役角色 → 当前内置角色（派单兼容） */
export const DISPATCH_ROLE_ALIASES: Partial<Record<AgentRole, AgentRole>> = {
  risk_manager: "risk",
  researcher_bull: "research",
  researcher_bear: "research",
  backtest_engineer: "backtest",
  execution_trader: "execution",
  memory_curator: "memory",
};

const SPECIALIST_ROLE_PRIORITY: readonly AgentRole[] = [
  "market_data",
  "news_event",
  "analyst_macro",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "research",
  "backtest",
  "risk",
  "portfolio_manager",
  "execution",
  "memory",
] as const;

const SPECIALIST_ROLE_PRIORITY_INDEX = new Map(
  SPECIALIST_ROLE_PRIORITY.map((role, index) => [role, index])
);

export function resolveDispatchRole(role: AgentRole): AgentRole {
  return DISPATCH_ROLE_ALIASES[role] ?? role;
}

export type TopologyDispatchTarget = {
  role: AgentRole;
  toolName: string;
  agentName: string;
  definitionId: string;
  enabled: boolean;
};

export type OrchestratorTopologyContext = {
  groupId: null;
  edges: [];
  targets: TopologyDispatchTarget[];
  toolNames: string[];
};

export function topologyTeamToolName(role: AgentRole): string {
  return `${TOPOLOGY_TEAM_TOOL_PREFIX}${role}`;
}

export function topologyTeamToolDescription(role: AgentRole, agentName?: string): string {
  const label = agentName ? `${agentName}（${role}）` : role;
  return `向 ${label} 派发长任务（Graph/A2A）；参数 goal 必填。返回 dispatchStatus=timeout 仅表示专家调度超时，不代表底层数据源不可用`;
}

export function isTopologyTeamTool(toolName: string): boolean {
  return toolName.startsWith(TOPOLOGY_TEAM_TOOL_PREFIX);
}

export function parseRoleFromTopologyTeamTool(toolName: string): AgentRole | null {
  if (!isTopologyTeamTool(toolName)) return null;
  const role = toolName.slice(TOPOLOGY_TEAM_TOOL_PREFIX.length);
  return role.length > 0 ? (role as AgentRole) : null;
}

export function resolveTopologyTaskTimeoutMs(
  role: AgentRole,
  configuredValue: string | number | undefined = process.env.TOPOLOGY_TASK_TIMEOUT_MS
): number {
  const configured = Number(configuredValue);
  if (configuredValue !== undefined && Number.isFinite(configured)) {
    // 显式配置可支持长研究，但保留一小时的防失控上限；正常运行不应被默认阈值截断。
    return Math.min(Math.max(configured, 10_000), 3_600_000);
  }
  return TOPOLOGY_TASK_TIMEOUT_BY_ROLE[resolveDispatchRole(role)] ?? TOPOLOGY_TASK_WALL_CLOCK_MS;
}

/** 无 progress 的通信失联阈值；有 TASK_PROGRESS 时 gather 会续期，但不超过墙钟。 */
export function resolveTopologyTaskLeaseMs(
  configuredValue: string | number | undefined = process.env.TOPOLOGY_TASK_LEASE_MS
): number {
  const configured = Number(configuredValue);
  if (configuredValue !== undefined && Number.isFinite(configured)) {
    return Math.min(Math.max(configured, 5_000), 300_000);
  }
  return TOPOLOGY_TASK_LEASE_MS;
}

export function resolveTopologyTaskHeartbeatMs(
  configuredValue: string | number | undefined = process.env.TOPOLOGY_TASK_HEARTBEAT_MS
): number {
  const configured = Number(configuredValue);
  if (configuredValue !== undefined && Number.isFinite(configured)) {
    return Math.min(Math.max(configured, 5_000), 120_000);
  }
  return TOPOLOGY_TASK_HEARTBEAT_MS;
}

export function resolveTopologyToolTimeoutMs(toolName: string): number | undefined {
  const role = parseRoleFromTopologyTeamTool(toolName);
  if (!role) return undefined;
  return resolveTopologyTaskTimeoutMs(role) + TOPOLOGY_TIMEOUT_BUFFER_MS;
}

export type MarketDataRequestMode = "realtime" | "historical";

/** Prevent live-price requests from being satisfied by a stale daily bar. */
export function classifyMarketDataRequestMode(goal: string): MarketDataRequestMode {
  return /实时|现价|当前(?:价格|价|行情)|今天(?:价格|价|行情|走势|涨跌)|今日(?:价格|价|行情|走势|涨跌)|最新(?:价格|价|行情)|盘中|盘口|逐笔|买一|卖一|real[- ]?time|live\s+quote|current\s+price/i.test(
    goal
  )
    ? "realtime"
    : "historical";
}

export function buildTopologySpecialistExecutionContract(role: AgentRole, goal = ""): string {
  const common = [
    "## 专家子任务执行合同（硬约束）",
    "- 这是 Orchestrator 派发的有界子任务；只完成 goal 指定的最小结果，不扩写通用报告。",
    "- readiness / data_sources 只允许在尚无本轮健康证据时调用一次；已有成功结果不得重复探测。",
    "- 核心业务工具成功后，下一轮必须用 `tool=none` 汇总结果并结束，不得为了凑完整度继续调用辅助工具。",
    "- 调度超时、模型超时与数据不可用是三种不同状态；只有真实拉取返回 no_data/no_bars/全 provider 失败，才可判定数据不可用。",
  ];
  if (role === "market_data") {
    const mode = classifyMarketDataRequestMode(goal);
    common.push(`- 本任务的数据模式由运行时判定为 **${mode}**。`);
    if (mode === "realtime") {
      common.push(
        '- 实时任务最短链路：市场识别（可复用）→ `fetch_quote`；Quote 失败才依次降级到 `fetch_ticks`、`fetch_klines(timeframe="1m")`、`fetch_klines(timeframe="5m")`。禁止用日 K 成功冒充实时行情。',
        "- 实时结果必须返回 source、timestamp/asOf、freshnessMs；若只能取得昨收/旧 K 线，明确标记 stale，不得报告为当前价。"
      );
    } else {
      common.push(
        "- 历史行情任务最短链路：市场识别（可复用）→ 一次真实 `fetch_klines`/`fetch_bars` → 立即总结。"
      );
    }
    common.push("- 核心行情工具成功后禁止再次调用 readiness。");
  }
  if (role === "research") {
    common.push(
      "- 单标的研究不得用 factor.autoEvaluate/IC/RankIC 证明有效性；IC 是横截面指标，至少需要 3 只标的。单标的应使用时序指标或 backtest，或明确扩展可比股票池后再做横截面评估。"
    );
  }
  return common.join("\n");
}

export function isRedundantTopologyProbe(input: {
  taskType: string;
  targetName: string;
  priorToolCalls: Array<Record<string, unknown>>;
}): boolean {
  if (input.taskType !== "topology_dispatch") return false;
  const probe = input.targetName.split("/").at(-1) ?? input.targetName;
  if (!["market.readiness", "market.data_sources"].includes(probe)) return false;
  return input.priorToolCalls.some(
    (call) => call.status === "success" && call.toolName === input.targetName
  );
}

export async function loadOrchestratorTopologyForWorkflow(): Promise<OrchestratorTopologyContext> {
  const db = await getDb();
  const rows = await db
    .select({
      id: agentDefinition.id,
      role: agentDefinition.role,
      name: agentDefinition.name,
      enabled: agentDefinition.enabled,
    })
    .from(agentDefinition)
    .where(eq(agentDefinition.enabled, true))
    .orderBy(asc(agentDefinition.role), asc(agentDefinition.name));

  const byRole = new Map<AgentRole, TopologyDispatchTarget>();
  for (const row of rows) {
    const role = row.role as AgentRole;
    if (role === "orchestrator") continue;
    const resolvedRole = resolveDispatchRole(role);
    if (resolvedRole === "orchestrator") continue;
    if (byRole.has(resolvedRole)) continue;
    byRole.set(resolvedRole, {
      role: resolvedRole,
      toolName: topologyTeamToolName(resolvedRole),
      agentName: row.name,
      definitionId: row.id,
      enabled: true,
    });
  }

  const targets = [...byRole.values()].sort((a, b) => {
    const ai = SPECIALIST_ROLE_PRIORITY_INDEX.get(a.role) ?? Number.MAX_SAFE_INTEGER;
    const bi = SPECIALIST_ROLE_PRIORITY_INDEX.get(b.role) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.role.localeCompare(b.role);
  });

  return {
    groupId: null,
    edges: [],
    targets,
    toolNames: targets.map((target) => target.toolName),
  };
}

/** 非 Orchestrator 专家：协作边界（不需完整拓扑表） */
export function buildAgentCollaborationHint(role: AgentRole): string {
  if (role === "orchestrator") return "";
  return [
    "## 协作边界",
    "- 你由 **Orchestrator** 通过 `call_team_<role>` 或 `TASK_ASSIGN` 调度；专注本子任务。",
    "- 勿擅自代替其他 Agent 执行工作或编造其结论。",
    "- 默认只返回完成当前子任务所需的最小结果：结论、关键证据、未决风险；除非明确要求，不要展开成长报告。",
    "- 产出供 Orchestrator 汇总：中文、可追溯、不确定处标注 `[待核实]`。",
  ].join("\n");
}

export function buildTopologyToolsPromptBlock(ctx: OrchestratorTopologyContext | null): string {
  if (!ctx || ctx.targets.length === 0) {
    return [
      "## 专家调度",
      "当前没有可用专家工具；请使用 `assign_task` 按需派给具体专家角色。",
    ].join("\n");
  }

  const lines: string[] = [
    "## 专家调度工具",
    "下面是当前已启用专家的直接派单工具。调用后系统会向该角色发起 Graph/A2A 任务（`TASK_ASSIGN`）。",
    "传参：`goal`（必填）、`message`（可选补充）、`taskType`（默认 `topology_dispatch`）、`params`（可选 JSON 对象）。",
    "",
    "| 工具名 | 目标角色 | 说明 |",
    "|--------|----------|------|",
  ];

  for (const target of ctx.targets) {
    lines.push(`| \`${target.toolName}\` | ${target.role}（${target.agentName}） | 已启用 |`);
  }

  lines.push(
    "",
    "规则：",
    "- 优先用上表中的 `call_team_<role>` 做**定向派单**。",
    "- 由 **Orchestrator 统一派单和收口**；不要让专家再组织其它专家。",
    "- `assign_task` 仅当目标不在上表时使用。",
    "- 默认先补数据，再补分析/研究，再决定是否回测与风控。",
    "- 默认拿到足够证据就收口，不要为了“完整报告”把所有角色都跑一遍。"
  );

  return lines.join("\n");
}

export function buildSuggestedCallChainBlock(ctx: OrchestratorTopologyContext | null): string {
  if (!ctx || ctx.targets.length === 0) {
    return [
      "## 建议的调用链（仅供参考）",
      "当前没有预设专家工具链。你自主决定调用哪些专家：用 `assign_task` 派给任意已启用角色，由你统一整合，不要默认批量拉全队。",
    ].join("\n");
  }

  const chain = ctx.targets
    .slice(0, 8)
    .map(
      (target, index) =>
        `${index + 1}. \`${target.toolName}\`（${target.role} / ${target.agentName}）`
    )
    .join("  →  ");

  return [
    "## 建议的调用链（来自当前启用专家 · 仅供参考 · 非强制）",
    "你是决策者：可以按需调用、跳过某步、或补充其它角色；原则是少而精，不默认批量拉全队。",
    "",
    `推荐顺序：${chain}`,
    "",
    "推荐阶段：先数据/事件，再专项分析，再 research → backtest → risk。",
    "原则：能少调就少调，信息够了就收口给用户；开工前用 `update_plan` 把你选定的链落成对用户可见的计划，每步完成即更新。",
  ].join("\n");
}

export function assertTopologyTargetAllowed(
  ctx: OrchestratorTopologyContext | null,
  role: AgentRole
): void {
  if (!ctx || ctx.targets.length === 0) return;
  const allowed = ctx.targets.some((target) => target.role === role);
  if (!allowed) {
    throw new Error(`role '${role}' is not in the current enabled specialist set`);
  }
}

/** Orchestrator 静态基础工具（不含专家派单工具）；与 seed 3.8 合同写工具对齐。 */
export const ORCHESTRATOR_BASE_TOOLS = [
  "update_plan",
  "assign_task",
  "market.resolve_symbol",
  "market.data_sources",
  "market.readiness",
  "evaluate_risk",
  "edit_agent_pack",
  "search_memory",
  "memory.consolidate_longterm",
  "memory.refresh_workspace",
  "skill.search",
  "skill.use_record",
  "skill.create",
  "skill.patch",
  "skill.archive",
  "run_screener",
  "recommendation.record",
  "factor.list",
  "factor.register",
  "factor.evaluate",
  "factor.autoEvaluate",
  "strategy.create_version",
  "strategy.compose",
  "order.create_intent",
  "call_mcp",
] as const;

/**
 * Merge seed/base orchestrator tools with topology `call_team_*` tools.
 * Must not wipe seed contract tools when topology sync runs after agent seed.
 */
export function mergeOrchestratorToolsJson(topologyToolNames: string[]): string[] {
  return [...new Set([...ORCHESTRATOR_BASE_TOOLS, ...topologyToolNames])];
}

export function stripTopologyToolsFromList(tools: string[]): string[] {
  return tools.filter((tool) => !isTopologyTeamTool(tool));
}
