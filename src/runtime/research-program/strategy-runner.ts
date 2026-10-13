import { and, desc, eq } from "drizzle-orm";
import {
  type StrategyExecution,
  frozenStrategyRequest,
  recipeSchema,
  strategyExecutionSchema,
} from "./strategy-types";
export { strategyExecutionSchema } from "./strategy-types";
import { getDb } from "../../db/sqlite/client";
import { strategy, strategyVersion } from "../../db/sqlite/schema";
import { backtestJobService } from "../backtest/backtest-job-service";
import type { BacktestResult } from "../provider/types";
import { evidenceDigest } from "./evidence-checksum";
import { researchProgramService } from "./service";
import { ResearchProgramError } from "./types";

export function economicResultDigest(result: BacktestResult) {
  return evidenceDigest({
    equityCurve: result.equityCurve,
    trades: result.trades,
    metrics: result.metrics,
  });
}
const running = new Map<string, Promise<unknown>>();

export const researchStrategyRunner = {
  async artifact(projectId: string, versionId: string) {
    const version = await this.get(projectId, versionId);
    const detail = await researchProgramService.get(projectId);
    const runs = detail.attempts
      .filter((a) => a.kind === "backtest" && a.candidateId === versionId)
      .map((a) => {
        const job = a.resultJson as { id?: string; result?: BacktestResult } | null;
        return {
          attemptId: a.id,
          jobId: job?.id ?? `research_backtest_${a.id}`,
          protocolId: a.protocolId,
          status: a.status,
          createdAt: a.createdAt,
          error: a.error,
          result: job?.result ?? null,
          economicChecksum: job?.result ? economicResultDigest(job.result) : null,
        };
      });
    const evidence = {
      version,
      runs,
      usedAttempts: detail.program?.usedAttempts,
      scope: "development_only",
      tradingEligible: false,
      limitations: [
        "仅含冻结定义与回测输出，不含原始行情；重算需相同快照和实现。",
        "内容校验不等于独立验证或来源签名。",
        "此 Top-N 只做多策略与先前增量比较的多空分配不同。",
      ],
    };
    return {
      format: "qubit-research-strategy-artifact-v1",
      checksum: evidenceDigest(evidence),
      evidence,
    };
  },
  async create(projectId: string, sourceAttemptId: string, execution: StrategyExecution) {
    const rules = strategyExecutionSchema.parse(execution);
    const detail = await researchProgramService.get(projectId);
    if (detail.program?.status !== "active")
      throw new ResearchProgramError("research_program_not_active", 409);
    const source = detail.attempts.find((a) => a.id === sourceAttemptId);
    const result = source?.resultJson as { version?: string; verdict?: string } | null;
    if (
      !source ||
      source.status !== "completed" ||
      source.requestJson.operation !== "incremental_compare" ||
      result?.version !== "factor-incremental-v1" ||
      result.verdict !== "worth_validation"
    )
      throw new ResearchProgramError(
        "strategy_requires_incremental_evidence",
        409,
        "需要本项目已完成且建议进一步验证的增量比较。"
      );
    const protocol = detail.protocols.find((p) => p.id === source.protocolId);
    if (!protocol?.spec.comparison)
      throw new ResearchProgramError("research_protocol_not_found", 404);
    const f = source.candidateJson;
    // This first execution contract deliberately excludes A-share lot/T+1 rules and short borrow.
    if (f.lang !== "qlib_expr" || f.providerKey !== "qlib_expr" || f.universe !== "US")
      throw new ResearchProgramError(
        "strategy_requires_us_daily_qlib",
        400,
        "首版支持 US 日频内置表达式，采用只做多研究执行假设。"
      );
    if (rules.topN > protocol.spec.development.symbols.length)
      throw new ResearchProgramError("strategy_top_n_exceeds_universe", 400);
    const recipe = recipeSchema.parse({
      format: "qubit-research-strategy-v1",
      sourceAttemptId,
      sourceProtocolId: source.protocolId,
      factor: {
        id: f.id,
        name: f.name,
        expr: f.expr,
        universe: f.universe,
        direction: protocol.spec.comparison.candidateDirection,
      },
      development: protocol.spec.development,
      execution: rules,
      scope: "development_only",
      allocation: "long_only_top_n_equal",
      timing: "close_signal_next_open",
      engine: "event_driven",
    });
    const fingerprint = evidenceDigest(recipe);
    const suffix = evidenceDigest({ projectId, recipe }).slice(7, 39);
    const id = `research_strategy_${suffix}`;
    const parentId = `research_strategy_family_${evidenceDigest({ projectId, sourceAttemptId }).slice(7, 39)}`;
    const db = await getDb();
    db.transaction(
      (tx) => {
        // Identical frozen content has one version even across sessions and concurrent calls.
        tx.insert(strategy)
          .values({
            id: parentId,
            projectId,
            name: `研究策略 · ${recipe.factor.name}`,
            style: "low_freq",
            description: "仅开发研究：冻结因子、US 日频、只做多 Top-N；未经独立验证",
          })
          .onConflictDoNothing()
          .run();
        tx.insert(strategyVersion)
          .values({
            id,
            strategyId: parentId,
            versionTag: `research-${suffix.slice(0, 8)}`,
            logicHash: fingerprint,
            paramSchemaJson: recipe,
          })
          .onConflictDoNothing()
          .run();
      },
      { behavior: "immediate" }
    );
    return this.get(projectId, id);
  },
  async list(projectId: string) {
    const rows = await (await getDb())
      .select({
        id: strategyVersion.id,
        createdAt: strategyVersion.createdAt,
        recipe: strategyVersion.paramSchemaJson,
        fingerprint: strategyVersion.logicHash,
      })
      .from(strategyVersion)
      .innerJoin(strategy, eq(strategy.id, strategyVersion.strategyId))
      .where(eq(strategy.projectId, projectId))
      .orderBy(desc(strategyVersion.createdAt));
    return rows
      .filter((r) => (r.recipe as { format?: string })?.format === "qubit-research-strategy-v1")
      .map((r) => ({ ...r, recipe: recipeSchema.parse(r.recipe) }));
  },
  async get(projectId: string, versionId: string) {
    const row = (
      await (
        await getDb()
      )
        .select({
          id: strategyVersion.id,
          createdAt: strategyVersion.createdAt,
          recipe: strategyVersion.paramSchemaJson,
          fingerprint: strategyVersion.logicHash,
        })
        .from(strategyVersion)
        .innerJoin(strategy, eq(strategy.id, strategyVersion.strategyId))
        .where(and(eq(strategy.projectId, projectId), eq(strategyVersion.id, versionId)))
        .limit(1)
    )[0];
    if (!row) throw new ResearchProgramError("research_strategy_not_found", 404);
    const recipe = recipeSchema.parse(row.recipe);
    if (evidenceDigest(recipe) !== row.fingerprint)
      throw new ResearchProgramError(
        "research_strategy_modified",
        409,
        "策略版本内容已变化，拒绝使用旧指纹运行。"
      );
    return { ...row, recipe };
  },
  async submit(projectId: string, versionId: string, idempotencyKey: string) {
    const version = await this.get(projectId, versionId);
    const { recipe } = version;
    const existing = (await researchProgramService.get(projectId)).attempts.find(
      (a) => a.idempotencyKey === idempotencyKey
    );
    if (existing) {
      if (existing.kind !== "backtest" || existing.candidateId !== versionId)
        throw new ResearchProgramError("research_idempotency_conflict", 409);
      return {
        attemptId: existing.id,
        jobId: `research_backtest_${existing.id}`,
        strategyVersionId: versionId,
      };
    }
    const job = await backtestJobService.submit({
      ...frozenStrategyRequest(versionId, recipe, version.fingerprint, version.createdAt),
      idempotencyKey,
      createdBy: "user",
    });
    if (!running.has(job.id) && job.status === "pending") {
      const work = backtestJobService
        .run(job.id)
        .catch(() => undefined)
        .finally(() => running.delete(job.id));
      running.set(job.id, work);
    }
    return { attemptId: job.config.researchAttemptId, jobId: job.id, strategyVersionId: versionId };
  },
  async wait(jobId: string) {
    await running.get(jobId);
    return backtestJobService.get(jobId);
  },
};
