/**
 * Prime D6 — single-agent Tool Host surface (Bun HOST bridge until Rust tool-host).
 * A2A / team bulk tools stay on the old bridge and must not appear on def-orchestrator.
 */

/** Evidence → decision → execution tools consumed by Prime single Agent. */
export const PRIME_HOST_EVIDENCE_TOOLS = [
  "market.snapshot.get",
  "research.thesis.write",
  "research.forecast_book.get",
  "portfolio.construct",
  "order.create_intent",
] as const;

/** Contract-write tools Orchestrator keeps for scenario closure. */
export const PRIME_HOST_CONTRACT_TOOLS = [
  "run_screener",
  "recommendation.record",
  "factor.register",
  "discovery.run",
  "discovery.promote",
  "strategy.create_version",
  "strategy.compose",
  "backtest.run",
  "evaluate_risk",
  "rule.register",
] as const;

/** Team-compat bulk tools — OUT of Prime single-agent surface (A2A old bridge only). */
export const ORCHESTRATOR_TEAM_COMPAT_TOOLS = [
  "run_analyst_team",
  "summarize_team_decision",
  "fuse_signals",
] as const;

const TEAM_COMPAT_SET = new Set<string>(ORCHESTRATOR_TEAM_COMPAT_TOOLS);

export function isOrchestratorTeamCompatTool(name: string): boolean {
  return TEAM_COMPAT_SET.has(name);
}

export function stripOrchestratorTeamCompatTools(tools: readonly string[]): string[] {
  return tools.filter((name) => !TEAM_COMPAT_SET.has(name));
}

/** Tools Orchestrator must expose after D0–D5 convergence (D6 single-agent path). */
export const ORCHESTRATOR_PRIME_REQUIRED_TOOLS = [
  ...PRIME_HOST_EVIDENCE_TOOLS,
  "update_plan",
  "assign_task",
  "market.resolve_symbol",
  "web.search",
  "web.fetch",
] as const;

/**
 * Canonical Orchestrator tool surface after Prime D6 (seed + topology sync).
 * Excludes team-compat bulk tools and expert-owned probes (readiness / factor.list / edit_agent_pack).
 */
export const ORCHESTRATOR_PRIME_BASE_TOOLS = [
  "update_plan",
  "assign_task",
  "market.resolve_symbol",
  ...PRIME_HOST_EVIDENCE_TOOLS,
  ...PRIME_HOST_CONTRACT_TOOLS,
  "search_memory",
  "memory.consolidate_longterm",
  "memory.refresh_workspace",
  "skill.search",
  "skill.use_record",
  "skill.create",
  "skill.patch",
  "skill.archive",
  "web.search",
  "web.fetch",
] as const;
