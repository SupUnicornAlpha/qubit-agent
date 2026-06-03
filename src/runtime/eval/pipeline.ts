/**
 * 评测 Pipeline — P3-2 重写
 *
 * 之前（159 行）：`scoreWithToggle` 用魔法常数 `base=0.56 + 0.16*msa + 0.12*sdp +
 * 0.18*rfv` 合成出 fake "评测分"，每个 case 的 score 都是
 * `primaryScore + (i % 5) * 0.01 - 0.02` 的确定性合成；**完全没有真模型调用 /
 * 真实数据读**。UI "评测报告" tab 因此一直是误导性的。
 *
 * 现在（评估报告 P3-2）：扫真实 `factor_evaluation` 表，每条评测作为一个 case：
 *   - score = abs(rank_ic) → abs(ic) → 0（fallback）
 *   - pass  = score >= icThreshold（默认 0.03，因子界常用阈值）
 *   - summary = {caseCount, passCount, passRate, avgScore, avgIc, avgRankIc,
 *                topFactorId, dataSource:'factor_evaluation', insufficient?}
 *
 * Toggle 旧字段（msa/sdp/rfv）保留但 deprecated（写入 configSnapshot 的
 * `__deprecated_toggle` 字段，避免破坏前端 / monitor.routes 的 schema 兼容）。
 * 新字段（语义明确）：
 *   - icThreshold     ：pass 阈值（默认 0.03）
 *   - minSampleSize   ：过滤掉 sample_size 太小的 evaluation
 *   - sinceDays       ：只看最近 N 天
 *   - category        ：只看某 category 的 factor（momentum / value / ...）
 *   - projectId       ：限定项目（默认从 dataset.metaJson.projectId 取）
 *
 * 数据不足兜底：当 factor_evaluation 没满足条件的数据时，run 仍 completed，
 * summary.insufficient = true，UI 看到 0 case 时显示 "暂无 evaluation 数据"。
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  evalCaseResult,
  evalDataset,
  evalRun,
  factorDefinition,
  factorEvaluation,
} from "../../db/sqlite/schema";

/**
 * Toggle 形状（兼容旧 API）：
 *   - msa/sdp/rfv：DEPRECATED，仅保留以不破坏前端调用；服务端会把它们写入
 *     configSnapshotJson.__deprecated_toggle 留痕，**不参与评分**
 *   - icThreshold / minSampleSize / sinceDays / category / projectId：新字段
 */
export type EvalToggle = {
  msa?: boolean;
  sdp?: boolean;
  rfv?: boolean;
  icThreshold?: number;
  minSampleSize?: number;
  sinceDays?: number;
  category?: string;
  projectId?: string;
};

const DEFAULT_IC_THRESHOLD = 0.03;
const DEFAULT_MIN_SAMPLE_SIZE = 0;
const DEFAULT_CASE_COUNT = 10;
const MAX_CASE_COUNT = 100;
const MIN_CASE_COUNT = 1;

interface EvaluationCase {
  factorId: string;
  factorName: string | null;
  factorCategory: string | null;
  asof: string;
  universe: string;
  ic: number | null;
  rankIc: number | null;
  ir: number | null;
  sampleSize: number;
  score: number;
  pass: boolean;
}

interface RunSummary {
  caseCount: number;
  passCount: number;
  passRate: number;
  avgScore: number;
  avgIc: number | null;
  avgRankIc: number | null;
  avgIr: number | null;
  topFactorId: string | null;
  topFactorScore: number | null;
  dataSource: "factor_evaluation";
  /** 没找到足够数据时 = true，UI 据此显示「先去因子工坊跑一些 evaluation」 */
  insufficient: boolean;
  icThreshold: number;
  filter: {
    minSampleSize: number;
    sinceDays?: number;
    category?: string;
    projectId?: string;
  };
  /** baselineToggle 的对比；不提供则 null */
  baselineRunId: string | null;
  baselinePassRate: number | null;
  baselineAvgScore: number | null;
  gainVsBaseline: number | null;
}

/**
 * 把 toggle 拍平成「过滤条件 + 阈值」，丢弃 deprecated 字段。
 * Deprecated 字段单独留痕到 configSnapshot 方便审计。
 */
