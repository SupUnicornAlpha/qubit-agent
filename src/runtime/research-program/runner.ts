import { bindBacktestDataset } from "../backtest/dataset-snapshot-binding";
import { type FactorRecord, factorService } from "../factor/factor-service";
import { getMarketSnapshotById } from "../market/contracts/market-snapshot-service";
import { pointInTimeMillis } from "../market/contracts/point-in-time-clock";
import {
  type SealedDatasetDescriptor,
  type SealedEvaluatorClient,
  sealedEvaluatorClient,
} from "./evaluator-client";
import { executeResearchAttempt, runWithResearchContext } from "./execution";
import { researchProgramService } from "./service";
import {
  type ResearchAttempt,
  ResearchProgramError,
  type ResearchProtocolSpec,
  researchProtocolSpecSchema,
} from "./types";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function frozenCandidate(factor: FactorRecord) {
  return {
    expr: factor.expr,
    lang: factor.lang,
    providerKey: factor.providerKey,
    universe: factor.universe,
    horizon: factor.horizon,
    definition: factor.definition,
    researchContract: factor.researchContract,
  };
}
function requireEvaluationMethod(spec: ResearchProtocolSpec, dataset: SealedDatasetDescriptor) {
  if (
    spec.evaluation.horizonDays !== dataset.horizonDays ||
    spec.evaluation.groupCount !== dataset.groupCount
  ) {
    throw new ResearchProgramError("sealed_evaluation_method_mismatch", 400);
  }
}
export class ResearchRunner {
  constructor(private readonly evaluator: SealedEvaluatorClient = sealedEvaluatorClient) {}
  private readonly running = new Map<string, Promise<void>>();
  async createProtocol(input: { projectId: string; spec: ResearchProtocolSpec }) {
    await researchProgramService.recoverExpired();
    const spec = researchProtocolSpecSchema.parse(input.spec);
    // Validate the real, immutable snapshot before activating a protocol.
    await bindBacktestDataset({
      snapshotId: spec.development.datasetSnapshotId,
      symbols: spec.development.symbols,
      startDate: spec.development.startDate,
      endDate: spec.development.endDate,
      timeframe: "1d",
    });
    const record = await getMarketSnapshotById(spec.development.datasetSnapshotId);
    if (!record || record.meta.timeframe !== "1d")
      throw new ResearchProgramError("research_requires_daily_snapshot", 400);
    const catalog = await this.evaluator.catalog();
    // An unavailable configured service cannot prove the development window
    // is disjoint from its sealed catalog. Removing sealedDatasetId must not
    // turn a network/configuration failure into permission to expose that data.
    if (!catalog.configured && catalog.reason !== "sealed_evaluator_not_configured") {
      throw new ResearchProgramError("sealed_evaluator_unavailable", 409);
    }
    if (spec.evaluation.sealedDatasetId) {
      if (!catalog.configured)
        throw new ResearchProgramError("sealed_evaluator_not_configured", 409);
      const sealed = catalog.datasets.find((item) => item.id === spec.evaluation.sealedDatasetId);
      if (!sealed) throw new ResearchProgramError("sealed_dataset_not_found", 404);
      requireEvaluationMethod(spec, sealed);
      spec.evaluation.sealedDatasetFingerprint = sealed.datasetFingerprint;
    }
    // A development snapshot cannot already contain ANY registered sealed period,
    // including future labels and unselected symbols. Clearing the selected ID does not bypass this.
    const dates = Object.values(record.barsByInstrument).flatMap((bars) =>
      bars.flatMap((bar) => [
        bar.timestamp.slice(0, 10),
        new Date(pointInTimeMillis(bar.timestamp)).toISOString().slice(0, 10),
      ])
    );
    if (
      catalog.datasets.some((sealed) =>
        dates.some((date) => date >= sealed.startDate && date <= sealed.endDate)
      )
    ) {
      throw new ResearchProgramError("research_development_overlaps_sealed_data", 400);
    }
    return researchProgramService.createProtocol({ projectId: input.projectId, spec });
  }
  async submitFactor(input: {
    projectId: string;
    factorId: string;
    kind: "factor_compute" | "factor_evaluate" | "sealed_factor";
    idempotencyKey: string;
  }): Promise<ResearchAttempt> {
    await researchProgramService.recoverExpired();
    const overview = await researchProgramService.get(input.projectId);
    if (!overview.program) throw new ResearchProgramError("research_program_not_found", 404);
    // Retries keep the old protocol, candidate and receipt even after a new version is active.
    const prior = overview.attempts.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (prior) {
      if (prior.candidateId !== input.factorId || prior.kind !== input.kind)
        throw new ResearchProgramError("research_idempotency_conflict", 409);
      return prior;
    }
    const factor = await factorService.get(input.factorId);
    if (factor.projectId !== input.projectId)
      throw new ResearchProgramError("research_factor_project_mismatch", 400);
    const protocol = overview.protocols.find(
      (item) => item.id === overview.program?.activeProtocolId
    );
    if (!protocol) throw new ResearchProgramError("research_protocol_not_found", 404);
    let sealed: SealedDatasetDescriptor | undefined;
    if (input.kind === "sealed_factor") {
      if (!protocol.spec.evaluation.sealedDatasetId)
        throw new ResearchProgramError("research_sealed_dataset_not_configured", 409);
      sealed = await this.evaluator.requireDataset(protocol.spec.evaluation.sealedDatasetId);
      requireEvaluationMethod(protocol.spec, sealed);
      if (protocol.spec.evaluation.sealedDatasetFingerprint !== sealed.datasetFingerprint) {
        throw new ResearchProgramError("sealed_dataset_version_changed", 409);
      }
    }
    const attempt = await researchProgramService.reserve({
      projectId: input.projectId,
      protocolId: protocol.id,
      kind: input.kind,
      candidateId: factor.id,
      candidateJson: frozenCandidate(factor),
      requestJson: {
        factorId: factor.id,
        ...protocol.spec.development,
        horizonDays: protocol.spec.evaluation.horizonDays,
        groupCount: protocol.spec.evaluation.groupCount,
        ...(sealed ? { sealedDataset: sealed } : {}),
      },
      idempotencyKey: input.idempotencyKey,
      ...(sealed
        ? {
            evaluationBudget: {
              key: this.evaluator.budgetKey(sealed),
              limit: sealed.maxEvaluations,
            },
          }
        : {}),
    });
    if (attempt.status === "pending" && !this.running.has(attempt.id)) {
      const work = executeResearchAttempt(attempt, () =>
        runWithResearchContext(attempt, protocol, async () => {
          if (factor.lang !== "qlib_expr" || factor.providerKey !== "qlib_expr")
            throw new Error("controlled_research_requires_builtin_qlib_expr");
          const latest = await factorService.get(factor.id);
          if (canonical(frozenCandidate(latest)) !== canonical(attempt.candidateJson)) {
            throw new Error("research_candidate_changed_after_reservation");
          }
          if (input.kind === "sealed_factor") {
            if (!sealed) throw new Error("sealed_dataset_not_found");
            return this.evaluator.evaluate(attempt, protocol, sealed);
          }
          const request = { factorId: factor.id, ...protocol.spec.development };
          if (input.kind === "factor_compute") return factorService.compute(request);
          return factorService.autoEvaluate({
            ...request,
            horizonDays: protocol.spec.evaluation.horizonDays,
            groupCount: protocol.spec.evaluation.groupCount,
            decayHorizons: [protocol.spec.evaluation.horizonDays],
          });
        })
      )
        .then(
          () => undefined,
          () => undefined
        )
        .finally(() => {
          this.running.delete(attempt.id);
        });
      this.running.set(attempt.id, work);
    }
    return attempt;
  }
  /** Useful to CLI callers/tests; HTTP returns immediately and the UI polls the durable ledger. */
  async waitForAttempt(id: string) {
    await this.running.get(id);
    return researchProgramService.getAttempt(id);
  }
  async cancel(projectId: string, attemptId: string) {
    const attempt = await researchProgramService.getAttempt(attemptId);
    if (attempt.projectId !== projectId)
      throw new ResearchProgramError("research_attempt_not_found", 404);
    return researchProgramService.cancel(attempt.id);
  }
}
export const researchRunner = new ResearchRunner();
