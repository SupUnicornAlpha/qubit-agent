import { createHmac, randomUUID } from "node:crypto";
import type { OrderIntentPayload, TaskAssignPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import type { RuntimeRoleHandler } from "../types";

function buildTaskResult(taskId: string, role: AgentRole, extra?: Record<string, unknown>) {
  return {
    taskId,
    success: true,
    result: {
      handledByRole: role,
      ...extra,
    },
    durationMs: 0,
  };
}

const noopHandler = (role: AgentRole): RuntimeRoleHandler => ({
  onInit: async (ctx) => {
    console.log(`[RoleHandler:${role}] init instance=${ctx.instance.instanceId}`);
  },
  onMessage: async (ctx, msg) => {
    if (msg.messageType === "TASK_ASSIGN") {
      const payload = msg.payload as TaskAssignPayload;
      await ctx.send({
        workflowId: msg.workflowId,
        traceId: msg.traceId,
        receiverAgent: msg.senderAgent,
        messageType: "TASK_RESULT",
        payload: buildTaskResult(payload.taskId, role),
        priority: msg.priority,
      });
    }
  },
  onShutdown: async () => {
    console.log(`[RoleHandler:${role}] shutdown`);
  },
});

const orchestratorHandler: RuntimeRoleHandler = {
  ...noopHandler("orchestrator"),
  onMessage: async (ctx, msg) => {
    if (msg.messageType === "TASK_ASSIGN") {
      const payload = msg.payload as TaskAssignPayload;
      await ctx.send({
        workflowId: msg.workflowId,
        traceId: msg.traceId,
        receiverAgent: msg.senderAgent,
        messageType: "TASK_RESULT",
        payload: buildTaskResult(payload.taskId, "orchestrator", {
          next: "role handler wiring complete",
        }),
        priority: msg.priority,
      });
    }
  },
};

const riskHandler: RuntimeRoleHandler = {
  ...noopHandler("risk"),
  onMessage: async (ctx, msg) => {
    if (msg.messageType !== "ORDER_INTENT") {
      return noopHandler("risk").onMessage(ctx, msg);
    }

    const intent = msg.payload as OrderIntentPayload;
    const signingKey = process.env["QUBIT_RISK_SIGNING_KEY"] ?? "dev-secret";
    const signature = createHmac("sha256", signingKey)
      .update(intent.orderIntentId)
      .digest("hex");

    // V1.3 role handler: default allow path, full rule engine comes later.
    await ctx.send({
      workflowId: msg.workflowId,
      traceId: msg.traceId,
      receiverAgent: msg.senderAgent,
      messageType: "ORDER_INTENT",
      payload: { ...intent, riskSignature: signature },
      priority: msg.priority,
    });
  },
};

const executionHandler: RuntimeRoleHandler = {
  ...noopHandler("execution"),
  onMessage: async (ctx, msg) => {
    if (msg.messageType !== "ORDER_INTENT") {
      return noopHandler("execution").onMessage(ctx, msg);
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
      payload: buildTaskResult(randomUUID(), "execution", {
        orderIntentId: intent.orderIntentId,
        executionStatus: "accepted_by_runtime_handler",
      }),
      priority: msg.priority,
    });
  },
};

const handlers: Record<AgentRole, RuntimeRoleHandler> = {
  orchestrator: orchestratorHandler,
  market_data: noopHandler("market_data"),
  news_event: noopHandler("news_event"),
  research: noopHandler("research"),
  backtest: noopHandler("backtest"),
  simulation: noopHandler("simulation"),
  risk: riskHandler,
  execution: executionHandler,
  memory: noopHandler("memory"),
  audit: noopHandler("audit"),
};

export function getRoleHandler(role: AgentRole): RuntimeRoleHandler {
  return handlers[role];
}