function normalizeToggle(toggle: EvalToggle | undefined): {
  icThreshold: number;
  minSampleSize: number;
  sinceDays?: number;
  category?: string;
  projectId?: string;
  deprecated: { msa?: boolean; sdp?: boolean; rfv?: boolean };
} {
  const t = toggle ?? {};
  return {
    icThreshold:
      typeof t.icThreshold === "number" && Number.isFinite(t.icThreshold)
        ? t.icThreshold
        : DEFAULT_IC_THRESHOLD,
    minSampleSize:
      typeof t.minSampleSize === "number" && t.minSampleSize > 0
        ? Math.floor(t.minSampleSize)
        : DEFAULT_MIN_SAMPLE_SIZE,
    ...(typeof t.sinceDays === "number" && t.sinceDays > 0
      ? { sinceDays: Math.floor(t.sinceDays) }
      : {}),
    ...(typeof t.category === "string" && t.category.trim() !== ""
      ? { category: t.category.trim() }
      : {}),
    ...(typeof t.projectId === "string" && t.projectId.trim() !== ""
      ? { projectId: t.projectId.trim() }
      : {}),
    deprecated: {
      ...(t.msa !== undefined ? { msa: t.msa } : {}),
      ...(t.sdp !== undefined ? { sdp: t.sdp } : {}),
      ...(t.rfv !== undefined ? { rfv: t.rfv } : {}),
    },
  };
}

function scoreEvaluation(rankIc: number | null, ic: number | null): number {
  /**
   * 因子界惯例：rank IC 优先（对 outlier 更稳），否则降级用 pearson IC。
   * abs() 是因为「负 IC 是反向 alpha 同样有意义」。
   */
  const v = rankIc ?? ic;
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.abs(v);
}

/**
 * 拉 factor_evaluation 表里满足过滤条件的最近 N 条（join factor_definition
 * 拿 name/category）。返回的顺序：createdAt desc，pivot 到 EvaluationCase。
 */
async function fetchEvaluationCases(
  caseCount: number,
  filter: ReturnType<typeof normalizeToggle>
): Promise<EvaluationCase[]> {
  const db = await getDb();

  const conds = [] as Array<ReturnType<typeof eq>>;
  if (filter.category) {
    conds.push(eq(factorDefinition.category, filter.category));
  }
  if (filter.projectId) {
    conds.push(eq(factorDefinition.projectId, filter.projectId));
  }
  if (filter.minSampleSize > 0) {
    conds.push(gte(factorEvaluation.sampleSize, filter.minSampleSize));
  }
  if (filter.sinceDays) {
    const cutoff = new Date(Date.now() - filter.sinceDays * 86_400_000).toISOString();
    conds.push(gte(factorEvaluation.createdAt, cutoff));
  }

  const where = conds.length > 0 ? and(...conds) : undefined;

  const rows = await db
    .select({
      factorId: factorEvaluation.factorId,
      factorName: factorDefinition.name,
      factorCategory: factorDefinition.category,
      asof: factorEvaluation.asof,
      universe: factorEvaluation.universe,
      ic: factorEvaluation.ic,
      rankIc: factorEvaluation.rankIc,
      ir: factorEvaluation.ir,
      sampleSize: factorEvaluation.sampleSize,
      createdAt: factorEvaluation.createdAt,
    })
    .from(factorEvaluation)
    .leftJoin(factorDefinition, eq(factorEvaluation.factorId, factorDefinition.id))
    .where(where)
    .orderBy(desc(factorEvaluation.createdAt))
    .limit(caseCount);

  return rows.map((r) => {
    const score = scoreEvaluation(r.rankIc, r.ic);
    return {
      factorId: r.factorId,
      factorName: r.factorName ?? null,
      factorCategory: r.factorCategory ?? null,
      asof: r.asof,
      universe: r.universe,
      ic: r.ic ?? null,
      rankIc: r.rankIc ?? null,
      ir: r.ir ?? null,
      sampleSize: r.sampleSize,
      score,
      /** pass 阈值在 fetchEvaluationCases 后由 caller 重新打 — caller 持有 icThreshold */
      pass: false,
    };
  });
}

