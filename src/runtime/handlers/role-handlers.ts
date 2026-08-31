/**
 * Role handler registry。
 *
 * P1-C 重构：本文件历史上把 orchestrator 4 路 task type 分发 + risk/execution
 * 系列 ORDER_INTENT 流共 326 行混在一起写。现在拆成：
 *  - `orchestrator-handler.ts`：orchestrator 任务调度
 *  - `order-intent-handler.ts`：risk / execution / risk_manager / execution_trader
 *
 * 本文件只负责：定义 `noopHandler`（17 个 role 共享）+ 拼出最终 registry。
 */

import {
  type A2AMessageEnvelope,
  type TaskAssignPayload,
  TaskAssignPayloadSchema,
} from "../../types/a2a";
import { ALL_AGENT_ROLES, type AgentRole } from "../../types/entities";
import { runA2aReactTaskAssign } from "../a2a/a2a-react-task";
import type { RuntimeRoleHandler } from "../types";
import { createOrchestratorHandler } from "./orchestrator-handler";
import {
  createOrderIntentExecutionHandler,
  createRiskSigningHandler,
} from "./order-intent-handler";

/**
 * 默认 role handler：收到 TASK_ASSIGN 就跑 ReAct；其他消息忽略。
 *
 * 22 个 role 里有 17 个用这个 handler（除 orchestrator / risk / risk_manager /
 * execution / execution_trader 外的全部）。
 */
export function parseTaskAssignPayload(msg: A2AMessageEnvelope): TaskAssignPayload {
  if (msg.messageType !== "TASK_ASSIGN") {
    throw new Error(`expected TASK_ASSIGN, got ${msg.messageType}`);
  }
  return TaskAssignPayloadSchema.parse(msg.payload);
}

const noopHandler = (role: AgentRole): RuntimeRoleHandler => ({
  onInit: async (ctx) => {
    console.log(`[RoleHandler:${role}] init instance=${ctx.instance.instanceId}`);
  },
  onMessage: async (ctx, msg) => {
    if (msg.messageType === "TASK_ASSIGN") {
      // The router validates the envelope, but handlers must still pass the
      // decoded payload explicitly. Omitting it makes the A2A worker crash on
      // payload.taskType before it can return a durable TASK_RESULT.
      const payload = parseTaskAssignPayload(msg);
      await runA2aReactTaskAssign(ctx, msg, payload);
    }
  },
  onShutdown: async () => {
    console.log(`[RoleHandler:${role}] shutdown`);
  },
});

const handlers = Object.fromEntries(
  ALL_AGENT_ROLES.map((role) => [role, noopHandler(role)])
) as Record<AgentRole, RuntimeRoleHandler>;

handlers.orchestrator = createOrchestratorHandler();
handlers.risk = createRiskSigningHandler("risk", "execution");
handlers.risk_manager = createRiskSigningHandler("risk_manager", "execution_trader");
handlers.execution = createOrderIntentExecutionHandler("execution");
handlers.execution_trader = createOrderIntentExecutionHandler("execution_trader");

export function getRoleHandler(role: AgentRole): RuntimeRoleHandler {
  return handlers[role] ?? noopHandler(role);
}
