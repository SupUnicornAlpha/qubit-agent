/**
 * Ensure Bun workflow has a bound Rust Core session (loop_options_json.primeCore).
 */

import { loadWorkflowLoopContext } from "../workflow/hitl-service";
import { syncPrimeSpecsToRustCore } from "./bootstrap";
import { getCoreRuntime, rustCoreBaseUrl } from "./core-runtime";
import { RustCoreClient } from "./rust-core-client";
import { primePrimarySpecId } from "./seed-prime-agent-specs";
import type { InteractionMode } from "./types";
import { readPrimeCoreBinding, writePrimeCoreBinding } from "./workflow-session-binding";

export function asRustCoreClient(): RustCoreClient {
  const core = getCoreRuntime();
  if (core instanceof RustCoreClient) return core;
  return new RustCoreClient(rustCoreBaseUrl());
}

export async function ensureCoreSession(input: {
  workflowId: string;
  interactionMode?: InteractionMode;
}): Promise<{ sessionId: string; agentSpecId: string; agentInstanceId?: string }> {
  const { workflow, loopOptions } = await loadWorkflowLoopContext(input.workflowId);
  const existing = readPrimeCoreBinding(
    (workflow.loopOptionsJson as Record<string, unknown> | null) ??
      (loopOptions as unknown as Record<string, unknown>)
  );
  const client = asRustCoreClient();
  const agentSpecId = existing?.agentSpecId ?? primePrimarySpecId();
  const interactionMode = input.interactionMode ?? "agent";

  if (existing?.sessionId) {
    try {
      const session = await client.getSession(existing.sessionId);
      if (session.interaction_mode !== interactionMode) {
        const updated = await client.setSessionMode({
          session_id: existing.sessionId,
          interaction_mode: interactionMode,
        });
        return {
          sessionId: existing.sessionId,
          agentSpecId,
          agentInstanceId: updated.agent_instance_id,
        };
      }
      return {
        sessionId: existing.sessionId,
        agentSpecId,
        agentInstanceId: session.agent_instance_id,
      };
    } catch {
      /* recreate */
    }
  }

  await syncPrimeSpecsToRustCore();
  const session = await client.createSession({
    workspace_id: `wf_${input.workflowId}`,
    agent_ref: agentSpecId,
    interaction_mode: interactionMode,
  });
  await writePrimeCoreBinding(input.workflowId, {
    sessionId: session.session_id,
    agentSpecId,
    agentInstanceId: session.agent_instance_id,
  });
  return {
    sessionId: session.session_id,
    agentSpecId,
    agentInstanceId: session.agent_instance_id,
  };
}
