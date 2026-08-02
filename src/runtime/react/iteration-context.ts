/**
 * Iteration context factory.
 *
 * The ReAct runner owns I/O; nodes receive this immutable value through state.
 * Keeping workflow metadata, the advertised surface and facts together avoids
 * the historic pattern where reason, act and terminal gates each re-read SQLite
 * and reach different conclusions in one iteration.
 */
import { eq } from "drizzle-orm";
import type { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { resolveAgentControlMode, resolveWorkflowProcessConfig } from "../../types/loop";
import { resolveEffectiveAgentTools } from "../orchestration/resolve-effective-tools";
import { ensureFactsPort } from "../policy";
import type { RuntimeAgentDefinition } from "../types";
import { resolveEffectiveWorkflowProcessConfig } from "../workflow/process-config";
import type { AgentGraphState, IterationContext } from "./state";

type Db = Awaited<ReturnType<typeof getDb>>;

export async function loadIterationContext(input: {
  db: Db;
  workflowId: string;
  definition: RuntimeAgentDefinition;
  state: Pick<AgentGraphState, "toolCalls">;
}): Promise<IterationContext> {
  const rows = await input.db
    .select({
      projectId: workflowRun.projectId,
      loopOptionsJson: workflowRun.loopOptionsJson,
      planJson: workflowRun.planJson,
    })
    .from(workflowRun)
    .where(eq(workflowRun.id, input.workflowId))
    .limit(1);
  const workflow = rows[0];
  const agentMode = resolveAgentControlMode(workflow?.loopOptionsJson);
  const processConfig = resolveEffectiveWorkflowProcessConfig(
    resolveWorkflowProcessConfig(workflow?.loopOptionsJson),
    agentMode
  );
  const effective = await resolveEffectiveAgentTools(input.definition, input.workflowId);

  let snapshot: IterationContext["snapshot"] = null;
  try {
    const facts = await ensureFactsPort();
    snapshot = facts.loadSnapshot(input.workflowId, {
      availableTools: effective.tools,
      extraAttemptedTools: input.state.toolCalls.map((call) => String(call.toolName ?? "")),
      includeA2a: true,
    });
  } catch {
    // Facts are quality/recovery input. A transient read failure must not make
    // an otherwise executable tool call unavailable.
  }

  return {
    workflowId: input.workflowId,
    projectId: workflow?.projectId ?? null,
    agentMode,
    processConfig,
    planJson: workflow?.planJson ?? null,
    availableTools: effective.tools,
    effectiveTools: effective,
    snapshot,
    loadedAtMs: Date.now(),
  };
}