function summarizeCases(
  cases: EvaluationCase[],
  icThreshold: number,
  filter: ReturnType<typeof normalizeToggle>,
  baselineSummary: { passRate: number; avgScore: number; runId: string } | null
): RunSummary {
  if (cases.length === 0) {
    return {
      caseCount: 0,
      passCount: 0,
      passRate: 0,
      avgScore: 0,
      avgIc: null,
      avgRankIc: null,
      avgIr: null,
      topFactorId: null,
      topFactorScore: null,
      dataSource: "factor_evaluation",
      insufficient: true,
      icThreshold,
      filter: {
        minSampleSize: filter.minSampleSize,
        ...(filter.sinceDays !== undefined ? { sinceDays: filter.sinceDays } : {}),
        ...(filter.category !== undefined ? { category: filter.category } : {}),
        ...(filter.projectId !== undefined ? { projectId: filter.projectId } : {}),
      },
      baselineRunId: baselineSummary?.runId ?? null,
      baselinePassRate: baselineSummary?.passRate ?? null,
      baselineAvgScore: baselineSummary?.avgScore ?? null,
      gainVsBaseline: null,
    };
  }

  let passCount = 0;
  let sumScore = 0;
  let sumIc = 0;
  let sumIcN = 0;
  let sumRankIc = 0;
  let sumRankIcN = 0;
  let sumIr = 0;
  let sumIrN = 0;
  let topFactorId = cases[0]!.factorId;
  let topFactorScore = cases[0]!.score;

  for (const c of cases) {
    if (c.pass) passCount += 1;
    sumScore += c.score;
    if (c.ic !== null && Number.isFinite(c.ic)) {
      sumIc += c.ic;
      sumIcN += 1;
    }
    if (c.rankIc !== null && Number.isFinite(c.rankIc)) {
      sumRankIc += c.rankIc;
      sumRankIcN += 1;
    }
    if (c.ir !== null && Number.isFinite(c.ir)) {
      sumIr += c.ir;
      sumIrN += 1;
    }
    if (c.score > topFactorScore) {
      topFactorScore = c.score;
      topFactorId = c.factorId;
    }
  }

  const passRate = Number((passCount / cases.length).toFixed(4));
  const avgScore = Number((sumScore / cases.length).toFixed(4));

  return {
    caseCount: cases.length,
    passCount,
    passRate,
    avgScore,
    avgIc: sumIcN > 0 ? Number((sumIc / sumIcN).toFixed(4)) : null,
    avgRankIc: sumRankIcN > 0 ? Number((sumRankIc / sumRankIcN).toFixed(4)) : null,
    avgIr: sumIrN > 0 ? Number((sumIr / sumIrN).toFixed(4)) : null,
    topFactorId,
    topFactorScore: Number(topFactorScore.toFixed(4)),
    dataSource: "factor_evaluation",
    insufficient: false,
    icThreshold,
    filter: {
      minSampleSize: filter.minSampleSize,
      ...(filter.sinceDays !== undefined ? { sinceDays: filter.sinceDays } : {}),
      ...(filter.category !== undefined ? { category: filter.category } : {}),
      ...(filter.projectId !== undefined ? { projectId: filter.projectId } : {}),
    },
    baselineRunId: baselineSummary?.runId ?? null,
    baselinePassRate: baselineSummary?.passRate ?? null,
    baselineAvgScore: baselineSummary?.avgScore ?? null,
    gainVsBaseline:
      baselineSummary !== null ? Number((avgScore - baselineSummary.avgScore).toFixed(4)) : null,
  };
}

export async function createEvalDataset(input: {
  name: string;
  version?: string;
  scenario?: string;
  sourceDesc?: string;
  metaJson?: Record<string, unknown>;
}) {
  const db = await getDb();
  const id = randomUUID();
  await db.insert(evalDataset).values({
    id,
    name: input.name,
    version: input.version ?? "v1",
    scenario: input.scenario ?? "factor_eval",
    sourceDesc: input.sourceDesc ?? "factor_evaluation 表汇总",
    metaJson: input.metaJson ?? {},
  });
  const rows = await db.select().from(evalDataset).where(eq(evalDataset.id, id)).limit(1);
  return rows[0];
}

export async function listEvalDatasets() {
  const db = await getDb();
  return db.select().from(evalDataset).orderBy(desc(evalDataset.createdAt));
}

/**
 * 跑一轮评测：扫真实 factor_evaluation 表，每条作 case。
 *
 * 评测语义：「最近 N 个 factor 评测里，有多少 abs(rankIC) >= icThreshold？」
 *   - 用 toggle 过滤 category / 项目 / 时间窗 / 样本量下限
 *   - 提供 baselineToggle 时跑两次（baseline 是另一组过滤参数，常见用法：
 *     baseline 不限 category 看全集，toggle 限定某 category 看局部 vs 全集）
 *
 * 数据不足兜底：cases 为空时仍写 run（status=completed），summary.insufficient=true
 */
