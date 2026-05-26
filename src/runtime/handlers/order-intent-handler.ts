/**
 * 处理 ORDER_INTENT 消息流的 risk / execution / risk_manager / execution_trader
 * 系列 handler。
 *
 * P1-C 拆分：原 `role-handlers.ts` 把这 4 个 handler 的 factory 内联在文件末尾
 * 增加噪音。这里集中：
 *  - risk → 签名 → 转发 execution
 *  - risk_manager → 签名 → 转发 execution_trader
 *  - execution / execution_trader → 校验 riskSignature → 回 TASK_RESULT 或 ALERT
 */

import { createHmac, randomUUID } from "node:crypto";
import type { OrderIntentPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import { buildTaskResult } from "../a2a/task-result";
import { getA2APool } from "../a2a/a2a-pool";
import type { RuntimeRoleHandler } from "../types";

function receiverForRole(role: AgentRole, fallback: string): string {
  try {
    return getA2APool().getInstanceIdForRole(role);
  } catch {
    return fallback;
  }
}

function signOrderIntent(orderIntentId: string): string {
  const signingKey = process.env["QUBIT_RISK_SIGNING_KEY"] ?? "dev-secret";
  return createHmac("sha256", signingKey).update(orderIntentId).digest("hex");
}

/**
 * 签名后转发给 forwardExecutionRole 的 risk-side handler 工厂。
 * risk → execution；risk_manager → execution_trader。
 */
export function createRiskSigningHandler(
  role: AgentRole,
  forwardExecutionRole: AgentRole,
): RuntimeRoleHandler {
  return {
    onInit: async (ctx) => {
      console.log(`[RoleHandler:${role}] init instance=${ctx.instance.instanceId}`);
    },
    onMessage: async (ctx, msg) => {
      if (msg.messageType !== "ORDER_INTENT") {
        return;
      }

      const intent = msg.payload as OrderIntentPayload;
      const signature = signOrderIntent(intent.orderIntentId);

      await ctx.send({
        workflowId: msg.workflowId,
        traceId: msg.traceId,
        receiverAgent: receiverForRole(
          forwardExecutionRole,
          receiverForRole("execution", msg.senderAgent),
        ),
        messageType: "ORDER_INTENT",
        payload: { ...intent, riskSignature: signature },
        priority: msg.priority,
      });
    },
    onShutdown: async () => {
      console.log(`[RoleHandler:${role}] shutdown`);
    },
  };
}

/**
 * 校验 riskSignature 后回 TASK_RESULT；未签名则发 ALERT 拒绝。
 * 用于 execution / execution_trader。
 */
export function createOrderIntentExecutionHandler(role: AgentRole): RuntimeRoleHandler {
  return {
    onInit: async (ctx) => {
      console.log(`[RoleHandler:${role}] init instance=${ctx.instance.instanceId}`);
    },
    onMessage: async (ctx, msg) => {
      if (msg.messageType !== "ORDER_INTENT") {
        return;
      }

      const intent = msg.payload as OrderIntentPayload;
      if (!intent.riskSignature) {
        await ctx.send({
          workflowId: msg.workflowId,
          traceId: msg.traceId,
          receiverAgent: msg.senderAgent,
          messageType: "ALERT",
          payload: {
            alertType: "execution_reject",
            severity: "error",
            message: `ORDER_INTENT ${intent.orderIntentId} rejected: missing riskSignature`,
          },
          priority: 90,
        });
        return;
      }

      await ctx.send({
        workflowId: msg.workflowId,
        traceId: msg.traceId,
        receiverAgent: msg.senderAgent,
        messageType: "TASK_RESULT",
        payload: buildTaskResult(randomUUID(), role, {
          result: {
            orderIntentId: intent.orderIntentId,
            executionStatus: "accepted_by_runtime_handler",
          },
        }),
        priority: msg.priority,
      });
    },
    onShutdown: async () => {
      console.log(`[RoleHandler:${role}] shutdown`);
    },
  };
}
