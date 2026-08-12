/**
 * Project Core mid-turn activity into Bun UI surfaces:
 * - workflow.plan_json + stepStream type=plan  (Plan / Goal 卡片)
 * - stepStream tool_call_start/end             (ChatExecutionActivity)
 * - research_team_interaction tool_call        (Team 拓扑 / LiveConversation)
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { type AgentPlanSnapshot, parseAgentPlanSnapshot } from "../agent-control-mode";
import { stepStreamBus } from "../react/event-stream";
import { logResearchTeamInteraction } from "../research-team/interaction-log";
import { compactHeavyJson } from "../util/compact-heavy-json";
import { writeWorkflowPlanArtifacts } from "../workflow/plan-artifact";
import { recordCoreMonitorToolCall } from "./project-core-monitor";

export type CoreActivityContext = {
  workflowId: string;
  runId: string;
  traceId: string;
  role?: string;
};

export type CoreSkillActivity = {
  id?: unknown;
  name: string;
  version?: unknown;
  score?: unknown;
};

/** Pure projection used by the topology writer and benchmark tests. */
export function extractCoreSkillActivities(observation: unknown): CoreSkillActivity[] {
  const skills =
    observation &&
    typeof observation === "object" &&
    Array.isArray((observation as { skills?: unknown[] }).skills)
      ? (observation as { skills: unknown[] }).skills
      : [];
  const activities: CoreSkillActivity[] = [];
  for (const raw of skills.slice(0, 5)) {
    if (!raw || typeof raw !== "object") continue;
    const skill = raw as { id?: unknown; name?: unknown; version?: unknown; score?: unknown };
    const name = String(skill.name ?? "").trim();
    if (!name) continue;
    activities.push({
      name,
      ...(skill.id !== undefined ? { id: skill.id } : {}),
      ...(skill.version !== undefined ? { version: skill.version } : {}),
      ...(skill.score !== undefined ? { score: skill.score } : {}),
    });
  }
  return activities;
}

/** Normalize Core plan wire (snake_case) → Bun AgentPlanSnapshot (camelCase). */
export function corePlanToBunSnapshot(raw: unknown): AgentPlanSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  return parseAgentPlanSnapshot(raw);
}

/**
 * A successful turn is the authoritative completion signal for its plan.
 *
 * Models normally advance this themselves through `update_plan`, but a timeout
 * followed by resume can leave an otherwise-complete plan with its last step
 * still pending/in_progress. Do this only for a terminal successful turn; a
 * partial, failed, paused, or blocked turn must retain its resumable progress.
 */
export function finalizeCompletedCorePlan(
  plan: AgentPlanSnapshot,
  updatedAt = new Date().toISOString()
): AgentPlanSnapshot {
  const steps = plan.steps.map((step) =>
    step.status === "pending" || step.status === "in_progress"
      ? { ...step, status: "done" as const }
      : step
  );
  const totalSteps = steps.length;
  const completedSteps = steps.filter((step) => step.status === "done").length;

  return {
    ...plan,
    steps,
    updatedAt,
    ...(plan.goal
      ? {
          goal: {
            ...plan.goal,
            status: "completed" as const,
            completedSteps,
            totalSteps,
          },
        }
      : {}),
  };
}

export async function syncCorePlanToWorkflow(
  ctx: CoreActivityContext,
  planRaw: unknown,
  opts?: { announceToolCall?: boolean }
): Promise<AgentPlanSnapshot | null> {
  const plan = corePlanToBunSnapshot(planRaw);
  if (!plan || plan.steps.length === 0) return null;

  const db = await getDb();
  const rows = await db
    .select({
      projectId: workflowRun.projectId,
      planJson: workflowRun.planJson,
    })
    .from(workflowRun)
    .where(eq(workflowRun.id, ctx.workflowId))
    .limit(1);
  if (!rows[0]) return null;

  const prevKey = JSON.stringify(rows[0].planJson ?? null);
  const nextKey = JSON.stringify(plan);
  if (prevKey === nextKey) return plan;

  await db
    .update(workflowRun)
    .set({ planJson: plan as never })
    .where(eq(workflowRun.id, ctx.workflowId));

  try {
    await writeWorkflowPlanArtifacts({
      projectId: rows[0].projectId,
      workflowRunId: ctx.workflowId,
      plan,
    });
  } catch (err) {
    console.warn("[prime] plan artifact mirror failed:", err instanceof Error ? err.message : err);
  }

  if (opts?.announceToolCall !== false) {
    const toolCallId = `core_plan_${Date.now()}`;
    publishCoreToolCallStart(ctx, {
      toolCallId,
      toolName: "update_plan",
      args: { stepCount: plan.steps.length, mode: plan.mode },
    });
    publishCoreToolCallEnd(ctx, {
      toolCallId,
      toolName: "update_plan",
      ok: true,
      observation: { summary: `plan updated (${plan.steps.length} steps)` },
    });
    await recordCoreMonitorToolCall({
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      toolCallId,
      toolName: "update_plan",
      ok: true,
      args: { stepCount: plan.steps.length, mode: plan.mode },
      observation: { summary: `plan updated (${plan.steps.length} steps)` },
    });
  }

  stepStreamBus.publish({
    runId: ctx.runId,
    workflowId: ctx.workflowId,
    traceId: ctx.traceId,
    role: ctx.role ?? "orchestrator",
    type: "plan",
    stepIndex: 0,
    ts: Date.now(),
    loopKind: "native",
    source: "a2a",
    payload: plan as unknown as Record<string, unknown>,
  });

  return plan;
}

