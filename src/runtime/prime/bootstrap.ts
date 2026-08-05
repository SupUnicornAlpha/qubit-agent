/**
 * Push migrated AgentSpecs into Rust Core and optionally smoke a primary turn.
 */

import { getCoreRuntime, resolveCoreBackend, rustCoreBaseUrl } from "./core-runtime";
import { RustCoreClient } from "./rust-core-client";
import {
  buildPrimeAgentSpecsFromDb,
  primePrimarySpecId,
  summarizePrimeSeed,
} from "./seed-prime-agent-specs";
import type { AgentSpec } from "./types";

export async function syncPrimeSpecsToRustCore(
  specs?: AgentSpec[]
): Promise<{ upserted: number; summary: ReturnType<typeof summarizePrimeSeed> }> {
  const resolved = specs ?? (await buildPrimeAgentSpecsFromDb());
  const core = getCoreRuntime();
  for (const spec of resolved) {
    await core.upsertAgent(spec);
  }
  return { upserted: resolved.length, summary: summarizePrimeSeed(resolved) };
}

/**
 * Best-effort sync when Core backend is rust. No-op / warn on ts or failure.
 */
export async function syncPrimeSpecsFromDbIfRust(): Promise<{
  synced: boolean;
  upserted: number;
  reason: string;
}> {
  if (resolveCoreBackend() !== "rust") {
    return { synced: false, upserted: 0, reason: "backend!=rust" };
  }
  try {
    const result = await syncPrimeSpecsToRustCore();
    return { synced: true, upserted: result.upserted, reason: "ok" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[prime] sync AgentSpecs to Core failed: ${msg}`);
    return { synced: false, upserted: 0, reason: msg };
  }
}

export async function smokePrimaryTurn(opts?: {
  text?: string;
  timeoutMs?: number;
}): Promise<{
  session_id: string;
  turn_id: string;
  delivery_status?: string;
  lifecycle?: string;
}> {
  if (resolveCoreBackend() !== "rust") {
    throw new Error("smokePrimaryTurn requires QUBIT_CORE_BACKEND=rust");
  }
  const client =
    getCoreRuntime() instanceof RustCoreClient
      ? (getCoreRuntime() as RustCoreClient)
      : new RustCoreClient(rustCoreBaseUrl());

  const specs = await buildPrimeAgentSpecsFromDb();
  const primaryId = primePrimarySpecId(specs);
  await syncPrimeSpecsToRustCore(specs);

  const session = await client.createSession({
    workspace_id: "ws_prime_smoke",
    agent_ref: primaryId,
    interaction_mode: "agent",
  });
  const started = await client.startTurn({
    session_id: session.session_id,
    input: { text: opts?.text ?? "prime smoke: hello", attachments: [] },
    idempotency_key: `smoke-${Date.now()}`,
  });
  const snap = await client.awaitTurnTerminal(
    session.session_id,
    started.turn_id,
    opts?.timeoutMs ?? 8000
  );
  return {
    session_id: session.session_id,
    turn_id: started.turn_id,
    ...(snap.active_turn?.delivery?.status
      ? { delivery_status: snap.active_turn.delivery.status }
      : {}),
    ...(snap.active_turn?.lifecycle
      ? { lifecycle: snap.active_turn.lifecycle }
      : {}),
  };
}
