/**
 * Parse / normalize Prime Core ExecutionKind from DB or API input.
 */

import { executionKindForRole } from "./role-to-execution-kind";
import type { ExecutionKind } from "./types";

const KINDS = new Set<string>(["primary", "subagent", "reactor"]);

export function isExecutionKind(value: unknown): value is ExecutionKind {
  return typeof value === "string" && KINDS.has(value);
}

/** Prefer explicit kind; else derive from legacy role; else subagent. */
export function resolveExecutionKind(input: {
  executionKind?: unknown;
  role?: string | null;
}): ExecutionKind {
  if (isExecutionKind(input.executionKind)) return input.executionKind;
  if (typeof input.role === "string" && input.role.trim()) {
    return executionKindForRole(input.role.trim());
  }
  return "subagent";
}
