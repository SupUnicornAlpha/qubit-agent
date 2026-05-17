import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import type { OrderIntentPayload, TaskAssignPayload } from "../../types/a2a";
import { ALL_AGENT_ROLES, type AgentRole } from "../../types/entities";
import { getA2APool } from "../a2a/a2a-pool";
import { completeAnalystResearchJob, failAnalystResearchJob } from "../msa/analyst-research-jobs";
import { RESEARCH_TEAM_SLOT_SET, runAnalystTeam } from "../msa/analyst-team";
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

async function setWorkflowStatus(
  workflowId: string,
  status: "completed" | "failed" | "running"
): Promise<void> {
  const db = await getDb();
  await db
    .update(workflowRun)
    .set({
      status,
      endedAt: status === "running" ? null : new Date().toISOString(),
    })
    .where(eq(workflowRun.id, workflowId));
}

function receiverForRole(role: AgentRole, fallback: string): string {
  try {
    return getA2APool().getInstanceIdForRole(role);
  } catch {
    return fallback;
  }
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
    if (msg.messageType !== "TASK_ASSIGN") {
      return noopHandler("orchestrator").onMessage(ctx, msg);
    }

    const payload = msg.payload as TaskAssignPayload;

    if (payload.taskType === "research_team_execute") {
      type ResearchTeamExecuteParams = {
        jobId?: string;
        ticker?: string;
        context?: string;
        agentGroupId?: string | null;
        analystDefinitionIds?: string[];
        analystRoles?: string[];
      };
      const pr = payload.params as ResearchTeamExecuteParams;
      const jobId = typeof pr.jobId === "string" ? pr.jobId : "";
      const ticker = typeof pr.ticker === "string" ? pr.ticker.trim() : "";
      const context = typeof pr.context === "string" ? pr.context : undefined;
      let agentGroupId: string | null | undefined;
      if ("agentGroupId" in pr) {
        const ag = pr.agentGroupId;
        if (ag === null) agentGroupId = null;
        else if (typeof ag === "string") agentGroupId = ag.trim() || null;
      }
      const rawDefIds = pr.analystDefinitionIds;
      const analystDefinitionIds =
        Array.isArray(rawDefIds) && rawDefIds.length > 0
          ? rawDefIds.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          : undefined;
      const rawRoles = pr.analystRoles;
      const analystRoles =
        Array.isArray(rawRoles) && rawRoles.length > 0
          ? (rawRoles.filter(
              (r): r is AgentRole => typeof r === "string" && RESEARCH_TEAM_SLOT_SET.has(r)
            ) as AgentRole[])
          : undefined;

      if (!jobId || !ticker) {
        if (jobId) failAnalystResearchJob(jobId, new Error("research_team_execute: missing ticker"));
        await setWorkflowStatus(msg.workflowId, "failed");
        return;
      }

      try {
        const teamResult = await runAnalystTeam({
          workflowRunId: msg.workflowId,
          ticker,
          context,
          agentGroupId,
          analystRoles,
          analystDefinitionIds,
        });
        completeAnalystResearchJob(jobId, teamResult);
        await setWorkflowStatus(msg.workflowId, "completed");
        await ctx.send({
          workflowId: msg.workflowId,
          traceId: msg.traceId,
          receiverAgent: msg.senderAgent,
          messageType: "TASK_RESULT",
          payload: buildTaskResult(payload.taskId, "orchestrator", {
            taskType: "research_team_execute",
            fusionId: teamResult.fusionId,
            fusedSignal: teamResult.fusedSignal,
            fusedConfidence: teamResult.fusedConfidence,
          }),
          priority: msg.priority,
        });
      } catch (teamErr) {
        failAnalystResearchJob(jobId, teamErr);
        await setWorkflowStatus(msg.workflowId, "failed");
        throw teamErr;
      }
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

    if (payload.taskType === "workflow_start") {
      await setWorkflowStatus(msg.workflowId, "completed");
    }

    await ctx.send({
      workflowId: msg.workflowId,
      traceId: msg.traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_RESULT",
      payload: buildTaskResult(payload.taskId, "orchestrator", {
        taskType: payload.taskType,
        next: "orchestrator handled",
      }),
      priority: msg.priority,
    });
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

    await ctx.send({
      workflowId: msg.workflowId,
      traceId: msg.traceId,
      receiverAgent: receiverForRole("execution", msg.senderAgent),
      messageType: "ORDER_INTENT",
      payload: { ...intent, riskSignature: signature },
      priority: msg.priority,
    });
  },
};

function createOrderIntentExecutionHandler(role: AgentRole): RuntimeRoleHandler {
  const base = noopHandler(role);
  return {
    ...base,
    onMessage: async (ctx, msg) => {
      if (msg.messageType !== "ORDER_INTENT") {
        return base.onMessage(ctx, msg);
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
          orderIntentId: intent.orderIntentId,
          executionStatus: "accepted_by_runtime_handler",
        }),
        priority: msg.priority,
      });
    },
  };
}

const executionHandler = createOrderIntentExecutionHandler("execution");
const executionTraderHandler = createOrderIntentExecutionHandler("execution_trader");

function createRiskSigningHandler(
  role: AgentRole,
  forwardExecutionRole: AgentRole
): RuntimeRoleHandler {
  const base = noopHandler(role);
  return {
    ...base,
    onMessage: async (ctx, msg) => {
      if (msg.messageType !== "ORDER_INTENT") {
        return base.onMessage(ctx, msg);
      }

      const intent = msg.payload as OrderIntentPayload;
      const signingKey = process.env["QUBIT_RISK_SIGNING_KEY"] ?? "dev-secret";
      const signature = createHmac("sha256", signingKey)
        .update(intent.orderIntentId)
        .digest("hex");

      await ctx.send({
        workflowId: msg.workflowId,
        traceId: msg.traceId,
        receiverAgent: receiverForRole(
          forwardExecutionRole,
          receiverForRole("execution", msg.senderAgent)
        ),
        messageType: "ORDER_INTENT",
        payload: { ...intent, riskSignature: signature },
        priority: msg.priority,
      });
    },
  };
}

const riskManagerHandler = createRiskSigningHandler("risk_manager", "execution_trader");

const handlers = Object.fromEntries(
  ALL_AGENT_ROLES.map((role) => [role, noopHandler(role)])
) as Record<AgentRole, RuntimeRoleHandler>;

handlers.orchestrator = orchestratorHandler;
handlers.risk = riskHandler;
handlers.risk_manager = riskManagerHandler;
handlers.execution = executionHandler;
handlers.execution_trader = executionTraderHandler;

export function getRoleHandler(role: AgentRole): RuntimeRoleHandler {
  return handlers[role] ?? noopHandler(role);
}
