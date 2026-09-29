import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { researchProgramService } from "./service";
import type { ResearchAttempt, ResearchProtocol } from "./types";

export type ResearchExecutionInput = {
  projectId: string;
  kind: "factor_compute" | "factor_evaluate" | "backtest";
  candidateId: string;
  candidateJson: Record<string, unknown>;
  requestJson: Record<string, unknown>;
  idempotencyKey?: string;
};

const executionContext = new AsyncLocalStorage<{
  attempt: ResearchAttempt;
  protocol: ResearchProtocol;
}>();
export function currentResearchExecution() {
  return executionContext.getStore();
}

/** Server-owned context. No request field can create an internal execution lease. */
export function runWithResearchContext<T>(
  attempt: ResearchAttempt,
  protocol: ResearchProtocol,
  execute: () => Promise<T>
) {
  return executionContext.run({ attempt, protocol }, execute);
}

export function normalizeResearchRequest(
  protocol: ResearchProtocol,
  kind: string,
  request: Record<string, unknown>
) {
  const spec = protocol.spec;
  const fixed: Record<string, unknown> = {
    datasetSnapshotId: spec.development.datasetSnapshotId,
    startDate: spec.development.startDate,
    endDate: spec.development.endDate,
    symbols: spec.development.symbols,
  };
  if (kind === "factor_evaluate") {
    fixed.horizonDays = spec.evaluation.horizonDays;
    fixed.groupCount = spec.evaluation.groupCount;
    fixed.decayHorizons = [spec.evaluation.horizonDays];
    if (request.validationStartDate)
      throw new Error("research_protocol_does_not_allow_adaptive_validation_split");
  }
  if (kind === "backtest") fixed.timeframe = "1d";
  for (const [key, expected] of Object.entries(fixed)) {
    const actual = request[key];
    if (actual === undefined || actual === null) continue;
    const canonical = (value: unknown) =>
      JSON.stringify(Array.isArray(value) ? [...value].sort() : value);
    if (canonical(actual) !== canonical(expected))
      throw new Error(`research_protocol_context_mismatch:${key}`);
  }
  return { ...request, ...fixed };
}

export function summarizeResearchResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return { value: result ?? null };
  const value = { ...(result as Record<string, unknown>) };
  if (Array.isArray(value.rows)) {
    value.rowCount = value.rows.length;
    value.rows = value.rows.slice(0, 20);
  }
  if (Array.isArray(value.equityCurve)) value.equityCurve = value.equityCurve.slice(-20);
  if (Array.isArray(value.trades)) {
    value.tradeCount = value.trades.length;
    value.trades = undefined;
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** Claim exactly once; cancellation/expiry wins over late provider completion. */
export async function executeResearchAttempt<T>(
  attempt: ResearchAttempt,
  execute: () => Promise<T>
): Promise<T> {
  const claimed = await researchProgramService.claim(attempt.id);
  if (!claimed) throw new Error(`research_attempt_not_pending:${attempt.id}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remaining = Math.max(1, Date.parse(claimed.deadlineAt) - Date.now());
  try {
    const result = await Promise.race([
      execute(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("research_attempt_timed_out")), remaining);
      }),
    ]);
    const record = result as { error?: string; status?: string; meta?: { error?: string } } | null;
    if (record?.error || record?.meta?.error || record?.status === "failed") {
      throw new Error(record.error ?? record.meta?.error ?? "research_execution_failed");
    }
    const finished = await researchProgramService.finish(attempt.id, {
      status: "completed",
      resultJson: summarizeResearchResult(result),
    });
    if (finished.status !== "completed")
      throw new Error(`research_attempt_${finished.status}:${attempt.id}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await researchProgramService.finish(attempt.id, {
      status: message.includes("timed_out") ? "timed_out" : "failed",
      error: message,
    });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Shared by REST, builtins and the scoped research adapter. */
export async function withResearchExecution<T>(
  input: ResearchExecutionInput,
  execute: (request: Record<string, unknown>) => Promise<T>
): Promise<T> {
  const inherited = executionContext.getStore();
  if (inherited) {
    if (inherited.attempt.projectId !== input.projectId)
      throw new Error("research_execution_project_mismatch");
    if (
      inherited.attempt.kind !== "backtest" &&
      inherited.attempt.candidateId !== input.candidateId
    )
      throw new Error("research_execution_candidate_mismatch");
    const current = await researchProgramService.getAttempt(inherited.attempt.id);
    if (current.status !== "running" || Date.parse(current.deadlineAt) <= Date.now())
      throw new Error("research_execution_lease_expired");
    return execute(normalizeResearchRequest(inherited.protocol, input.kind, input.requestJson));
  }
  const overview = await researchProgramService.get(input.projectId);
  if (!overview.program) return execute(input.requestJson);
  const protocol = overview.protocols.find(
    (item) => item.id === overview.program?.activeProtocolId
  );
  if (!protocol) throw new Error("research_protocol_missing");
  const attempt = await researchProgramService.reserve({
    ...input,
    protocolId: protocol.id,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
  });
  return executeResearchAttempt(attempt, () =>
    runWithResearchContext(attempt, protocol, async () => {
      if (
        input.kind !== "backtest" &&
        (input.candidateJson.lang !== "qlib_expr" ||
          input.candidateJson.providerKey !== "qlib_expr")
      ) {
        throw new Error("controlled_research_requires_builtin_qlib_expr");
      }
      return execute(normalizeResearchRequest(protocol, input.kind, input.requestJson));
    })
  );
}
