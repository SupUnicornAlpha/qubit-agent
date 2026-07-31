/**
 * ReAct 内的工具调用去重。
 *
 * 这不是全局缓存：只复用同一个 agent run（以及它的 checkpoint resume）已经
 * 成功取得的结果。这样可以阻止「同参成功后继续原样调用」的空转，同时不影响
 * 新 workflow 或不同参数的正常查询。
 */
import { createHash } from "node:crypto";

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

export type ToolCallCachePolicy = {
  /** 成功结果可复用多久；Infinity 表示当前 task 生命周期内都复用。 */
  ttlMs: number;
  /** 具有副作用的调用不参加自动去重。 */
  cacheable: boolean;
};

export type PriorToolCall = Record<string, unknown>;

/** Two consecutive requests for an already-satisfied fact indicate a loop. */
export const MAX_CONSECUTIVE_NO_PROGRESS = 2;

export function shouldTerminateForNoProgress(count: number): boolean {
  return count >= MAX_CONSECUTIVE_NO_PROGRESS;
}

const CONTEXT_ONLY_KEYS = new Set([
  "workflowRunId",
  "workflow_run_id",
  "projectId",
  "project_id",
  "runId",
  "run_id",
  "traceId",
  "trace_id",
]);

/**
 * Stable, redacted-by-design request identity.  Values remain local to the
 * runtime state/checkpoint; the trace only needs this SHA-256 fingerprint,
 * never the full business arguments.
 */
export function buildToolCallFingerprint(input: {
  targetName: string;
  params: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify({
    targetName: input.targetName.trim().toLowerCase(),
    params: normalize(input.params),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Policy is deliberately conservative: mutating tools are never coalesced. */
export function resolveToolCallCachePolicy(targetName: string): ToolCallCachePolicy {
  const tool = targetName.toLowerCase().split("/").at(-1) ?? targetName.toLowerCase();
  if (
    /(?:^|\.)(?:create|update|delete|register|record|submit|approve|reject|cancel|send|dispatch|run|execute|edit|write|patch|apply|place|order|plan)(?:_|\.|$)/.test(
      tool
    ) ||
    tool.startsWith("call_team_")
  ) {
    return { cacheable: false, ttlMs: 0 };
  }
  if (/fetch_(?:quote|ticks)|get_quote|current_price/.test(tool)) {
    return { cacheable: true, ttlMs: 15_000 };
  }
  if (
    /readiness|data_sources|resolve_symbol|fetch_(?:klines|bars|fundamentals|financials)|factor\.list|list_factors/.test(
      tool
    )
  ) {
    return { cacheable: true, ttlMs: Number.POSITIVE_INFINITY };
  }
  // A same-parameter read in adjacent ReAct iterations is almost always an
  // accidental retry.  Keep a short window for tools whose freshness contract
  // is unknown instead of assuming they are immutable.
  return { cacheable: true, ttlMs: 60_000 };
}

export function findReusableSuccessfulToolCall(input: {
  targetName: string;
  fingerprint: string;
  priorToolCalls: PriorToolCall[];
  now?: number;
}): PriorToolCall | null {
  const policy = resolveToolCallCachePolicy(input.targetName);
  if (!policy.cacheable) return null;
  const now = input.now ?? Date.now();
  for (const call of [...input.priorToolCalls].reverse()) {
    if (call.status !== "success" || call.toolName !== input.targetName) continue;
    if (call.fingerprint !== input.fingerprint) continue;
    const completedAt = Number(call.completedAt ?? call.createdAt ?? 0);
    if (!Number.isFinite(completedAt) || completedAt <= 0) continue;
    if (policy.ttlMs === Number.POSITIVE_INFINITY || now - completedAt <= policy.ttlMs) {
      return call;
    }
  }
  return null;
}

function normalize(value: unknown): JsonLike {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  const next: Record<string, JsonLike> = {};
  for (const key of Object.keys(record).sort()) {
    if (CONTEXT_ONLY_KEYS.has(key) || record[key] === undefined) continue;
    next[key] = normalize(record[key]);
  }
  return next;
}
