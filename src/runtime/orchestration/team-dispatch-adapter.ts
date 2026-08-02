/** Durable topology/A2A dispatch adapter used by orchestration tools. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import type { A2ATaskState, TaskAssignPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import { resolveAgentControlMode } from "../../types/loop";
import { getA2aPorts } from "../a2a/ports";
import { dispatchTaskToRole } from "../agent-pool";
import type { BuiltinToolContext } from "../tools/types";
import {
  assertTopologyTargetAllowed,
  loadOrchestratorTopologyForWorkflow,
  resolveDispatchRole,
  resolveTopologyTaskLeaseMs,
  resolveTopologyTaskTimeoutMs,
} from "./topology-dispatch";

/** Goal 模式允许 Orchestrator 按目标按需召唤当前拓扑之外的专家。 */
async function isGoalMode(workflowId: string): Promise<boolean> {
  try {
    const db = await getDb();
    const rows = await db
      .select({ loopOptionsJson: workflowRun.loopOptionsJson })
      .from(workflowRun)
      .where(eq(workflowRun.id, workflowId))
      .limit(1);
    return resolveAgentControlMode(rows[0]?.loopOptionsJson) === "goal";
  } catch {
    return false; // 读失败按默认 native 处理（保守，rails 不变）
  }
}

export function resolveDelegatedParentTaskId(
  inboundPayload: Record<string, unknown> | undefined
): string | null {
  const taskId = inboundPayload?.taskId;
  return typeof taskId === "string" && taskId.trim() ? taskId.trim() : null;
}

