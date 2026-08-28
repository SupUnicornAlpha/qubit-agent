import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { agentScore, alertEvent } from "../../../db/sqlite/schema";

export interface ScoreDailyRollupRow {
  day: string;
  name: string;
  count: number;
  avgNumeric: number | null;
  minNumeric: number | null;
  maxNumeric: number | null;
}

export async function queryScoreDailyRollup(input: {
  names?: string[];
  since?: string;
  until?: string;
}): Promise<ScoreDailyRollupRow[]> {
  const db = await getDb();
  const conds = [eq(agentScore.dataType, "NUMERIC")];
  if (input.since) conds.push(gte(agentScore.createdAt, input.since));
  if (input.until) conds.push(lt(agentScore.createdAt, input.until));
  if (input.names?.length) {
    const { inArray } = await import("drizzle-orm");
    conds.push(inArray(agentScore.name, input.names));
  }

  const dayExpr = sql<string>`substr(${agentScore.createdAt}, 1, 10)`;
  const rows = await db
    .select({
      day: dayExpr,
      name: agentScore.name,
      count: sql<number>`count(*)`,
      avgNumeric: sql<number | null>`avg(${agentScore.valueNumeric})`,
      minNumeric: sql<number | null>`min(${agentScore.valueNumeric})`,
      maxNumeric: sql<number | null>`max(${agentScore.valueNumeric})`,
    })
    .from(agentScore)
    .where(and(...conds))
    .groupBy(dayExpr, agentScore.name)
    .orderBy(dayExpr, agentScore.name);

  return rows.map((row) => ({
    day: row.day,
    name: row.name,
    count: row.count,
    avgNumeric: row.avgNumeric,
    minNumeric: row.minNumeric,
    maxNumeric: row.maxNumeric,
  }));
}

export async function compareScoreWindows(input: {
  name: string;
  recentDays?: number;
}): Promise<{
  name: string;
  recentAvg: number | null;
  baselineAvg: number | null;
  deltaPct: number | null;
  recentCount: number;
  baselineCount: number;
}> {
  const recentDays = input.recentDays ?? 7;
  const now = Date.now();
  const recentSince = new Date(now - recentDays * 86_400_000).toISOString();
  const baselineSince = new Date(now - recentDays * 2 * 86_400_000).toISOString();
  const baselineUntil = recentSince;

  const db = await getDb();
  const recentRows = await db
    .select({ value: agentScore.valueNumeric })
    .from(agentScore)
    .where(
      and(
        eq(agentScore.name, input.name),
        eq(agentScore.dataType, "NUMERIC"),
        gte(agentScore.createdAt, recentSince)
      )
    );
  const baselineRows = await db
    .select({ value: agentScore.valueNumeric })
    .from(agentScore)
    .where(
      and(
        eq(agentScore.name, input.name),
        eq(agentScore.dataType, "NUMERIC"),
        gte(agentScore.createdAt, baselineSince),
        lt(agentScore.createdAt, baselineUntil)
      )
    );

  const avg = (values: Array<number | null>) => {
    const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
  };

  const recentAvg = avg(recentRows.map((r) => r.value));
  const baselineAvg = avg(baselineRows.map((r) => r.value));
  const deltaPct =
    recentAvg !== null && baselineAvg !== null && baselineAvg !== 0
      ? ((recentAvg - baselineAvg) / Math.abs(baselineAvg)) * 100
      : null;

  return {
    name: input.name,
    recentAvg,
    baselineAvg,
    deltaPct,
    recentCount: recentRows.length,
    baselineCount: baselineRows.length,
  };
}

const WATCHED_SCORES = ["aqm.A-3", "aqm.weighted_score", "benchmark.overall.score"] as const;
const DROP_THRESHOLD_PCT = Number(process.env.QUBIT_SCORE_ALERT_DROP_PCT ?? 15);

async function findOpenScoreAlert(name: string) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(alertEvent)
    .where(
      and(
        eq(alertEvent.scopeType, "system"),
        eq(alertEvent.scopeId, "agent_eval"),
        eq(alertEvent.alertType, `score_regression:${name}`),
        eq(alertEvent.status, "open")
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function scanScoreRegressionAlerts(): Promise<{ created: number; scanned: number }> {
  const db = await getDb();
  let created = 0;
  for (const name of WATCHED_SCORES) {
    const comparison = await compareScoreWindows({ name });
    if (comparison.deltaPct === null || comparison.recentCount < 3 || comparison.baselineCount < 3) {
      continue;
    }
    if (comparison.deltaPct > -DROP_THRESHOLD_PCT) continue;

    const existing = await findOpenScoreAlert(name);
    if (existing) continue;

    await db.insert(alertEvent).values({
      id: randomUUID(),
      scopeType: "system",
      scopeId: "agent_eval",
      alertType: `score_regression:${name}`,
      severity: comparison.deltaPct <= -30 ? "error" : "warn",
      title: `Score regression: ${name}`,
      detailsJson: comparison,
      status: "open",
    });
    created += 1;
  }
  return { created, scanned: WATCHED_SCORES.length };
}

export async function listRecentScoreAlerts(limit = 20) {
  const db = await getDb();
  return db
    .select()
    .from(alertEvent)
    .where(
      and(eq(alertEvent.scopeType, "system"), eq(alertEvent.scopeId, "agent_eval"))
    )
    .orderBy(desc(alertEvent.createdAt))
    .limit(limit);
}
