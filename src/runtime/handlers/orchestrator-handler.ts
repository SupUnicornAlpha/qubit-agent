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
import {
  failResearchTeamExecuteJob,
  parseResearchTeamExecutePayload,
  runTeamResearchAndPersist,
} from "../msa/research-team-execute";
import { parseHitlApproval } from "../workflow/hitl-service";
import { parseHandoffEnvelope } from "../research-team/handoff-envelope";
import { logResearchTeamInteraction } from "../research-team/interaction-log";
import type { RuntimeHandlerContext, RuntimeRoleHandler } from "../types";
import { onWorkflowTerminal } from "../monitor/observability-hook";
import { setWorkflowState } from "../workflow/workflow-state-machine";

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
 * workflow_resume / workflow_retry：收敛后续跑唯一走 A2A —— 让 orchestrator 自己
 * 重新跑一遍 ReAct loop（runA2aReactTaskAssign）。
 *
 * 续跑上下文来源：
 *   - 自研 snapshot：payload.params.resume=true 时 executeAgentReact 按 workflowId 取
 *     最近 agent_checkpoint_snapshot 还原运行态、从下一轮 reason 重入（进程重启 / sweep）。
 *   - HITL approve：hitlApproval / hitlPayload 通过 payload.params 自然进入 LLM 上下文，
 *     orchestrator 重跑 ReAct 自行决定下一步（不带 snapshot resume）。
 *
 * A2A 的 source of truth 是消息流（a2a_message）+ analystResearchJob.resumePayload +
 * 自研 snapshot，orchestrator 完全可以重建上下文。
 *
 * runA2aReactTaskAssign 内部已处理 awaiting_approval / failed 分支并自己发 TASK_RESULT。
 */
const handleWorkflowResume: OrchestratorTaskHandler = async (ctx, msg, payload) => {
  try {
    await runA2aReactTaskAssign(ctx, msg);
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

/**
 * orchestrator_chat：研究团队页的「对话消息」入口（非「启动团队分析」按钮）。
 * 让 orchestrator 跑 ReAct 自主判断——直接回答 / assign_task 派给特定子 agent /
 * run_analyst_team 跑全队（见 reason.ts 注入的调度决策指引）。跑完把它的最终自然语言
 * 答复落库为 orchestrator→user 交互，供右栏对话框持久展示（token 已实时流式）。
 */
const handleOrchestratorChat: OrchestratorTaskHandler = async (ctx, msg) => {
  const res = await runA2aReactTaskAssign(ctx, msg);
  if (res && res.terminalStatus !== "failed") {
    try {
      /**
       * 取 orchestrator 最终面向用户的自然语言答复。
       *
       * 关键修复：当 orchestrator 直接回答（tool=none，act.ts 走 skippedToolCall 分支）时，
       * finalResponse 形如 `{status,role,iteration,skippedToolCall:true,summary}` ——
       * 答复在 `summary`，**没有** `observation` / `reasonText` 字段。之前误读
       * `finalResponse.observation.reasonText` 永远是 undefined → 答复永不落库 →
       * 右栏看不到回复。这里按多种 finalize 形态兜底取值。
       */
      const fr = (res.finalResponse ?? {}) as Record<string, unknown>;
      const obs = (fr.observation ?? {}) as Record<string, unknown>;
      const pick = (v: unknown): string =>
        typeof v === "string" && v.trim() && v.trim() !== "no tool requested" ? v.trim() : "";
      // answerText（act.ts skippedToolCall 注入的完整 reason 文本）最贴近用户答复，优先；
      // 再退回 summary / reasonText / observation.reasonText 兼容其它 finalize 形态。
      const answer =
        pick(fr.answerText) || pick(fr.summary) || pick(fr.reasonText) || pick(obs.reasonText);
      if (answer) {
        // 交接信封解析也覆盖 chat 路径的 orchestrator 答复（测评复盘 #3）。
        const handoff = parseHandoffEnvelope(answer);
        await logResearchTeamInteraction({
          workflowRunId: msg.workflowId,
          fromRole: "orchestrator",
          toRole: "user",
          kind: "llm_message",
          contentText: answer.slice(0, 6000),
          payloadJson: { phase: "orchestrator_chat_answer", ...(handoff ? { handoff } : {}) },
        });
      }
    } catch (err) {
      console.warn(`[orchestrator-handler] log chat answer failed: ${(err as Error).message}`);
    }
  }
};

const ORCHESTRATOR_TASK_HANDLERS: Record<string, OrchestratorTaskHandler> = {
  workflow_resume: handleWorkflowResume,
  workflow_retry: handleWorkflowResume,
  research_team_execute: handleResearchTeamExecute,
  orchestrator_chat: handleOrchestratorChat,
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
