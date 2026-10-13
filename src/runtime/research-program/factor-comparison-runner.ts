import { createHash } from "node:crypto";
import { bindBacktestDataset } from "../backtest/dataset-snapshot-binding";
import { assessFactorDataIntegrity } from "../factor/factor-data-integrity";
import {
  type ComparisonFactor,
  evaluateFactorIncrement,
} from "../factor/factor-incremental-evaluation";
import { type FactorRecord, factorService } from "../factor/factor-service";
import { QlibExprFactorProvider } from "../provider/impls/factor/qlib-expr-factor-provider";
import { executeResearchAttempt } from "./execution";
import { researchProgramService } from "./service";
import { type FactorComparisonSpec, type ResearchAttempt, ResearchProgramError } from "./types";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function frozenComparisonFactor(factor: FactorRecord) {
  return {
    id: factor.id,
    name: factor.name,
    expr: factor.expr,
    lang: factor.lang,
    providerKey: factor.providerKey,
    universe: factor.universe,
    horizon: factor.horizon,
    definition: factor.definition,
    researchContract: factor.researchContract,
  };
}
export function comparisonFactorFingerprint(factor: FactorRecord): string {
  const { name: _name, ...definition } = frozenComparisonFactor(factor);
  return `sha256:${createHash("sha256").update(canonical(definition)).digest("hex")}`;
}
function assertFactor(factor: FactorRecord, projectId: string) {
  if (factor.projectId !== projectId)
    throw new ResearchProgramError("comparison_factor_project_mismatch", 400);
  if (factor.lang !== "qlib_expr" || factor.providerKey !== "qlib_expr")
    throw new ResearchProgramError("comparison_requires_builtin_qlib_expr", 400);
}
export async function bindComparisonReferences(
  projectId: string,
  comparison: FactorComparisonSpec
): Promise<FactorComparisonSpec> {
  const references = [];
  for (const ref of comparison.references) {
    const factor = await factorService.get(ref.factorId);
    assertFactor(factor, projectId);
    references.push({ ...ref, fingerprint: comparisonFactorFingerprint(factor) });
  }
  return {
    ...comparison,
    references: references.sort((a, b) => (a.factorId < b.factorId ? -1 : 1)),
  };
}

export class FactorComparisonRunner {
  private running = new Map<string, Promise<void>>();
  async submit(input: {
    projectId: string;
    factorId: string;
    idempotencyKey: string;
  }): Promise<ResearchAttempt> {
    const detail = await researchProgramService.get(input.projectId);
    if (!detail.program) throw new ResearchProgramError("research_program_not_found", 404);
    const prior = detail.attempts.find((a) => a.idempotencyKey === input.idempotencyKey);
    if (prior) {
      if (
        prior.candidateId !== input.factorId ||
        prior.kind !== "factor_evaluate" ||
        prior.requestJson.operation !== "incremental_compare"
      )
        throw new ResearchProgramError("research_idempotency_conflict", 409);
      return prior;
    }
    const protocol = detail.protocols.find((p) => p.id === detail.program?.activeProtocolId);
    if (!protocol?.spec.comparison)
      throw new ResearchProgramError(
        "comparison_protocol_required",
        409,
        "请先修订研究协议，登记对照因子、方向、加入权重及成本。"
      );
    const method = protocol.spec.comparison;
    if (method.references.some((r) => r.factorId === input.factorId))
      throw new ResearchProgramError(
        "comparison_candidate_is_reference",
        400,
        "候选不能同时作为自身的对照因子。"
      );
    const candidate = await factorService.get(input.factorId);
    assertFactor(candidate, input.projectId);
    const references: FactorRecord[] = [];
    for (const ref of method.references) {
      const factor = await factorService.get(ref.factorId);
      assertFactor(factor, input.projectId);
      if (ref.fingerprint !== comparisonFactorFingerprint(factor))
        throw new ResearchProgramError(
          "comparison_reference_version_changed",
          409,
          "对照因子内容已变化，请重新登记协议版本。"
        );
      references.push(factor);
    }
    // Incremental comparison is one development factor_evaluate attempt. It does
    // not consume sealed quota and cannot masquerade as independent validation.
    const attempt = await researchProgramService.reserve({
      projectId: input.projectId,
      protocolId: protocol.id,
      kind: "factor_evaluate",
      candidateId: candidate.id,
      candidateJson: frozenComparisonFactor(candidate),
      requestJson: {
        operation: "incremental_compare",
        method,
        development: protocol.spec.development,
        horizonDays: protocol.spec.evaluation.horizonDays,
        references: references.map(frozenComparisonFactor),
      },
      idempotencyKey: input.idempotencyKey,
    });
    if (attempt.status === "pending" && !this.running.has(attempt.id)) {
      const work = executeResearchAttempt(attempt, async () => {
        const spec = protocol.spec;
        const dataset = await bindBacktestDataset({
          snapshotId: spec.development.datasetSnapshotId,
          symbols: spec.development.symbols,
          startDate: spec.development.startDate,
          endDate: spec.development.endDate,
          timeframe: "1d",
        });
        const provider = new QlibExprFactorProvider();
        const factors = [candidate, ...references];
        const computed: ComparisonFactor[] = [];
        const integrity = [];
        for (const [index, factor] of factors.entries()) {
          const lease = await researchProgramService.getAttempt(attempt.id);
          if (lease.status !== "running") throw new Error("research_execution_lease_expired");
          const proof = assessFactorDataIntegrity({
            factorId: factor.id,
            expr: factor.expr,
            lang: factor.lang,
            providerKey: factor.providerKey,
            dataset,
            startDate: spec.development.startDate,
            endDate: spec.development.endDate,
          });
          if (proof.status === "failed" || proof.truncation?.status === "unsupported")
            throw new Error(
              `comparison_data_integrity_failed:${factor.id}:${proof.truncation?.issues.map((i) => i.code).join(",") ?? proof.status}`
            );
          integrity.push({
            factorId: factor.id,
            status: proof.status,
            pitVerdict: proof.pit.verdict,
            truncation: proof.truncation,
          });
          const result = await provider.compute({
            factorId: factor.id,
            expr: factor.expr,
            lang: "qlib_expr",
            universe: factor.universe,
            dataset,
            symbols: spec.development.symbols,
            startDate: spec.development.startDate,
            endDate: spec.development.endDate,
          });
          computed.push({
            id: factor.id,
            name: factor.name,
            expr: factor.expr,
            fingerprint: comparisonFactorFingerprint(factor),
            direction:
              index === 0
                ? method.candidateDirection
                : (method.references[index - 1]?.direction ?? 1),
            rows: result.rows,
          });
        }
        const first = computed[0];
        if (!first) throw new Error("comparison_candidate_missing");
        return {
          ...evaluateFactorIncrement({
            candidate: first,
            references: computed.slice(1),
            dataset,
            method,
            horizonDays: spec.evaluation.horizonDays,
            startDate: spec.development.startDate,
            endDate: spec.development.endDate,
          }),
          protocolId: protocol.id,
          protocolFingerprint: protocol.fingerprint,
          dataQualification: integrity.every((p) => p.status === "passed")
            ? "passed"
            : "research_only",
          dataIntegrity: integrity,
        };
      })
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
  async waitForAttempt(id: string) {
    await this.running.get(id);
    return researchProgramService.getAttempt(id);
  }
}
export const factorComparisonRunner = new FactorComparisonRunner();
