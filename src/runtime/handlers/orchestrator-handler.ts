/**
 * Orchestrator role 的专用 handler。
 *
 * P1-C 拆分：原 `role-handlers.ts` 里的 `orchestratorHandler.onMessage` 把
 * `workflow_resume / workflow_retry` / `research_team_execute` / delegate /
 * default 四种 TASK_ASSIGN 用 if 分支堆在一个 30+ 行的箭头函数里，可读性差、
 * 难以单测。这里按 task type 拆成 4 个独立函数 + 一个分发表，行为完全等价。
 *
 * 设计：
 * - 每个分支函数自己负责发 TASK_RESULT（成功 / 失败）并管理 workflow status
 * - 分发表 ORCHESTRATOR_TASK_HANDLERS 把 taskType → handler 映射成数据
 * - main onMessage 只负责"非 TASK_ASSIGN noop / 分发"，保持极薄
 */

import type { TaskAssignPayload } from "../../types/a2a";
import type { A2AMessageEnvelope } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import { runA2aReactTaskAssign } from "../a2a/a2a-react-task";
import { buildTaskResult } from "../a2a/task-result";
import { getA2APool } from "../a2a/a2a-pool";
import { graphRunner } from "../langgraph/graph-factory";
import {
  failResearchTeamExecuteJob,
  parseResearchTeamExecutePayload,
  runTeamResearchAndPersist,
} from "../msa/research-team-execute";
import { parseHitlApproval } from "../workflow/hitl-service";
import type { RuntimeHandlerContext, RuntimeRoleHandler } from "../types";
import { onWorkflowTerminal } from "../monitor/observability-hook";
import { setWorkflowState } from "../workflow/workflow-state-machine";
import { resolveExecutionPathForWorkflow } from "../resolve-execution-path";

async function setWorkflowStatus(
  workflowId: string,
  status: "completed" | "failed" | "running" | "awaiting_approval",
): Promise<void> {
  await setWorkflowState(workflowId, status, { reason: "orchestrator-handler" });
  if (status === "completed" || status === "failed") {
    onWorkflowTerminal(workflowId, status);
  }
}

function receiverForRole(role: AgentRole, fallback: string): string {
  try {
    return getA2APool().getInstanceIdForRole(role);
  } catch {
    return fallback;
  }
}

type OrchestratorTaskHandler = (
  ctx: RuntimeHandlerContext,
  msg: A2AMessageEnvelope,
  payload: TaskAssignPayload,
) => Promise<void>;

/**
 * workflow_resume / workflow_retry：按 executionPath 选择续跑路径。
 *
 * P2-A Batch 2：之前这里硬编码 `graphRunner.resumeRoleTask`，导致 a2a workflow
 * 续跑时被静默切换到 graph 路径（违背 A2A 自洽）。改造后：
 *   - executionPath === "graph" → graphRunner.resumeRoleTask（LangGraph
 *     checkpointer 续跑，行为不变）。
 *   - executionPath === "a2a" → 重跑 orchestrator 的 ReAct loop
 *     (runA2aReactTaskAssign)。hitlApproval / hitlPayload 通过 payload.params
 *     自然进入 LLM 上下文，由 orchestrator 自己决定下一步。
 *
 * 设计取舍：A2A 不像 LangGraph 那样有 step-level checkpoint，但 A2A 的 source
 * of truth 是消息流（a2a_message 表），加上 analystResearchJob 存的 resumePayload，
 * orchestrator 完全可以重建上下文。这样我们用"重跑 ReAct"换"独立 checkpointer"，
 * 大幅降低实现复杂度且不破坏 A2A 模型。
 *
 * 成功发 TASK_RESULT；失败标 failed 后发 fail TASK_RESULT。
 */
const handleWorkflowResume: OrchestratorTaskHandler = async (ctx, msg, payload) => {
  try {
    const path = await resolveExecutionPathForWorkflow(msg.workflowId);
    if (path === "a2a") {
      /**
       * A2A 路径：让 orchestrator 自己重新跑一遍 ReAct loop。
       * runA2aReactTaskAssign 内部已经处理 awaiting_approval、failed 分支，
       * 也会自己发 TASK_RESULT（这里就不重复发 success TASK_RESULT 了）。
       */
      await runA2aReactTaskAssign(ctx, msg);
      return;
    }

    /** Graph 路径：保留旧行为 */
    const result = await graphRunner.resumeRoleTask({
      workflowId: msg.workflowId,
      role: "orchestrator",
      payload,
      traceId: msg.traceId,
    });
    await ctx.send({
      workflowId: msg.workflowId,
      traceId: msg.traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_RESULT",
      payload: buildTaskResult(payload.taskId, "orchestrator", {
        result: {
          taskType: payload.taskType,
          runId: result.runId,
          resumed: result.resumed,
        },
      }),
      priority: msg.priority,
    });
  } catch (err) {
    await setWorkflowStatus(msg.workflowId, "failed");
    const errorMessage = err instanceof Error ? err.message : String(err);
    await ctx.send({
      workflowId: msg.workflowId,
      traceId: msg.traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_RESULT",
      payload: buildTaskResult(payload.taskId, "orchestrator", {
        success: false,
        result: {
          taskType: payload.taskType,
          error: errorMessage,
        },
        errorMessage,
      }),
      priority: msg.priority,
    });
  }
};

