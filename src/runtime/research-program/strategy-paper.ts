import { backtestJobService } from "../backtest/backtest-job-service";
import { bindBacktestDataset } from "../backtest/dataset-snapshot-binding";
import { assessFactorDataIntegrity } from "../factor/factor-data-integrity";
import { getMarketSnapshotById } from "../market/contracts/market-snapshot-service";
import { EventDrivenBacktestProvider } from "../provider/impls/backtest/event-driven-backtest-provider";
import type { BacktestExecutionTrace } from "../provider/types";
import { sealedEvaluatorClient } from "./evaluator-client";
import { evidenceDigest } from "./evidence-checksum";
import { executeResearchAttempt } from "./execution";
import { researchProgramService } from "./service";
import { appendStrategyEvent, strategyEvents, strategyLifecycle } from "./strategy-lifecycle";
import { frozenStrategyRequest } from "./strategy-types";
import { ResearchProgramError } from "./types";

const stages = ["input", "signal", "target", "order", "fill", "position"] as const;
export function reconcileTraces(
  reference: BacktestExecutionTrace[],
  actual: BacktestExecutionTrace[]
) {
  const refs = new Map(reference.map((row) => [row.date, row]));
  return actual.map((row) => {
    const ref = refs.get(row.date);
    const changed = ref ? stages.filter((stage) => ref[stage] !== row[stage]) : [];
    return {
      date: row.date,
      status: !ref ? "no_reference" : changed.length ? "diverged" : "matched",
      firstDifference: changed[0] ?? null,
      changed,
    };
  });
}
type StepResult = {
  cursor: string;
  prefixDigest: string;
  traceRows: BacktestExecutionTrace[];
  differences: ReturnType<typeof reconcileTraces>;
  metrics: unknown;
};
const running = new Map<string, Promise<unknown>>();
export const strategyPaper = {
  async list(projectId: string, versionId: string) {
    const events = await strategyEvents(projectId, versionId);
    const detail = await researchProgramService.get(projectId);
    return events
      .filter((e) => e.kind === "paper_session")
      .map((event) => {
        const attempts = detail.attempts.filter(
          (a) => a.kind === "paper_step" && a.requestJson.sessionId === event.id
        );
        const last = attempts.find((a) => a.status === "completed");
        const state = events.find(
          (e) => e.kind === "paper_status" && e.payloadJson.sessionId === event.id
        );
        return {
          id: event.id,
          createdAt: event.createdAt,
          definition: event.payloadJson,
          status: state?.payloadJson.status ?? "running",
          automatic: state?.payloadJson.automatic === true,
          reason: state?.payloadJson.reason ?? null,
          cursor: (last?.resultJson as StepResult)?.cursor ?? null,
          attempts,
        };
      });
  },
  async create(
    projectId: string,
    versionId: string,
    referenceAttemptId: string,
    expectedRevision: number
  ) {
    const detail = await strategyLifecycle.detail(projectId, versionId);
    if (detail.status === "archived" || !detail.readyRunIds.includes(referenceAttemptId))
      throw new ResearchProgramError("paper_reference_backtest_required", 409);
    const job = await backtestJobService.get(`research_backtest_${referenceAttemptId}`);
    if (!job.result?.executionTrace?.length)
      throw new ResearchProgramError(
        "paper_reference_requires_trace_rerun",
        409,
        "请重新回测一次以生成逐阶段执行记录。"
      );
    return appendStrategyEvent(
      projectId,
      versionId,
      "paper_session",
      {
        referenceAttemptId,
        snapshotId: detail.version.recipe.development.datasetSnapshotId,
        startDate: detail.version.recipe.development.startDate,
        endDate: detail.version.recipe.development.endDate,
        mode: "daily_snapshot_replay",
        strategyFingerprint: detail.version.fingerprint,
        validationAtCreation: detail.status === "validated",
        tradingEligible: false,
      },
      expectedRevision
    );
  },
  async setStatus(
    projectId: string,
    versionId: string,
    sessionId: string,
    status: "paused" | "running",
    expectedRevision: number,
    automatic = false
  ) {
    if (!(await this.list(projectId, versionId)).some((s) => s.id === sessionId))
      throw new ResearchProgramError("paper_session_not_found", 404);
    return appendStrategyEvent(
      projectId,
      versionId,
      "paper_status",
      { sessionId, status, automatic },
      expectedRevision
    );
  },
  async advance(
    projectId: string,
    versionId: string,
    sessionId: string,
    input: {
      expectedCursor: string | null;
      idempotencyKey: string;
      bars: number;
      snapshotId?: string | undefined;
    }
  ) {
    const detail = await strategyLifecycle.detail(projectId, versionId);
    const session = (await this.list(projectId, versionId)).find((s) => s.id === sessionId);
    if (!session) throw new ResearchProgramError("paper_session_not_found", 404);
    const prior = detail.attempts.find((a) => a.idempotencyKey === input.idempotencyKey);
    if (prior) {
      if (
        prior.kind !== "paper_step" ||
        prior.requestJson.sessionId !== sessionId ||
        prior.requestJson.fromCursor !== input.expectedCursor ||
        prior.requestJson.bars !== input.bars ||
        prior.requestJson.requestedSnapshotId !== (input.snapshotId ?? null)
      )
        throw new ResearchProgramError("research_idempotency_conflict", 409);
      return prior;
    }
    if (session.status !== "running" || detail.status === "archived")
      throw new ResearchProgramError("paper_session_not_running", 409);
    if (input.expectedCursor !== session.cursor)
      throw new ResearchProgramError("paper_cursor_conflict", 409);
    const snapshotId =
      input.snapshotId ??
      String(
        session.attempts.find((a) => a.status === "completed")?.requestJson.snapshotId ??
          session.definition.snapshotId
      );
    const record = await getMarketSnapshotById(snapshotId);
    if (!record) throw new ResearchProgramError("paper_snapshot_missing", 404);
    const dates = [
      ...new Set(
        Object.values(record.barsByInstrument).flatMap((b) =>
          b.map((r) => r.timestamp.slice(0, 10))
        )
      ),
    ].sort();
    const catalog = await sealedEvaluatorClient.catalog();
    if (!catalog.configured && catalog.reason !== "sealed_evaluator_not_configured")
      throw new ResearchProgramError("sealed_evaluator_unavailable", 409);
    if (catalog.datasets.some((ds) => dates.some((d) => d >= ds.startDate && d <= ds.endDate)))
      throw new ResearchProgramError("paper_overlaps_sealed_data", 409);
    const eligible = dates.filter(
      (d) => d >= String(session.definition.startDate) && (!session.cursor || d > session.cursor)
    );
    const endDate = eligible.slice(0, input.bars).at(-1);
    if (!endDate)
      throw new ResearchProgramError(
        "paper_waiting_for_new_data",
        409,
        "没有新的日线，请提供追加数据快照后继续。"
      );
    const attempt = await researchProgramService.reserve({
      projectId,
      kind: "paper_step",
      candidateId: versionId,
      candidateJson: { fingerprint: detail.version.fingerprint },
      requestJson: {
        sessionId,
        fromCursor: session.cursor,
        bars: input.bars,
        requestedSnapshotId: input.snapshotId ?? null,
        snapshotId,
        endDate,
      },
      idempotencyKey: input.idempotencyKey,
    });
    if (attempt.status === "pending" && !running.has(attempt.id)) {
      const work = executeResearchAttempt(attempt, async () => {
        // Only the prefix reaches the signal engine. Future rows stay outside the computation.
        const dataset = await bindBacktestDataset({
          snapshotId,
          symbols: detail.version.recipe.development.symbols,
          startDate: String(session.definition.startDate),
          endDate,
          timeframe: "1d",
        });
        const integrity = assessFactorDataIntegrity({
          factorId: versionId,
          expr: detail.version.recipe.factor.expr,
          lang: "qlib_expr",
          providerKey: "qlib_expr",
          dataset,
          startDate: String(session.definition.startDate),
          endDate,
        });
        if (integrity.status === "failed") throw new Error("paper_input_integrity_failed");
        const req = frozenStrategyRequest(
          versionId,
          detail.version.recipe,
          detail.version.fingerprint,
          detail.version.createdAt
        );
        const result = await new EventDrivenBacktestProvider().run({ ...req, dataset, endDate });
        if (result.error || !result.executionTrace)
          throw new Error(result.error ?? "paper_trace_missing");
        const previous = session.attempts.find((a) => a.status === "completed")?.resultJson as
          | StepResult
          | undefined;
        if (
          previous &&
          evidenceDigest(
            result.executionTrace.filter((t) => t.date.slice(0, 10) <= previous.cursor)
          ) !== previous.prefixDigest
        )
          throw new Error(
            "paper_history_changed: input/signal/execution prefix differs; start a new session to review revised history"
          );
        const reference = await backtestJobService.get(
          `research_backtest_${session.definition.referenceAttemptId}`
        );
        const traceRows = result.executionTrace.filter(
          (t) => !session.cursor || t.date.slice(0, 10) > session.cursor
        );
        return {
          cursor: endDate,
          prefixDigest: evidenceDigest(result.executionTrace),
          traceRows,
          differences: reconcileTraces(reference.result?.executionTrace ?? [], traceRows),
          metrics: result.metrics,
          mode: "daily_snapshot_replay",
          tradingEligible: false,
        };
      })
        .catch(() => undefined)
        .finally(() => running.delete(attempt.id));
      running.set(attempt.id, work);
    }
    return attempt;
  },
  async wait(id: string) {
    await running.get(id);
    return researchProgramService.getAttempt(id);
  },
};
