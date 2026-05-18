import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { chatMessageWorkflowLink, workflowRun } from "../../db/sqlite/schema";
import { config } from "../../config";
import type { AgentExecutionPath } from "../../types/execution-path";
import type { AgentLoopKind, LoopOptionsJson } from "../../types/loop";
import { normalizeLoopKind, parseLoopOptionsJson } from "../../types/loop";
import { dispatchTaskToRole } from "../agent-pool";

export interface CreateAndDispatchWorkflowInput {
  projectId: string;
  goal: string;
  mode: "research" | "backtest" | "simulation" | "live";
  sessionId?: string;
  source?: "chat" | "manual" | "api";
  messageId?: string;
  reuseSessionWorkflow?: boolean;
  /** 仅插入 workflow_run，不向 orchestrator 派发（研究团队占位工作流等） */
  skipDispatch?: boolean;
  taskType?: string;
  params?: Record<string, unknown>;
  loopKind?: AgentLoopKind;
  loopOptionsJson?: LoopOptionsJson;
  /** native 循环：graph（LangGraph）或 a2a（总线）；默认见 QUBIT_AGENT_EXECUTION_PATH */
  executionPath?: AgentExecutionPath;
}

export async function createAndDispatchWorkflow(
  input: CreateAndDispatchWorkflowInput
): Promise<{ data: typeof workflowRun.$inferSelect; runId?: string }> {
  const db = await getDb();
  let id = randomUUID();

  const loopKind = normalizeLoopKind(input.loopKind);
  const loopOpts = (input.loopOptionsJson ?? {}) as Record<string, unknown>;
  const parsedOpts = parseLoopOptionsJson(loopOpts);
  const executionPath =
    input.executionPath ?? parsedOpts.executionPath ?? config.agentExecutionPath;

  const shouldReuse =
    Boolean(input.sessionId) &&
    (input.reuseSessionWorkflow === true ||
      (input.reuseSessionWorkflow !== false && input.source === "chat"));
  if (shouldReuse && input.sessionId) {
    const latest = await db
      .select()
      .from(workflowRun)
      .where(
        and(eq(workflowRun.projectId, input.projectId), eq(workflowRun.sessionId, input.sessionId))
      )
      .orderBy(desc(workflowRun.startedAt))
      .limit(1);
    if (latest[0]) {
      id = latest[0].id;
      await db
        .update(workflowRun)
        .set({
          goal: input.goal,
          status: "pending",
          mode: input.mode,
          source: input.source ?? latest[0].source,
          startedAt: new Date().toISOString(),
          endedAt: null,
          loopKind,
          executionPath,
          loopOptionsJson: loopOpts,
        })
        .where(eq(workflowRun.id, id));
    } else {
      await db.insert(workflowRun).values({
        id,
        projectId: input.projectId,
        sessionId: input.sessionId,
        goal: input.goal,
        mode: input.mode,
        source: input.source ?? "manual",
        status: "pending",
        loopKind,
        executionPath,
        loopOptionsJson: loopOpts,
      });
    }
  } else {
    await db.insert(workflowRun).values({
      id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      goal: input.goal,
      mode: input.mode,
      source: input.source ?? "manual",
      status: "pending",
      loopKind,
      executionPath,
      loopOptionsJson: loopOpts,
    });
  }

  let runId: string | undefined;
  if (!input.skipDispatch) {
    const out = await dispatchTaskToRole({
      workflowId: id,
      role: "orchestrator",
      payload: {
        taskId: randomUUID(),
        taskType: input.taskType ?? "workflow_start",
        params: {
          workflowRunId: id,
          goal: input.goal,
          mode: input.mode,
          ...(input.params ?? {}),
        },
        assignedRole: "orchestrator",
      },
    });
    runId = out.runId;
  }

  if (input.messageId) {
    await db.insert(chatMessageWorkflowLink).values({
      id: randomUUID(),
      chatMessageId: input.messageId,
      workflowRunId: id,
      traceId: randomUUID(),
    });
  }

  const created = await db.select().from(workflowRun).where(eq(workflowRun.id, id)).limit(1);
  return { data: created[0], runId };
}
