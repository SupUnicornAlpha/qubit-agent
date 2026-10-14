import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { researchAttempt, researchStrategyEvent } from "../../db/sqlite/schema";
import { bindBacktestDataset } from "../backtest/dataset-snapshot-binding";
import { assessFactorDataIntegrity } from "../factor/factor-data-integrity";
import { getMarketSnapshotById } from "../market/contracts/market-snapshot-service";
import { type SealedEvaluatorClient, sealedEvaluatorClient } from "./evaluator-client";
import { evidenceDigest } from "./evidence-checksum";
import { executeResearchAttempt } from "./execution";
import { researchProgramService } from "./service";
import { researchStrategyRunner } from "./strategy-runner";
import { strategyValidationReceiptSchema } from "./strategy-validation-types";
import { ResearchProgramError } from "./types";

export async function strategyEvents(projectId: string, versionId: string) {
  await researchStrategyRunner.get(projectId, versionId);
  return (await getDb())
    .select()
    .from(researchStrategyEvent)
    .where(
      and(
        eq(researchStrategyEvent.projectId, projectId),
        eq(researchStrategyEvent.versionId, versionId)
      )
    )
    .orderBy(desc(researchStrategyEvent.sequence))
    .all();
}
export async function appendStrategyEvent(
  projectId: string,
  versionId: string,
  kind: typeof researchStrategyEvent.$inferInsert.kind,
  payloadJson: Record<string, unknown>,
  expectedRevision: number
) {
  await researchStrategyRunner.get(projectId, versionId);
  const db = await getDb();
  return db.transaction(
    (tx) => {
      const prior = tx
        .select()
        .from(researchStrategyEvent)
        .where(eq(researchStrategyEvent.versionId, versionId))
        .orderBy(desc(researchStrategyEvent.sequence))
        .get();
      if ((prior?.sequence ?? 0) !== expectedRevision)
        throw new ResearchProgramError(
          "strategy_revision_conflict",
          409,
          "策略已更新，请刷新后重试。"
        );
      if (
        tx
          .select()
          .from(researchAttempt)
          .where(
            and(
              eq(researchAttempt.candidateId, versionId),
              inArray(researchAttempt.status, ["pending", "running"])
            )
          )
          .get()
      )
        throw new ResearchProgramError("strategy_has_active_attempt", 409);
      const event = {
        id: randomUUID(),
        projectId,
        versionId,
        kind,
        payloadJson,
        sequence: expectedRevision + 1,
        createdAt: new Date().toISOString(),
      };
      tx.insert(researchStrategyEvent).values(event).run();
      return event;
    },
    { behavior: "immediate" }
  );
}
export class StrategyLifecycle {
  constructor(readonly evaluator: SealedEvaluatorClient = sealedEvaluatorClient) {}
  private running = new Map<string, Promise<unknown>>();
  async detail(projectId: string, versionId: string) {
    const version = await researchStrategyRunner.get(projectId, versionId);
    const overview = await researchProgramService.get(projectId);
    const events = await strategyEvents(projectId, versionId);
    const state = events.find((e) => e.kind === "state");
    const status = (state?.payloadJson.status ?? "research") as string;
    const attempts = overview.attempts.filter((a) => a.candidateId === versionId);
    const backtests = attempts.filter((a) => a.kind === "backtest");
    const readyRuns = backtests.filter(
      (a) =>
        a.status === "completed" &&
        (a.resultJson as { result?: { error?: string } })?.result &&
        !(a.resultJson as { result: { error?: string } }).result.error
    );
    let integrity: ReturnType<typeof assessFactorDataIntegrity> | null = null;
    let dataError: string | null = null;
    try {
      const dataset = await bindBacktestDataset({
        snapshotId: version.recipe.development.datasetSnapshotId,
        ...version.recipe.development,
        timeframe: "1d",
      });
      integrity = assessFactorDataIntegrity({
        factorId: version.recipe.factor.id,
        expr: version.recipe.factor.expr,
        lang: "qlib_expr",
        providerKey: "qlib_expr",
        dataset,
        startDate: version.recipe.development.startDate,
        endDate: version.recipe.development.endDate,
      });
    } catch (e) {
      dataError = e instanceof Error ? e.message : String(e);
    }
    const receiptAttempts = attempts.filter(
      (a) => a.kind === "sealed_strategy" && a.status === "completed"
    );
    const receipts = receiptAttempts.flatMap((a) => {
      const parsed = strategyValidationReceiptSchema.safeParse(a.resultJson);
      const plan = events.find(
        (e) => e.kind === "validation_plan" && e.id === a.requestJson.planId
      );
      if (
        !parsed.success ||
        !plan ||
        parsed.data.strategyFingerprint !== version.fingerprint ||
        parsed.data.planFingerprint !== plan.payloadJson.fingerprint
      )
        return [];
      return [{ attemptId: a.id, receipt: parsed.data }];
    });
    // Latest formal outcome wins; cherry-picking an earlier passed receipt is not promotion.
    const latest =
      receipts[0]?.attemptId === attempts.find((a) => a.kind === "sealed_strategy")?.id
        ? receipts[0]
        : undefined;
    const validated =
      status !== "archived" &&
      integrity?.status === "passed" &&
      latest?.receipt.status === "passed";
    return {
      version,
      revision: events[0]?.sequence ?? 0,
      status: status === "archived" ? "archived" : validated ? "validated" : status,
      events,
      attempts,
      receipts,
      integrity,
      dataError,
      source: overview.attempts.find((a) => a.id === version.recipe.sourceAttemptId) ?? null,
      protocol: overview.protocols.find((p) => p.id === version.recipe.sourceProtocolId) ?? null,
      checklist: [
        {
          code: "completed_backtest",
          passed: readyRuns.length > 0,
          label: "至少一次本版本成功回测",
        },
        {
          code: "input_integrity",
          passed: integrity?.status !== "failed" && integrity !== null,
          label: "冻结输入可读取且无已知前视错误",
        },
        {
          code: "verified_data",
          passed: integrity?.status === "passed",
          label: "开发数据具备时点来源证明",
        },
        {
          code: "independent_validation",
          passed: latest?.receipt.status === "passed",
          label: "最新策略封存验证通过",
        },
      ],
      readyRunIds: readyRuns.map((a) => a.id),
      tradingEligible: false,
    };
  }
  async transition(
    projectId: string,
    versionId: string,
    input: {
      status: "research" | "review" | "archived";
      referenceAttemptId?: string | undefined;
      reason: string;
      expectedRevision: number;
    }
  ) {
    const detail = await this.detail(projectId, versionId);
    if (
      input.status === "review" &&
      (!input.referenceAttemptId ||
        !detail.readyRunIds.includes(input.referenceAttemptId) ||
        !detail.checklist[1]?.passed)
    )
      throw new ResearchProgramError("strategy_review_evidence_required", 409);
    if (!input.reason.trim()) throw new ResearchProgramError("strategy_reason_required", 400);
    await appendStrategyEvent(
      projectId,
      versionId,
      "state",
      {
        status: input.status,
        referenceAttemptId: input.referenceAttemptId ?? null,
        reason: input.reason.trim(),
      },
      input.expectedRevision
    );
    return this.detail(projectId, versionId);
  }
  async compare(projectId: string, leftId: string, rightId: string) {
    const left = await this.detail(projectId, leftId);
    const right = await this.detail(projectId, rightId);
    const diffs: Array<{ field: string; left: unknown; right: unknown }> = [];
    const walk = (a: unknown, b: unknown, path: string) => {
      if (evidenceDigest(a ?? null) === evidenceDigest(b ?? null)) return;
      if (
        a &&
        b &&
        typeof a === "object" &&
        typeof b === "object" &&
        !Array.isArray(a) &&
        !Array.isArray(b)
      )
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
          walk(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key],
            path ? `${path}.${key}` : key
          );
      else diffs.push({ field: path, left: a ?? null, right: b ?? null });
    };
    walk(left.version.recipe, right.version.recipe, "");
    const comparable =
      evidenceDigest({
        data: left.version.recipe.development,
        execution: left.version.recipe.execution,
        engine: left.version.recipe.engine,
      }) ===
      evidenceDigest({
        data: right.version.recipe.development,
        execution: right.version.recipe.execution,
        engine: right.version.recipe.engine,
      });
    const metric = (d: typeof left) => {
      const a = d.attempts.find((a) => d.readyRunIds.includes(a.id));
      return a
        ? {
            attemptId: a.id,
            metrics: (a.resultJson as { result: { metrics: unknown } }).result.metrics,
          }
        : null;
    };
    return {
      leftId,
      rightId,
      diffs,
      comparable,
      reason: comparable
        ? "相同数据与执行条件，可对照开发结果；不代表独立验证。"
        : "数据或执行条件不同，禁止直接绩效排名。",
      performance: comparable ? { left: metric(left), right: metric(right) } : null,
    };
  }
  async plan(projectId: string, versionId: string, expectedRevision: number) {
    const d = await this.detail(projectId, versionId);
    if (d.status !== "review" && d.status !== "validated")
      throw new ResearchProgramError("strategy_review_required", 409);
    const overview = await researchProgramService.get(projectId);
    const protocol = overview.protocols.find((p) => p.id === overview.program?.activeProtocolId);
    if (!protocol) throw new ResearchProgramError("research_protocol_not_found", 404);
    const datasetId = protocol.spec.evaluation.sealedDatasetId;
    if (!datasetId) throw new ResearchProgramError("research_sealed_dataset_not_configured", 409);
    const dataset = await this.evaluator.requireDataset(datasetId);
    if (!dataset.strategyPolicy)
      throw new ResearchProgramError("strategy_validation_not_supported", 409);
    if (dataset.datasetFingerprint !== protocol.spec.evaluation.sealedDatasetFingerprint)
      throw new ResearchProgramError("sealed_dataset_version_changed", 409);
    const snapshot = await getMarketSnapshotById(d.version.recipe.development.datasetSnapshotId);
    const catalog = await this.evaluator.catalog();
    if (!catalog.configured || !snapshot)
      throw new ResearchProgramError("strategy_input_unavailable", 409);
    if (
      Object.values(snapshot.barsByInstrument).some((bars) =>
        bars.some((b) =>
          catalog.datasets.some(
            (ds) =>
              b.timestamp.slice(0, 10) >= ds.startDate && b.timestamp.slice(0, 10) <= ds.endDate
          )
        )
      )
    )
      throw new ResearchProgramError("research_development_overlaps_sealed_data", 409);
    if (d.version.recipe.development.endDate >= dataset.startDate)
      throw new ResearchProgramError("sealed_period_must_follow_development", 409);
    const state = d.events.find((e) => e.kind === "state");
    const payload = {
      versionId,
      strategyFingerprint: d.version.fingerprint,
      protocolId: protocol.id,
      protocolFingerprint: protocol.fingerprint,
      dataset,
      policyFingerprint: evidenceDigest(dataset.strategyPolicy),
      referenceAttemptId: state?.payloadJson.referenceAttemptId,
    };
    const fingerprint = evidenceDigest(payload);
    const prior = d.events.find(
      (e) => e.kind === "validation_plan" && e.payloadJson.fingerprint === fingerprint
    );
    if (prior) return prior;
    return appendStrategyEvent(
      projectId,
      versionId,
      "validation_plan",
      { ...payload, fingerprint },
      expectedRevision
    );
  }
  async validate(projectId: string, versionId: string, planId: string, idempotencyKey: string) {
    const d = await this.detail(projectId, versionId);
    const prior = d.attempts.find((a) => a.idempotencyKey === idempotencyKey);
    if (prior) {
      if (prior.kind !== "sealed_strategy" || prior.requestJson.planId !== planId)
        throw new ResearchProgramError("research_idempotency_conflict", 409);
      return prior;
    }
    if (d.status !== "review" && d.status !== "validated")
      throw new ResearchProgramError("strategy_review_required", 409);
    const plan = d.events.find((e) => e.id === planId && e.kind === "validation_plan");
    if (!plan) throw new ResearchProgramError("strategy_plan_not_found", 404);
    const payload = plan.payloadJson;
    const overview = await researchProgramService.get(projectId);
    if (payload.protocolId !== overview.program?.activeProtocolId)
      throw new ResearchProgramError("research_protocol_not_active", 409);
    const dataset = await this.evaluator.requireDataset((payload.dataset as { id: string }).id);
    if (evidenceDigest(dataset) !== evidenceDigest(payload.dataset))
      throw new ResearchProgramError("sealed_dataset_version_changed", 409);
    const attempt = await researchProgramService.reserve({
      projectId,
      protocolId: String(payload.protocolId),
      kind: "sealed_strategy",
      candidateId: versionId,
      candidateJson: { recipe: d.version.recipe, fingerprint: d.version.fingerprint },
      requestJson: { planId, planFingerprint: payload.fingerprint },
      idempotencyKey,
      evaluationBudget: { key: this.evaluator.budgetKey(dataset), limit: dataset.maxEvaluations },
    });
    if (attempt.status === "pending" && !this.running.has(attempt.id)) {
      const work = executeResearchAttempt(attempt, () =>
        this.evaluator.evaluateStrategy({
          version: "sealed-strategy-request-v1",
          attemptId: attempt.id,
          protocolFingerprint: String(payload.protocolFingerprint),
          planFingerprint: String(payload.fingerprint),
          strategyFingerprint: d.version.fingerprint,
          datasetId: dataset.id,
          datasetFingerprint: dataset.datasetFingerprint,
          policyFingerprint: String(payload.policyFingerprint),
          recipe: d.version.recipe,
        })
      )
        .catch(() => undefined)
        .finally(() => this.running.delete(attempt.id));
      this.running.set(attempt.id, work);
    }
    return attempt;
  }
  async wait(id: string) {
    await this.running.get(id);
    return researchProgramService.getAttempt(id);
  }
}
export const strategyLifecycle = new StrategyLifecycle();
