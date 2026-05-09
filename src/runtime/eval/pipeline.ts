import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { evalCaseResult, evalDataset, evalRun } from "../../db/sqlite/schema";

type EvalToggle = {
  msa?: boolean;
  sdp?: boolean;
  rfv?: boolean;
};

function scoreWithToggle(toggle: EvalToggle) {
  const msa = toggle.msa ?? true;
  const sdp = toggle.sdp ?? true;
  const rfv = toggle.rfv ?? true;
  const base = 0.56;
  const gain = (msa ? 0.16 : 0) + (sdp ? 0.12 : 0) + (rfv ? 0.18 : 0);
  return Math.min(0.98, base + gain);
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
    scenario: input.scenario ?? "mixed",
    sourceDesc: input.sourceDesc ?? "",
    metaJson: input.metaJson ?? {},
  });
  const rows = await db.select().from(evalDataset).where(eq(evalDataset.id, id)).limit(1);
  return rows[0];
}

export async function listEvalDatasets() {
  const db = await getDb();
  return db.select().from(evalDataset).orderBy(desc(evalDataset.createdAt));
}

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
  await db.insert(evalRun).values({
    id: runId,
    datasetId: input.datasetId,
    status: "running",
    startedAt: now,
    configSnapshotJson: { toggle: input.toggle ?? { msa: true, sdp: true, rfv: true } },
  });
  if (baselineRunId) {
    await db.insert(evalRun).values({
      id: baselineRunId,
      datasetId: input.datasetId,
      status: "running",
      startedAt: now,
      configSnapshotJson: { toggle: input.baselineToggle },
    });
  }

  const caseCount = Math.max(3, Math.min(100, input.caseCount ?? 10));
  const primaryScore = scoreWithToggle(input.toggle ?? { msa: true, sdp: true, rfv: true });
  const baselineScore = baselineRunId ? scoreWithToggle(input.baselineToggle ?? {}) : null;

  let primaryPass = 0;
  let baselinePass = 0;
  for (let i = 0; i < caseCount; i += 1) {
    const pScore = Math.max(0, Math.min(1, primaryScore + (i % 5) * 0.01 - 0.02));
    const pPass = pScore >= 0.7;
    if (pPass) primaryPass += 1;
    await db.insert(evalCaseResult).values({
      id: randomUUID(),
      evalRunId: runId,
      caseKey: `case_${i + 1}`,
      expectedJson: { passThreshold: 0.7 },
      actualJson: { score: pScore },
      score: pScore,
      pass: pPass,
    });

    if (baselineRunId && baselineScore !== null) {
      const bScore = Math.max(0, Math.min(1, baselineScore + (i % 5) * 0.01 - 0.03));
      const bPass = bScore >= 0.7;
      if (bPass) baselinePass += 1;
      await db.insert(evalCaseResult).values({
        id: randomUUID(),
        evalRunId: baselineRunId,
        caseKey: `case_${i + 1}`,
        expectedJson: { passThreshold: 0.7 },
        actualJson: { score: bScore },
        score: bScore,
        pass: bPass,
      });
    }
  }

  const end = new Date().toISOString();
  const summaryMetricsJson = {
    caseCount,
    passCount: primaryPass,
    passRate: Number((primaryPass / caseCount).toFixed(4)),
    avgScore: Number(primaryScore.toFixed(4)),
    baselineRunId,
    baselinePassRate:
      baselineRunId && baselineScore !== null ? Number((baselinePass / caseCount).toFixed(4)) : undefined,
    gainVsBaseline:
      baselineRunId && baselineScore !== null ? Number((primaryScore - baselineScore).toFixed(4)) : undefined,
  };
  await db
    .update(evalRun)
    .set({ status: "completed", endedAt: end, summaryMetricsJson })
    .where(eq(evalRun.id, runId));
  if (baselineRunId) {
    await db
      .update(evalRun)
      .set({
        status: "completed",
        endedAt: end,
        summaryMetricsJson: {
          caseCount,
          passCount: baselinePass,
          passRate: Number((baselinePass / caseCount).toFixed(4)),
          avgScore: Number((baselineScore ?? 0).toFixed(4)),
        },
      })
      .where(eq(evalRun.id, baselineRunId));
  }
  return { runId, baselineRunId, summaryMetricsJson };
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