export async function dispatchTeamAgentTask(
  ctx: BuiltinToolContext,
  role: AgentRole,
  params: Record<string, unknown>
): Promise<{
  dispatched: boolean;
  completed: boolean;
  success: boolean;
  taskId: string;
  role: AgentRole;
  runId: string;
  via: string;
  dispatchStatus: "completed" | "timeout";
  dataAvailability: "available" | "unknown" | "not_applicable";
  result?: unknown;
  errorCode?: string | null;
  taskStatus?: A2ATaskState | "timeout" | "awaiting_approval";
  errorMessage?: string | null;
}> {
  const targetRole = resolveDispatchRole(role);
  const topology = await loadOrchestratorTopologyForWorkflow();
  if (ctx.definition.role === "orchestrator" && topology && topology.targets.length > 0) {
    // Goal 模式放开「角色集锁死」——编排器可按需拉入团队拓扑之外的有效专家。
    // 默认 Agent 模式保持
    // 严格校验（rails 不变）。dispatchTaskToRole 仍会对不存在定义的角色报运行时错误兜底。
    const goalMode = await isGoalMode(ctx.workflowId);
    if (goalMode) {
      const onEdge = topology.targets.some((t) => t.role === targetRole);
      if (!onEdge) {
        console.info(
          `[dispatchTeamAgentTask] Goal 模式：放行拓扑外角色 '${targetRole}'（按需拉入专家）`
        );
      }
    } else {
      assertTopologyTargetAllowed(topology, targetRole);
    }
  }

  const goal = String(params.goal ?? params.message ?? "").trim();
  if (!goal) throw new Error("dispatch team agent: goal is required");

  const extra =
    typeof params.params === "object" && params.params && !Array.isArray(params.params)
      ? (params.params as Record<string, unknown>)
      : {};
  // Preserve the durable A2A parent/child relation. Without this, topology
  // specialists look like independent root envelopes in `a2a_task`, so
  // completion cannot distinguish a running parent from delegated work and a
  // terminal parent cannot cancel only its own children.
  const inboundTaskId = resolveDelegatedParentTaskId(ctx.inboundPayload);

  const gatherTimeoutMs = resolveTopologyTaskTimeoutMs(targetRole);
  const leaseMs = resolveTopologyTaskLeaseMs();
  const payload: TaskAssignPayload = {
    taskId: String(params.taskId ?? randomUUID()),
    taskType: String(params.taskType ?? "topology_dispatch"),
    assignedRole: targetRole,
    goal,
    ...(Array.isArray(params.acceptanceCriteria)
      ? {
          acceptanceCriteria: params.acceptanceCriteria.filter(
            (value): value is string => typeof value === "string"
          ),
        }
      : {}),
    acceptance:
      targetRole === "market_data"
        ? { requiredEvidence: "market_data" }
        : { requiredEvidence: "analysis" },
    params: {
      goal,
      ...extra,
      ...(inboundTaskId ? { parentTaskId: inboundTaskId } : {}),
      ...(role !== targetRole ? { requestedRole: role } : {}),
    },
    // 子任务墙钟与 gather 对齐；通信失联由 lease+TASK_PROGRESS 处理，不靠提前掐死孩子。
    deadline: new Date(Date.now() + Math.max(gatherTimeoutMs - 5_000, 5_000)).toISOString(),
  };

  const dispatch = await dispatchTaskToRole({
    workflowId: ctx.workflowId,
    role: targetRole,
    payload,
    traceId: ctx.traceId,
    senderId: ctx.agentInstanceId,
  });
  // A2A Task is durable before dispatch.  Do not use an in-memory gather as
  // the source of truth: a parent can now reconstruct this wait after restart.
  const a2aPorts = getA2aPorts();
  const waited = await a2aPorts.waitForTerminal(payload.taskId, {
    timeoutMs: gatherTimeoutMs,
    leaseMs,
  });
  const task = waited.task;
  const timedOut = waited.timedOut;
  if (timedOut) {
    await a2aPorts.requestCancellation(payload.taskId, {
      reason: "team_dispatch_timeout",
      detail:
        waited.timeoutReason === "lease_expired"
          ? `${targetRole} 专家通信 lease 失联`
          : `${targetRole} 专家在墙钟 ${gatherTimeoutMs}ms 内未回包`,
    });
  }
  const result = task?.result;
  const taskError =
    task?.error && typeof task.error === "object" ? (task.error as Record<string, unknown>) : null;
  const taskStatus = task?.status === "input_required" ? "awaiting_approval" : task?.status;
  const gatheredRecord =
    result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  const taskEvidence =
    gatheredRecord?.taskEvidence && typeof gatheredRecord.taskEvidence === "object"
      ? (gatheredRecord.taskEvidence as Record<string, unknown>)
      : null;
  const dataAvailable =
    targetRole === "market_data" &&
    taskEvidence?.verified === true &&
    taskEvidence.kind === "market_data";
  const errorMessage = timedOut
    ? waited.timeoutReason === "lease_expired"
      ? `team_dispatch_timeout: ${targetRole} 专家通信 lease 失联（连续无 TASK_PROGRESS）；这不代表底层数据源不可用，禁止据此宣告 no_data。`
      : `team_dispatch_timeout: ${targetRole} 专家在墙钟 ${gatherTimeoutMs}ms 内未回包；这不代表底层数据源不可用，禁止据此宣告 no_data。`
    : typeof taskError?.message === "string"
      ? taskError.message
      : null;
  const output: {
    dispatched: boolean;
    completed: boolean;
    success: boolean;
    taskId: string;
    role: AgentRole;
    runId: string;
    via: string;
    dispatchStatus: "completed" | "timeout";
    dataAvailability: "available" | "unknown" | "not_applicable";
    result?: unknown;
    errorCode?: string | null;
    taskStatus?: A2ATaskState | "timeout" | "awaiting_approval";
    errorMessage?: string | null;
  } = {
    dispatched: true,
    completed: Boolean(task && !timedOut),
    success: task?.status === "completed",
    taskId: payload.taskId,
    role: targetRole,
    runId: dispatch.runId,
    via: "topology_dispatch",
    dispatchStatus: timedOut ? "timeout" : "completed",
    dataAvailability: timedOut ? "unknown" : dataAvailable ? "available" : "not_applicable",
  };
  if (result !== undefined) output.result = result;
  if (timedOut) {
    output.errorCode = "a2a_gather_timeout";
    output.taskStatus = "timeout";
  } else if (typeof taskError?.code === "string") {
    output.errorCode = taskError.code;
    if (taskStatus) output.taskStatus = taskStatus;
  } else if (task && taskStatus) {
    output.taskStatus = taskStatus;
  }
  if (errorMessage) output.errorMessage = errorMessage;
  return output;
}