/**
 * research_team_execute：与 Graph 路径短路共用 `runTeamResearchAndPersist` helper，
 * 由 helper 负责 status / HITL pause / SSE final / analyst job。这里只负责把
 * outcome 翻译成 A2A TASK_RESULT 消息。
 */
const handleResearchTeamExecute: OrchestratorTaskHandler = async (ctx, msg, payload) => {
  const parsed = parseResearchTeamExecutePayload(payload);
  if (!parsed.ok) {
    await failResearchTeamExecuteJob(parsed.jobId, parsed.error);
    await setWorkflowStatus(msg.workflowId, "failed");
    return;
  }

  const hitlApproval = parseHitlApproval(
    (payload.params as Record<string, unknown>).hitlApproval,
  );

  const outcome = await runTeamResearchAndPersist({
    workflowRunId: msg.workflowId,
    runId: msg.workflowId,
    traceId: msg.traceId,
    parsed: parsed.params,
    hitlApproval,
  });

  if (outcome.kind === "completed") {
    await ctx.send({
      workflowId: msg.workflowId,
      traceId: msg.traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_RESULT",
      payload: buildTaskResult(payload.taskId, "orchestrator", {
        result: {
          taskType: "research_team_execute",
          fusionId: outcome.teamResult.fusionId,
          fusedSignal: outcome.teamResult.fusedSignal,
          fusedConfidence: outcome.teamResult.fusedConfidence,
        },
      }),
      priority: msg.priority,
    });
    return;
  }

  if (outcome.kind === "awaiting_approval") {
    return;
  }

  await ctx.send({
    workflowId: msg.workflowId,
    traceId: msg.traceId,
    receiverAgent: msg.senderAgent,
    messageType: "TASK_RESULT",
    payload: buildTaskResult(payload.taskId, "orchestrator", {
      success: false,
      result: {
        taskType: "research_team_execute",
        error: outcome.error.message,
      },
      errorMessage: outcome.error.message,
    }),
    priority: msg.priority,
  });
};

const ORCHESTRATOR_TASK_HANDLERS: Record<string, OrchestratorTaskHandler> = {
  workflow_resume: handleWorkflowResume,
  workflow_retry: handleWorkflowResume,
  research_team_execute: handleResearchTeamExecute,
};

/**
 * 完整 orchestrator handler。非 TASK_ASSIGN 一律 noop；TASK_ASSIGN 按 taskType
 * 路由，未命中且 assignedRole 是其他 role 则转发，否则交给 runA2aReactTaskAssign。
 *
 * P0-A 修复留痕：历史上 "workflow_start" 在这里直接 setWorkflowStatus("completed")
 * + 发假 TASK_RESULT 退出，相当于 A2A 路径下 orchestrator 根本不跑推理。现在
 * 所有未在 ORCHESTRATOR_TASK_HANDLERS 中的 taskType 都会落到 runA2aReactTaskAssign。
 */
export function createOrchestratorHandler(): RuntimeRoleHandler {
  return {
    onInit: async (ctx) => {
      console.log(`[RoleHandler:orchestrator] init instance=${ctx.instance.instanceId}`);
    },
    onMessage: async (ctx, msg) => {
      if (msg.messageType !== "TASK_ASSIGN") {
        return;
      }

      const payload = msg.payload as TaskAssignPayload;

      const handler = ORCHESTRATOR_TASK_HANDLERS[payload.taskType];
      if (handler) {
        await handler(ctx, msg, payload);
        return;
      }

      const delegateRole = payload.assignedRole;
      if (delegateRole && delegateRole !== "orchestrator") {
        await ctx.send({
          workflowId: msg.workflowId,
          traceId: msg.traceId,
          receiverAgent: receiverForRole(delegateRole, msg.senderAgent),
          messageType: "TASK_ASSIGN",
          payload,
          priority: msg.priority,
        });
        return;
      }

      await runA2aReactTaskAssign(ctx, msg);
    },
    onShutdown: async () => {
      console.log(`[RoleHandler:orchestrator] shutdown`);
    },
  };
}
