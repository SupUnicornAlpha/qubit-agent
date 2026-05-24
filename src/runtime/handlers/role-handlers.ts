import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import type { OrderIntentPayload, TaskAssignPayload } from "../../types/a2a";
import { ALL_AGENT_ROLES, type AgentRole } from "../../types/entities";
import { runA2aReactTaskAssign } from "../a2a/a2a-react-task";
import { buildTaskResult } from "../a2a/task-result";
import { getA2APool } from "../a2a/a2a-pool";
import { graphRunner } from "../langgraph/graph-factory";
import { HitlAwaitingApprovalError } from "../workflow/hitl-service";
import {
  executeResearchTeamWorkflow,
  failResearchTeamExecuteJob,
  parseResearchTeamExecutePayload,
} from "../msa/research-team-execute";
import { parseHitlApproval } from "../workflow/hitl-service";
import { pauseAnalystResearchJobForHitl } from "../msa/analyst-research-jobs";
import type { RuntimeRoleHandler } from "../types";
import { onWorkflowTerminal } from "../monitor/observability-hook";

async function setWorkflowStatus(
  workflowId: string,
  status: "completed" | "failed" | "running" | "awaiting_approval"
): Promise<void> {
  const db = await getDb();
  await db
    .update(workflowRun)
    .set({
      status,
      endedAt: status === "running" || status === "awaiting_approval" ? null : new Date().toISOString(),
    })
    .where(eq(workflowRun.id, workflowId));
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

const noopHandler = (role: AgentRole): RuntimeRoleHandler => ({
  onInit: async (ctx) => {
    console.log(`[RoleHandler:${role}] init instance=${ctx.instance.instanceId}`);
  },
  onMessage: async (ctx, msg) => {
    if (msg.messageType === "TASK_ASSIGN") {
      await runA2aReactTaskAssign(ctx, msg);
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

    if (payload.taskType === "workflow_resume" || payload.taskType === "workflow_retry") {
      // 用 LangGraph checkpointer 续跑/重跑（A2A 自己不存 graph state）。
      try {
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
        await ctx.send({
          workflowId: msg.workflowId,
          traceId: msg.traceId,
          receiverAgent: msg.senderAgent,
          messageType: "TASK_RESULT",
          payload: buildTaskResult(payload.taskId, "orchestrator", {
            success: false,
            result: {
              taskType: payload.taskType,
              error: err instanceof Error ? err.message : String(err),
            },
            errorMessage: err instanceof Error ? err.message : String(err),
          }),
          priority: msg.priority,
        });
      }
      return;
    }

    if (payload.taskType === "research_team_execute") {
      const parsed = parseResearchTeamExecutePayload(payload);
      if (!parsed.ok) {
        failResearchTeamExecuteJob(parsed.jobId, parsed.error);
        await setWorkflowStatus(msg.workflowId, "failed");
        return;
      }

      const hitlApproval = parseHitlApproval(
        (payload.params as Record<string, unknown>).hitlApproval
      );

      try {
        const teamResult = await executeResearchTeamWorkflow({
          workflowRunId: msg.workflowId,
          params: parsed.params,
          hitlApproval,
        });
        await setWorkflowStatus(msg.workflowId, "completed");
        await ctx.send({
          workflowId: msg.workflowId,
          traceId: msg.traceId,
          receiverAgent: msg.senderAgent,
          messageType: "TASK_RESULT",
          payload: buildTaskResult(payload.taskId, "orchestrator", {
            result: {
              taskType: "research_team_execute",
              fusionId: teamResult.fusionId,
              fusedSignal: teamResult.fusedSignal,
              fusedConfidence: teamResult.fusedConfidence,
            },
          }),
          priority: msg.priority,
        });
      } catch (teamErr) {
        if (teamErr instanceof HitlAwaitingApprovalError) {
          // 把 analyst job 标 awaiting_approval 并缓存 resumePayload；前端轮询会拿到 requestId / 摘要。
          pauseAnalystResearchJobForHitl(parsed.params.jobId, {
            requestId: teamErr.requestId,
            title: teamErr.message,
            summary: teamErr.message,
            resumePayload: parsed.params,
          });
          await setWorkflowStatus(msg.workflowId, "awaiting_approval");
          return;
        }
        failResearchTeamExecuteJob(parsed.params.jobId, teamErr);
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
        result: {
          taskType: payload.taskType,
          next: "orchestrator handled",
        },
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
    const signature = createHmac("sha256", signingKey).update(intent.orderIntentId).digest("hex");

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
          result: {
            orderIntentId: intent.orderIntentId,
            executionStatus: "accepted_by_runtime_handler",
          },
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
      const signature = createHmac("sha256", signingKey).update(intent.orderIntentId).digest("hex");

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
