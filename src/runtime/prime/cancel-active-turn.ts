/**
 * Best-effort cancel of the active Prime Core turn for a Bun workflow.
 * Used by collaborative interrupt / Stop so UI idle matches Core reality.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { asRustCoreClient } from "./ensure-core-session";
import { readPrimeCoreBinding } from "./workflow-session-binding";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "canceled", "error"]);

export async function cancelActiveCoreTurnForWorkflow(
  workflowRunId: string
): Promise<{ cancelled: boolean; turnId?: string; reason?: string }> {
  try {
    const db = await getDb();
    const rows = await db
      .select({ loopOptionsJson: workflowRun.loopOptionsJson })
      .from(workflowRun)
      .where(eq(workflowRun.id, workflowRunId))
      .limit(1);
    const binding = readPrimeCoreBinding(
      (rows[0]?.loopOptionsJson as Record<string, unknown> | null) ?? null
    );
    if (!binding?.sessionId) {
      return { cancelled: false, reason: "no_prime_binding" };
    }

    const client = asRustCoreClient();
    const snap = await client.sessionSnapshot(binding.sessionId);
    const turn = snap.active_turn;
    if (!turn?.turn_id) {
      return { cancelled: false, reason: "no_active_turn" };
    }
    const state = String(turn.state ?? turn.lifecycle ?? "").toLowerCase();
    if (TERMINAL_STATES.has(state)) {
      return { cancelled: false, turnId: turn.turn_id, reason: "already_terminal" };
    }

    await client.cancelTurn({
      session_id: binding.sessionId,
      turn_id: turn.turn_id,
    });
    return { cancelled: true, turnId: turn.turn_id };
  } catch (err) {
    return {
      cancelled: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
