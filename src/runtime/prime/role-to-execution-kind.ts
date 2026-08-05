/**
 * Map legacy AgentRole → Core ExecutionKind (01 §6.6).
 * Core never branches on role; role survives only as AgentSpec.labels.
 */

import type { AgentRole } from "../../types/entities";
import type { ExecutionKind } from "./types";

/** Roles that own the user-facing session (orchestrator / fund manager). */
const PRIMARY_ROLES = new Set<string>(["orchestrator", "portfolio_manager"]);

/** Roles woken by external events rather than user chat / invoke. */
const REACTOR_ROLES = new Set<string>(["news_event"]);

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
    case "orchestrator":
      return "open";
    default:
      return "open";
  }
}
