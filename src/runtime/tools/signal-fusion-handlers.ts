import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentInstance } from "../../db/sqlite/schema";
import { getMarketSnapshotById } from "../market/contracts/market-snapshot-service";
import { type RawAnalystSignal, fuseResearchSignals } from "../msa/signal-fusion";
import type { BuiltinToolHandler } from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const SIGNAL_FUSION_HANDLERS: Record<string, BuiltinToolHandler> = {
  "research.signal_fuse": async (ctx, params) => {
    const snapshotId = String(params.snapshot_id ?? params.snapshotId ?? "").trim();
    const rawSignals = Array.isArray(params.signals) ? params.signals : [];
    if (!snapshotId) throw new Error("research.signal_fuse: snapshot_id is required");
    if (!rawSignals.length) throw new Error("research.signal_fuse: signals[] is required");
    const snapshot = await getMarketSnapshotById(snapshotId);
    if (!snapshot) {
      throw new Error(`research.signal_fuse: snapshot_not_found:${snapshotId}`);
    }
    const db = await getDb();
    const signals: RawAnalystSignal[] = [];
    const persistSignals: Array<{ agentInstanceId?: string | null; signal: RawAnalystSignal }> = [];

    for (const raw of rawSignals) {
      const item = asRecord(raw);
      const sourceAgentInstanceId = String(
        item.agent_instance_id ?? item.agentInstanceId ?? ""
      ).trim();
      // A model must not be able to impersonate a historically calibrated
      // analyst by merely providing a definition id. Attribution is derived
      // only from an actual source instance in this workflow.
      let definitionId = "";
      if (sourceAgentInstanceId) {
        const source = (
          await db
            .select({ definitionId: agentInstance.definitionId })
            .from(agentInstance)
            .where(
              and(
                eq(agentInstance.id, sourceAgentInstanceId),
                eq(agentInstance.workflowRunId, ctx.workflowId)
              )
            )
            .limit(1)
        )[0];
        if (!source) {
          throw new Error("research.signal_fuse: source agent must belong to this workflow");
        }
        definitionId = source.definitionId;
      }
      const signal: RawAnalystSignal = {
        ...(definitionId ? { definitionId } : {}),
        analystRole: String(item.analyst_role ?? item.analystRole ?? ""),
        ticker: String(item.ticker ?? item.symbol ?? ""),
        signal: String(item.signal ?? "") as RawAnalystSignal["signal"],
        confidence: Number(item.confidence),
        reasoning: String(item.reasoning ?? ""),
        dataSnapshot: asRecord(item.data_snapshot ?? item.dataSnapshot),
      };
      signals.push(signal);
      persistSignals.push({
        agentInstanceId: sourceAgentInstanceId || null,
        signal,
      });
    }

    const ticker = signals[0]?.ticker.trim().toUpperCase();
    if (
      !ticker ||
      !snapshot.snapshot.universe.some(
        (instrumentKey) => instrumentKey === ticker || instrumentKey.endsWith(`:${ticker}`)
      )
    ) {
      throw new Error("research.signal_fuse: ticker_not_in_snapshot_universe");
    }

    return fuseResearchSignals(
      { workflowRunId: ctx.workflowId, snapshotId, signals, persistSignals },
      db
    );
  },
};