export async function runEval(input: {
  datasetId: string;
  toggle?: EvalToggle;
  caseCount?: number;
  baselineToggle?: EvalToggle;
}) {
  const db = await getDb();
  const runId = randomUUID();
  const baselineRunId = input.baselineToggle ? randomUUID() : null;
  const now = new Date().toISOString();

  const caseCount = Math.max(
    MIN_CASE_COUNT,
    Math.min(MAX_CASE_COUNT, input.caseCount ?? DEFAULT_CASE_COUNT)
  );

  const datasetRows = await db
    .select()
    .from(evalDataset)
    .where(eq(evalDataset.id, input.datasetId))
    .limit(1);
  const dataset = datasetRows[0];
  if (!dataset) {
    throw new Error(`eval_dataset_not_found: ${input.datasetId}`);
  }

  const datasetMeta = (dataset.metaJson ?? {}) as Record<string, unknown>;
  const datasetProjectId =
    typeof datasetMeta["projectId"] === "string" ? (datasetMeta["projectId"] as string) : undefined;

  /** dataset.metaJson.projectId 作为 toggle.projectId 的默认值（若 toggle 没传） */
  const primaryToggle: EvalToggle = {
    ...(input.toggle ?? {}),
    ...(input.toggle?.projectId || !datasetProjectId
      ? {}
      : { projectId: datasetProjectId }),
  };
  const primaryFilter = normalizeToggle(primaryToggle);

  await db.insert(evalRun).values({
    id: runId,
    datasetId: input.datasetId,
    status: "running",
    startedAt: now,
    configSnapshotJson: {
      toggle: primaryToggle,
      __deprecated_toggle: primaryFilter.deprecated,
      __notes: "P3-2: 真实 factor_evaluation 读，msa/sdp/rfv 已 deprecated 不参与评分",
    },
  });

  let baselineSummary: { passRate: number; avgScore: number; runId: string } | null = null;
  if (baselineRunId) {
    const baselineToggle: EvalToggle = {
      ...(input.baselineToggle ?? {}),
      ...(input.baselineToggle?.projectId || !datasetProjectId
        ? {}
        : { projectId: datasetProjectId }),
    };
    const baselineFilter = normalizeToggle(baselineToggle);
    await db.insert(evalRun).values({
      id: baselineRunId,
      datasetId: input.datasetId,
      status: "running",
      startedAt: now,
      configSnapshotJson: {
        toggle: baselineToggle,
        __deprecated_toggle: baselineFilter.deprecated,
        __notes: "P3-2 baseline run",
      },
    });
    const baselineCases = await fetchEvaluationCases(caseCount, baselineFilter);
    for (const c of baselineCases) {
      c.pass = c.score >= baselineFilter.icThreshold;
    }
    const summary = summarizeCases(baselineCases, baselineFilter.icThreshold, baselineFilter, null);
    await persistCases(baselineCases, baselineRunId);
    await db
      .update(evalRun)
      .set({
        status: "completed",
        endedAt: new Date().toISOString(),
        summaryMetricsJson: summary,
      })
      .where(eq(evalRun.id, baselineRunId));
    baselineSummary = {
      passRate: summary.passRate,
      avgScore: summary.avgScore,
      runId: baselineRunId,
    };
  }

  const primaryCases = await fetchEvaluationCases(caseCount, primaryFilter);
  for (const c of primaryCases) {
    c.pass = c.score >= primaryFilter.icThreshold;
  }
  const summary = summarizeCases(primaryCases, primaryFilter.icThreshold, primaryFilter, baselineSummary);
  await persistCases(primaryCases, runId);

  await db
    .update(evalRun)
    .set({ status: "completed", endedAt: new Date().toISOString(), summaryMetricsJson: summary })
    .where(eq(evalRun.id, runId));

  return { runId, baselineRunId, summaryMetricsJson: summary };
}

async function persistCases(cases: EvaluationCase[], runId: string): Promise<void> {
  if (cases.length === 0) return;
  const db = await getDb();
  await db.insert(evalCaseResult).values(
    cases.map((c) => ({
      id: randomUUID(),
      evalRunId: runId,
      caseKey: `${c.factorId.slice(0, 12)}_${c.asof}`,
      expectedJson: { passThreshold: 0.03, metric: "abs(rank_ic)" },
      actualJson: {
        factorId: c.factorId,
        factorName: c.factorName,
        factorCategory: c.factorCategory,
        ic: c.ic,
        rankIc: c.rankIc,
        ir: c.ir,
        sampleSize: c.sampleSize,
        universe: c.universe,
        asof: c.asof,
      },
      score: c.score,
      pass: c.pass,
    }))
  );
}

export async function listEvalRuns(datasetId?: string) {
  const db = await getDb();
  const rows = await db.select().from(evalRun).orderBy(desc(evalRun.createdAt));
  if (!datasetId) return rows;
  return rows.filter((row) => row.datasetId === datasetId);
}

export async function getEvalRunDetail(runId: string) {
  const db = await getDb();
  const runRows = await db.select().from(evalRun).where(eq(evalRun.id, runId)).limit(1);
  const run = runRows[0];
  if (!run) throw new Error("eval run not found");
  const cases = await db.select().from(evalCaseResult).where(eq(evalCaseResult.evalRunId, runId));
  return { run, cases };
}
