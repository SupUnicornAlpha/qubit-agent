/**
 * Orchestrator role 的专用 handler。
 *
 * P1-C 拆分：原 `role-handlers.ts` 里的 `orchestratorHandler.onMessage` 把
 * `workflow_resume / workflow_retry` / delegate / default 四种 TASK_ASSIGN 用 if
 * 分支堆在一个 30+ 行的箭头函数里，可读性差、难以单测。这里按 task type
 * 拆成独立函数 + 一个分发表，且所有 Agent 执行统一交给 Rust Core。
 *
 * 设计：
 * - 每个分支函数自己负责发 TASK_RESULT（成功 / 失败）并管理 workflow status
 * - 分发表 ORCHESTRATOR_TASK_HANDLERS 把 taskType → handler 映射成数据
 * - main onMessage 只负责"非 TASK_ASSIGN noop / 分发"，保持极薄
 */

import type { TaskAssignPayload } from "../../types/a2a";
import type { A2AMessageEnvelope } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import { getA2APool } from "../a2a/a2a-pool";
import { runOrchestratorTaskViaCore } from "../prime/run-orchestrator-via-core";
import type { RuntimeHandlerContext, RuntimeRoleHandler } from "../types";

function receiverForRole(role: AgentRole, fallback: string): string {
  try {
    return getA2APool().getInstanceIdForRole(role);
  } catch {
    return fallback;
  }
}

/** 统一抽取 Core/历史任务结果中的面向用户正文。 */
export function extractWorkflowFinalAnswer(finalResponse: unknown): string {
  if (!finalResponse || typeof finalResponse !== "object" || Array.isArray(finalResponse)) {
    return "";
  }
  const response = finalResponse as Record<string, unknown>;
  const observation =
    response.observation &&
    typeof response.observation === "object" &&
    !Array.isArray(response.observation)
      ? (response.observation as Record<string, unknown>)
      : {};
  const pick = (value: unknown): string =>
    typeof value === "string" && value.trim() && value.trim() !== "no tool requested"
      ? value.trim()
      : "";
  return (
    pick(response.answerText) ||
    pick(response.summary) ||
    pick(response.reasonText) ||
    pick(observation.reasonText)
  );
}

type OrchestratorTaskHandler = (
  ctx: RuntimeHandlerContext,
  msg: A2AMessageEnvelope,
  payload: TaskAssignPayload
) => Promise<void>;

/** workflow resume/retry is a Rust Core turn; there is no TS fallback. */
const handleWorkflowResume: OrchestratorTaskHandler = async (ctx, msg, payload) => {
  await runOrchestratorTaskViaCore(ctx, msg, payload);
};

/** All user-facing Agent work is a conversational Rust Core turn. */
const handleOrchestratorChat: OrchestratorTaskHandler = async (ctx, msg, payload) => {
  await runOrchestratorTaskViaCore(ctx, msg, payload);
};

const ORCHESTRATOR_TASK_HANDLERS: Record<string, OrchestratorTaskHandler> = {
  workflow_resume: handleWorkflowResume,
  workflow_retry: handleWorkflowResume,
  orchestrator_chat: handleOrchestratorChat,
};

/**
 * 完整 orchestrator handler。非 TASK_ASSIGN 一律 noop；TASK_ASSIGN 按 taskType
 * 路由，未命中且 assignedRole 是其他 role 则转发，否则交给 Rust Core。
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

      await runOrchestratorTaskViaCore(ctx, msg, payload);
    },
    onShutdown: async () => {
      console.log("[RoleHandler:orchestrator] shutdown");
    },
  };
}
