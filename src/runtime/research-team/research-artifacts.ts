/**
 * 研究产物只读投影。
 *
 * Agent 研究由对话 turn 触发；本模块不再执行 MSA 融合，只为历史 workflow
 * 提供兼容性的融合/信号读取，供拓扑与报告页面展示。
 */

import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { analystSignal, signalFusionResult } from "../../db/sqlite/schema";
import type { AgentRole, AnalystSignalValue } from "../../types/entities";

export interface AnalystSignalFusionOutput {
  fusionId: string;
  ticker: string;
  fusedSignal: AnalystSignalValue;
  fusedConfidence: number;
  debateTriggered: boolean;
  weights: Record<string, number>;
  noAnalystSignals?: boolean;
  signalBreakdown: Array<{
    role: AgentRole;
    signal: AnalystSignalValue;
    confidence: number;
    weight: number;
    reasoning: string;
    structured?: Record<string, unknown>;
  }>;
}

/** 查询历史 workflow 的最新研究产物；不会创建或修改 Agent 任务。 */
export async function getLatestFusionForWorkflow(
  workflowRunId: string
): Promise<AnalystSignalFusionOutput | null> {
  const db = await getDb();
  const fusion = await db
    .select()
    .from(signalFusionResult)
    .where(eq(signalFusionResult.workflowRunId, workflowRunId))
    .orderBy(sql`created_at DESC`)
    .limit(1);

  if (!fusion[0]) return null;
  const f = fusion[0];
  const signals = await db
    .select()
    .from(analystSignal)
    .where(eq(analystSignal.workflowRunId, workflowRunId));

  return {
    fusionId: f.id,
    ticker: f.ticker,
    fusedSignal: f.fusedSignal as AnalystSignalValue,
    fusedConfidence: f.fusedConfidence,
    debateTriggered: Boolean(f.debateTriggered),
    weights: (f.weightsJson as Record<string, number>) ?? {},
    signalBreakdown: signals.map((s) => {
      const snapshot = (s.dataSnapshotJson as Record<string, unknown> | null) ?? null;
      const structured = snapshot?.structured as Record<string, unknown> | undefined;
      return {
        role: s.analystRole as AgentRole,
        signal: s.signal as AnalystSignalValue,
        confidence: s.confidence,
        weight: 1,
        reasoning: s.reasoning,
        ...(structured ? { structured } : {}),
      };
    }),
  };
}