/** Persist and broadcast the final plan state after a successfully completed Core turn. */
export async function finalizeCorePlanForCompletedWorkflow(
  ctx: CoreActivityContext
): Promise<AgentPlanSnapshot | null> {
  const db = await getDb();
  const rows = await db
    .select({ planJson: workflowRun.planJson })
    .from(workflowRun)
    .where(eq(workflowRun.id, ctx.workflowId))
    .limit(1);
  const current = corePlanToBunSnapshot(rows[0]?.planJson);
  if (!current || current.steps.length === 0) return current;

  return syncCorePlanToWorkflow(ctx, finalizeCompletedCorePlan(current), {
    announceToolCall: false,
  });
}

export function publishCoreToolCallStart(
  ctx: CoreActivityContext,
  input: { toolCallId: string; toolName: string; args?: Record<string, unknown> }
): void {
  stepStreamBus.publish({
    runId: ctx.runId,
    workflowId: ctx.workflowId,
    traceId: ctx.traceId,
    role: ctx.role ?? "orchestrator",
    type: "tool_call_start",
    stepIndex: 0,
    ts: Date.now(),
    loopKind: "native",
    source: "a2a",
    payload: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      targetName: input.toolName,
      backend: "rust",
      ...(input.args ? { args: input.args } : {}),
    },
  });
}

export function publishCoreToolCallEnd(
  ctx: CoreActivityContext,
  input: {
    toolCallId: string;
    toolName: string;
    ok: boolean;
    status?: string;
    observation?: unknown;
  }
): void {
  stepStreamBus.publish({
    runId: ctx.runId,
    workflowId: ctx.workflowId,
    traceId: ctx.traceId,
    role: ctx.role ?? "orchestrator",
    type: "tool_call_end",
    stepIndex: 0,
    ts: Date.now(),
    loopKind: "native",
    source: "a2a",
    payload: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      targetName: input.toolName,
      status: input.status ?? (input.ok ? "success" : "failed"),
      backend: "rust",
      ...(input.observation !== undefined ? { observation: input.observation } : {}),
    },
  });
}

/** Persist + stream a Core/bridge tool call for Team topology. */
export async function projectCoreBridgeToolCall(input: {
  ctx: CoreActivityContext;
  toolCallId: string;
  toolName: string;
  ok: boolean;
  args?: Record<string, unknown>;
  observation?: unknown;
  /** When set, also writes mcp_call_log (Core MCP via L2 bridge). */
  mcp?: {
    serverName: string;
    toolName: string;
    arguments?: unknown;
    transport?: string | null;
  };
}): Promise<void> {
  const { ctx } = input;
  publishCoreToolCallStart(ctx, {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ...(input.args ? { args: input.args } : {}),
  });
  publishCoreToolCallEnd(ctx, {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ok: input.ok,
    ...(input.observation !== undefined ? { observation: input.observation } : {}),
  });

  await recordCoreMonitorToolCall({
    workflowId: ctx.workflowId,
    runId: ctx.runId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ok: input.ok,
    ...(input.args ? { args: input.args } : {}),
    ...(input.observation !== undefined ? { observation: input.observation } : {}),
    ...(input.mcp ? { mcp: input.mcp } : {}),
  });

  const summary =
    input.observation &&
    typeof input.observation === "object" &&
    "summary" in (input.observation as object)
      ? String((input.observation as { summary?: unknown }).summary ?? "")
      : "";
  await logResearchTeamInteraction({
    workflowRunId: ctx.workflowId,
    fromRole: ctx.role ?? "orchestrator",
    toRole: "orchestrator",
    kind: "tool_call",
    toolKind: input.mcp ? "mcp" : "prime_bridge",
    toolName: input.toolName,
    contentText: `${input.ok ? "✓" : "✗"} ${input.toolName}${summary ? `\n${summary.slice(0, 1500)}` : ""}`,
    payloadJson: {
      backend: "rust",
      toolCallId: input.toolCallId,
      ok: input.ok,
      observation: compactHeavyJson(input.observation),
      ...(input.mcp ? { mcp: input.mcp } : {}),
    },
  });

  // Skill nodes are represented as role-local tool activity in the existing
  // topology graph. This keeps one graph model while making every injected
  // Skill visible and attributable to the Core caller.
  if (input.toolName === "skill.search" && input.ok && input.observation) {
    for (const skill of extractCoreSkillActivities(input.observation)) {
      await logResearchTeamInteraction({
        workflowRunId: ctx.workflowId,
        fromRole: ctx.role ?? "orchestrator",
        toRole: ctx.role ?? "orchestrator",
        kind: "tool_call",
        toolKind: "skill",
        toolName: skill.name,
        contentText: `✓ skill injected: ${skill.name}`,
        payloadJson: {
          backend: "rust",
          phase: "skill_context_injection",
          skillId: skill.id,
          version: skill.version,
          score: skill.score,
          parentToolCallId: input.toolCallId,
        },
      });
    }
  }
}
