import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { chatMessageWorkflowLink, workflowRun } from "../../db/sqlite/schema";
import { config } from "../../config";
import type { AgentExecutionPath } from "../../types/execution-path";
import type { AgentLoopKind, LoopOptionsJson } from "../../types/loop";
import { normalizeLoopKind, parseLoopOptionsJson } from "../../types/loop";
import { clearWorkflowCheckpointForNewTurn } from "./checkpoint-turn";
import { dispatchTaskToRole } from "../agent-pool";
import { setWorkflowState } from "./workflow-state-machine";

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
  researchScenarioId?: string;
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
  /**
   * 复用候选 source 白名单：
   *
   * 历史 bug：原代码只按 `(projectId, sessionId)` 取 startedAt 最新的一条复用，
   * 但同一个 chat session 的 sessionId 上还会沾着其它来源的 workflow_run：
   *   - trader-workflow.ts#getOrCreateTraderWorkflow：`source='api'`，
   *     goal=`"QUBIT 实时交易 Agent 执行上下文"`，启动后 status 会被改成 running
   *   - scheduler.ts：定时器派工同样 `source='api'`、带 sessionId
   *
   * 这些只要 startedAt 比当前 chat workflow 新，下一次 chat onSend 就会把它当成
   * 自己的 workflow 复用 —— goal / mode / loop_options 全被改写，前端看到的就是
   * "对话窗口突然绑定到研究 Agent / Trader 流，每次回答都不在一个 workflow 里"
   * 的串台症状（详见 docs/AGENT_STABILITY_REVIEW.md）。
   *
   * 修复：复用候选必须 source 匹配。绝大多数 reuse 调用方都是 chat（onSend
   * 默认走这里），所以只允许复用同 source 的工作流；其他 source（API / manual
   * / scheduler / trader 等）保留各自的"按需新建/单独管理"语义，永远不会被
   * chat 抢走。
   */
  const reuseSource = input.source ?? "chat";
  if (shouldReuse && input.sessionId) {
    const latest = await db
      .select()
      .from(workflowRun)
      .where(
        and(
          eq(workflowRun.projectId, input.projectId),
          eq(workflowRun.sessionId, input.sessionId),
          eq(workflowRun.source, reuseSource)
        )
      )
      .orderBy(desc(workflowRun.startedAt))
      .limit(1);
    if (latest[0]) {
      id = latest[0].id;
      /**
       * P1-A：reuse 路径要"把已完结/取消的 chat workflow 重置回 pending"。直接 update
       * 多字段（goal/mode/loopKind/...）保留为直写；status 单独走 setWorkflowState
       * 让状态机记录 transition（避免 completed → pending / cancelled → pending 等
       * 看起来违规但实际是 reuse 的迁移被淹没）。
       */
      await db
        .update(workflowRun)
        .set({
          goal: input.goal,
          mode: input.mode,
          source: input.source ?? latest[0].source,
          startedAt: new Date().toISOString(),
          loopKind,
          executionPath,
          loopOptionsJson: loopOpts,
          researchScenarioId: input.researchScenarioId,
        })
        .where(eq(workflowRun.id, id));
      await setWorkflowState(id, "pending", { reason: "workflow-service:reuse" });
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
        researchScenarioId: input.researchScenarioId,
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
      researchScenarioId: input.researchScenarioId,
    });
  }

  let runId: string | undefined;
  if (!input.skipDispatch) {
    const taskType = input.taskType ?? "workflow_start";
    if (taskType === "workflow_start" && shouldReuse) {
      await clearWorkflowCheckpointForNewTurn(id);
    }
    const out = await dispatchTaskToRole({
      workflowId: id,
      role: "orchestrator",
      payload: {
        taskId: randomUUID(),
        taskType,
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
