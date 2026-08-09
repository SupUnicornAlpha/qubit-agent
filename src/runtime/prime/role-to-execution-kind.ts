/**
 * Map legacy AgentRole → Core ExecutionKind (01 §6.6).
 * Core never branches on role; role survives only as AgentSpec.labels.
 *
 * Cursor/Codex pattern: on-demand specialists are **subagents** (parent Task /
 * agent.invoke). Event-driven wakeups use a separate **reactor** spec
 * (`def-news-reactor` for `market.news`), never the same id as team call_team_*.
 */

import type { AgentRole } from "../../types/entities";
import type { ExecutionKind } from "./types";

/** Roles that own the user-facing session (orchestrator / fund manager). */
const PRIMARY_ROLES = new Set<string>(["orchestrator", "portfolio_manager"]);

/**
 * Roles that are trigger-only by default. Intentionally empty for seed roles:
 * research `news_event` is a subagent so `call_team_news_event` / agent.invoke
 * work. Market-event reactors live on `def-news-reactor` (Core store seed).
 */
const REACTOR_ROLES = new Set<string>([]);

export function executionKindForRole(role: AgentRole | string): ExecutionKind {
  if (PRIMARY_ROLES.has(role)) return "primary";
  if (REACTOR_ROLES.has(role)) return "reactor";
  return "subagent";
}

export function defaultRecipeForRole(role: AgentRole | string): string {
  switch (role) {
    case "research":
    case "backtest":
    case "backtest_engineer":
      return "factor";
    case "news_event":
      return "news";
    case "orchestrator":
      return "open";
    default:
      return "open";
  }
}
