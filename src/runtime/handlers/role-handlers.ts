import { createHmac, randomUUID } from "node:crypto";
import type { OrderIntentPayload, TaskAssignPayload } from "../../types/a2a";
import { ALL_AGENT_ROLES, type AgentRole } from "../../types/entities";
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
import type { RuntimeRoleHandler } from "../types";
import { onWorkflowTerminal } from "../monitor/observability-hook";
import { setWorkflowState } from "../workflow/workflow-state-machine";

async function setWorkflowStatus(
  workflowId: string,
  status: "completed" | "failed" | "running" | "awaiting_approval",
): Promise<void> {
  await setWorkflowState(workflowId, status, { reason: "role-handlers" });
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
        await failResearchTeamExecuteJob(parsed.jobId, parsed.error);
        await setWorkflowStatus(msg.workflowId, "failed");
        return;
      }

      const hitlApproval = parseHitlApproval(
        (payload.params as Record<string, unknown>).hitlApproval
      );

      /**
       * 与 GraphRunner.executeGraph 短路共用同一份持久化 helper。
       * helper 负责 workflow_run.status / HITL pause / SSE final / analyst job 状态；
       * 这里只负责把 outcome 翻译成 A2A TASK_RESULT 消息。
       */
      const outcome = await runTeamResearchAndPersist({
        workflowRunId: msg.workflowId,
        runId: msg.workflowId, // A2A 没有独立 runId，复用 workflowId 让 SSE 仍可订阅
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
        /** 仅 SSE 通知（helper 已发 final/awaiting_approval）；A2A sender 不需要 TASK_RESULT */
        return;
      }

      /** failed：发一个失败 TASK_RESULT，避免 sender 永远等待（旧版只 throw，调用方收不到） */
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

    /**
     * 默认路径（含 workflow_start 等所有 orchestrator 自己执行的任务）：跑 ReAct。
     *
     * P0-A 修复：历史上这里把 workflow_start 直接 setWorkflowStatus("completed")
     * + 发一条"orchestrator handled" 的假 TASK_RESULT 就退出，相当于 A2A 路径下
     * orchestrator 根本不跑推理 —— 任何 `executionPath='a2a'` 的工作流默认派给
     * orchestrator 都等于"什么都不做"。改成与 noopHandler 行为一致：交给
     * `runA2aReactTaskAssign` 真跑 ReAct，由它写状态 + 发 TASK_RESULT。
     */
    await runA2aReactTaskAssign(ctx, msg);
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
