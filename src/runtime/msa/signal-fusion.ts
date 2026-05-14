/**
 * Multi-Signal Arbitration (MSA) — 多信号融合服务
 *
 * 接收多个 Analyst Agent 产出的信号，通过加权融合计算最终方向与置信度。
 * 动态权重：基于历史准确率 analyst_accuracy_log 动态调整。
 * 低置信度时返回 debateTriggered=true，由 Orchestrator 决定是否触发 SDP。
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { analystAccuracyLog, analystSignal, signalFusionResult } from "../../db/sqlite/schema";
import type { AgentRole, AnalystSignalValue } from "../../types/entities";

// 置信度低于此阈值时建议触发辩论
const DEBATE_CONFIDENCE_THRESHOLD = 0.55;

// 信号数值映射（用于加权平均计算）
const SIGNAL_SCORE: Record<AnalystSignalValue, number> = {
  buy: 1,
  hold: 0,
  sell: -1,
};

export interface RawAnalystSignal {
  definitionId: string;
  analystRole: AgentRole;
  ticker: string;
  signal: AnalystSignalValue;
  confidence: number;
  reasoning: string;
  dataSnapshot?: Record<string, unknown>;
}

export interface FusionOutput {
  fusionId: string;
  ticker: string;
  fusedSignal: AnalystSignalValue;
  fusedConfidence: number;
  debateTriggered: boolean;
  weights: Record<string, number>;
  signalBreakdown: Array<{
    role: AgentRole;
    signal: AnalystSignalValue;
    confidence: number;
    weight: number;
    reasoning: string;
  }>;
}

/**
 * 从 analyst_accuracy_log 查询每个分析师角色的历史准确率，
 * 返回动态权重（基础权重 1.0，±0.5 范围内调整）。
 */
async function loadDynamicWeights(
  definitionIds: string[]
): Promise<Record<string, number>> {
  const db = await getDb();
  const weights: Record<string, number> = {};

  for (const defId of definitionIds) {
    const rows = await db
      .select({
        total: sql<number>`COUNT(*)`,
        correct: sql<number>`SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END)`,
      })
      .from(analystAccuracyLog)
      .where(
        and(
          eq(analystAccuracyLog.definitionId, defId),
          sql`is_correct IS NOT NULL`
        )
      );

    const row = rows[0];
    const total = Number(row?.total ?? 0);
    const correct = Number(row?.correct ?? 0);

    if (total < 5) {
      // 历史数据不足，使用基础权重 1.0
      weights[defId] = 1.0;
    } else {
      const accuracy = correct / total;
      // 准确率 0.5 对应权重 1.0；0.7 对应 1.5；0.3 对应 0.5
      weights[defId] = Math.max(0.3, Math.min(2.0, 1.0 + (accuracy - 0.5) * 2.5));
    }
  }

  return weights;
}

/**
 * 核心融合算法：
 * 1. 每个信号的"有效权重" = signal_weight（来自 definition）× 置信度 × 动态权重
 * 2. 加权平均信号得分 ∈ [-1, 1]
 * 3. 将平均得分映射回 buy/sell/hold
 * 4. 融合置信度 = 有效权重之和 / 总信号数的标准化
 */
export async function fuseSignals(params: {
  workflowRunId: string;
  signals: RawAnalystSignal[];
  persistSignals?: Array<{
    agentInstanceId?: string;
    signal: RawAnalystSignal;
  }>;
  /** 当 signals 为空时仍写入一条占位融合记录（仅研究团队「无 analyst_*」场景） */
  tickerHint?: string;
}): Promise<FusionOutput> {
  const db = await getDb();
  const { workflowRunId, signals } = params;

  if (signals.length === 0) {
    const ticker = (params.tickerHint ?? "").trim() || "UNKNOWN";
    const fusionId = randomUUID();
    await db.insert(signalFusionResult).values({
      id: fusionId,
      workflowRunId,
      ticker,
      fusedSignal: "hold",
      fusedConfidence: 0.25,
      weightsJson: {},
      debateTriggered: true,
    });
    return {
      fusionId,
      ticker,
      fusedSignal: "hold",
      fusedConfidence: 0.25,
      debateTriggered: true,
      weights: {},
      signalBreakdown: [],
    };
  }

  const definitionIds = [...new Set(signals.map((s) => s.definitionId))];
  const dynamicWeights = await loadDynamicWeights(definitionIds);

  // Persist raw signals if provided
  if (params.persistSignals?.length) {
    for (const { agentInstanceId, signal: s } of params.persistSignals) {
      await db.insert(analystSignal).values({
        id: randomUUID(),
        workflowRunId,
        agentInstanceId: agentInstanceId ?? null,
        analystRole: s.analystRole,
        ticker: s.ticker,
        signal: s.signal,
        confidence: s.confidence,
        reasoning: s.reasoning,
        dataSnapshotJson: s.dataSnapshot ?? {},
      });
    }
  }

  // Compute weighted average
  let weightedSum = 0;
  let totalWeight = 0;
  const breakdown: FusionOutput["signalBreakdown"] = [];
  const weightsSnapshot: Record<string, number> = {};

  for (const s of signals) {
    const dynW = dynamicWeights[s.definitionId] ?? 1.0;
    const effectiveWeight = dynW * s.confidence;
    const scoreContribution = SIGNAL_SCORE[s.signal] * effectiveWeight;

    weightedSum += scoreContribution;
    totalWeight += effectiveWeight;
    weightsSnapshot[s.analystRole] = dynW;

    breakdown.push({
      role: s.analystRole,
      signal: s.signal,
      confidence: s.confidence,
      weight: dynW,
      reasoning: s.reasoning,
    });
  }

  const avgScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Map score to signal
  let fusedSignal: AnalystSignalValue;
  if (avgScore > 0.2) fusedSignal = "buy";
  else if (avgScore < -0.2) fusedSignal = "sell";
  else fusedSignal = "hold";

  // Confidence: normalized agreement (how much signals agree with the final direction)
  const agreementSum = signals.reduce((sum, s) => {
    const agree =
      (fusedSignal === "buy" && s.signal === "buy") ||
      (fusedSignal === "sell" && s.signal === "sell") ||
      (fusedSignal === "hold" && s.signal === "hold")
        ? 1
        : 0;
    return sum + agree * s.confidence;
  }, 0);

  // fusedConfidence blends directional strength and agreement
  const directionalStrength = Math.min(1.0, Math.abs(avgScore));
  const agreementRatio = agreementSum / signals.length;
  const fusedConfidence = Math.round((directionalStrength * 0.5 + agreementRatio * 0.5) * 100) / 100;

  const debateTriggered = fusedConfidence < DEBATE_CONFIDENCE_THRESHOLD;

  // Persist fusion result
  const fusionId = randomUUID();
  await db.insert(signalFusionResult).values({
    id: fusionId,
    workflowRunId,
    ticker: signals[0].ticker,
    fusedSignal,
    fusedConfidence,
    weightsJson: weightsSnapshot,
    debateTriggered,
  });

  return {
    fusionId,
    ticker: signals[0].ticker,
    fusedSignal,
    fusedConfidence,
    debateTriggered,
    weights: weightsSnapshot,
    signalBreakdown: breakdown,
  };
}

/**
 * 查询工作流的最新信号融合结果
 */
export async function getLatestFusionForWorkflow(
  workflowRunId: string
): Promise<FusionOutput | null> {
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
    signalBreakdown: signals.map((s) => ({
      role: s.analystRole as AgentRole,
      signal: s.signal as AnalystSignalValue,
      confidence: s.confidence,
      weight: 1.0,
      reasoning: s.reasoning,
    })),
  };
}
