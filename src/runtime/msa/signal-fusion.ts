/**
 * Auditable multi-signal fusion for research workflows.
 *
 * This is deliberately a small persistence service, not an autonomous
 * recommendation engine: callers supply independently produced analyst
 * signals, this module records their provenance and applies one deterministic
 * weighted aggregation. A fused signal is research evidence only; it cannot
 * create an order or bypass thesis/backtest/execution gates.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { getDb } from "../../db/sqlite/client";
import { analystAccuracyLog, analystSignal, signalFusionResult } from "../../db/sqlite/schema";
import type { AnalystSignalValue } from "../../types/entities";

const DEBATE_CONFIDENCE_THRESHOLD = 0.55;
const SIGNAL_SCORE: Record<AnalystSignalValue, number> = { buy: 1, hold: 0, sell: -1 };

export interface RawAnalystSignal {
  /** Optional immutable agent definition identity used for historic calibration. */
  definitionId?: string;
  analystRole: string;
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
    role: string;
    signal: AnalystSignalValue;
    confidence: number;
    weight: number;
    reasoning: string;
  }>;
}

async function loadDynamicWeights(
  db: DbClient,
  definitionIds: string[]
): Promise<Record<string, number>> {
  const weights: Record<string, number> = {};
  for (const definitionId of definitionIds) {
    if (!definitionId) continue;
    const row = (
      await db
        .select({
          total: sql<number>`COUNT(*)`,
          correct: sql<number>`SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END)`,
        })
        .from(analystAccuracyLog)
        .where(and(eq(analystAccuracyLog.definitionId, definitionId), sql`is_correct IS NOT NULL`))
        .limit(1)
    )[0];
    const total = Number(row?.total ?? 0);
    const correct = Number(row?.correct ?? 0);
    // Insufficient history must not manufacture a performance advantage.
    weights[definitionId] =
      total < 5 ? 1 : Math.max(0.3, Math.min(2, 1 + (correct / total - 0.5) * 2.5));
  }
  return weights;
}

function normalizeSignal(signal: RawAnalystSignal): RawAnalystSignal {
  const ticker = signal.ticker.trim().toUpperCase();
  if (!ticker) throw new Error("research.signal_fuse: signal ticker is required");
  if (!signal.analystRole.trim()) throw new Error("research.signal_fuse: analystRole is required");
  if (signal.signal !== "buy" && signal.signal !== "sell" && signal.signal !== "hold") {
    throw new Error("research.signal_fuse: signal must be buy, sell, or hold");
  }
  if (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1) {
    throw new Error("research.signal_fuse: confidence must be between 0 and 1");
  }
  if (!signal.reasoning.trim()) throw new Error("research.signal_fuse: reasoning is required");
  return {
    ...signal,
    ticker,
    analystRole: signal.analystRole.trim(),
    reasoning: signal.reasoning.trim(),
  };
}

/** Persist signal inputs and a deterministic fusion result for one symbol. */
export async function fuseResearchSignals(
  input: {
    workflowRunId: string;
    signals: RawAnalystSignal[];
    /** Immutable market snapshot that all input analysis claims reference. */
    snapshotId: string;
    persistSignals?: Array<{ agentInstanceId?: string | null; signal: RawAnalystSignal }>;
  },
  db?: DbClient
): Promise<FusionOutput> {
  const client = db ?? (await getDb());
  const snapshotId = input.snapshotId.trim();
  if (!input.workflowRunId.trim())
    throw new Error("research.signal_fuse: workflowRunId is required");
  if (!snapshotId) throw new Error("research.signal_fuse: snapshotId is required");
  if (!input.signals.length) throw new Error("research.signal_fuse: signals cannot be empty");

  const signals = input.signals.map(normalizeSignal);
  const ticker = signals[0]?.ticker;
  if (!ticker || signals.some((signal) => signal.ticker !== ticker)) {
    throw new Error("research.signal_fuse: one fusion may only contain one normalized ticker");
  }
  if (
    signals.some((signal) => {
      const embeddedSnapshotId = signal.dataSnapshot?.snapshotId;
      return typeof embeddedSnapshotId === "string" && embeddedSnapshotId.trim() !== snapshotId;
    })
  ) {
    throw new Error("research.signal_fuse: signal snapshotId must match snapshotId");
  }

  const definitionIds = [
    ...new Set(signals.flatMap((signal) => (signal.definitionId ? [signal.definitionId] : []))),
  ];
  const dynamicWeights = await loadDynamicWeights(client, definitionIds);

  if (input.persistSignals?.length) {
    if (input.persistSignals.length !== signals.length) {
      throw new Error("research.signal_fuse: persistSignals must match signals length");
    }
    for (let index = 0; index < signals.length; index += 1) {
      const signal = signals[index];
      const persisted = input.persistSignals[index];
      if (!signal || !persisted) continue;
      await client.insert(analystSignal).values({
        id: randomUUID(),
        workflowRunId: input.workflowRunId,
        agentInstanceId: persisted.agentInstanceId ?? null,
        analystRole: signal.analystRole,
        ticker: signal.ticker,
        signal: signal.signal,
        confidence: signal.confidence,
        reasoning: signal.reasoning,
        dataSnapshotJson: {
          ...(signal.dataSnapshot ?? {}),
          snapshotId,
          ...(signal.definitionId ? { definitionId: signal.definitionId } : {}),
        },
      });
    }
  }

  let weightedSum = 0;
  let totalWeight = 0;
  const weights: Record<string, number> = {};
  const signalBreakdown: FusionOutput["signalBreakdown"] = [];
  for (const signal of signals) {
    const weight = signal.definitionId ? (dynamicWeights[signal.definitionId] ?? 1) : 1;
    const effectiveWeight = weight * signal.confidence;
    weightedSum += SIGNAL_SCORE[signal.signal] * effectiveWeight;
    totalWeight += effectiveWeight;
    // Multiple analysts of the same role retain their individual evidence in
    // analyst_signal; this summary uses a stable role key for UI readability.
    weights[signal.analystRole] = weight;
    signalBreakdown.push({
      role: signal.analystRole,
      signal: signal.signal,
      confidence: signal.confidence,
      weight,
      reasoning: signal.reasoning,
    });
  }

  const averageScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const fusedSignal: AnalystSignalValue =
    averageScore > 0.2 ? "buy" : averageScore < -0.2 ? "sell" : "hold";
  const agreement =
    signals.reduce(
      (sum, signal) => sum + (signal.signal === fusedSignal ? signal.confidence : 0),
      0
    ) / signals.length;
  const fusedConfidence =
    Math.round((Math.min(1, Math.abs(averageScore)) * 0.5 + agreement * 0.5) * 100) / 100;
  const debateTriggered = fusedConfidence < DEBATE_CONFIDENCE_THRESHOLD;
  const fusionId = randomUUID();
  await client.insert(signalFusionResult).values({
    id: fusionId,
    workflowRunId: input.workflowRunId,
    ticker,
    fusedSignal,
    fusedConfidence,
    weightsJson: { snapshotId, weights, sourceCount: signals.length },
    debateTriggered,
  });

  return {
    fusionId,
    ticker,
    fusedSignal,
    fusedConfidence,
    debateTriggered,
    weights,
    signalBreakdown,
  };
}
