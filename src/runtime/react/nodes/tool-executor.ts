/**
 * ToolExecutor owns transport selection and timeout enforcement after a request
 * has passed ToolAdmission and the sandbox preflight in actNode.
 */
import { buildAcpRequest, defaultAcpCaller } from "../../../messaging/acp";
import { dispatchMcpToolCall } from "../../mcp/dispatcher";
import { resolveTopologyToolTimeoutMs } from "../../orchestration/topology-dispatch";
import { sandboxExecutor } from "../../sandbox-executor";
import { dispatchBuiltinTool, isBuiltinTool } from "../../tools/builtin-tools";
import type { AgentGraphState } from "../state";
import type { ToolPlan } from "./tool-plan";

export async function executeAdmittedTool(input: {
  state: AgentGraphState;
  plan: ToolPlan;
  params: Record<string, unknown>;
  projectId: string | undefined;
  agentInstanceId: string;
  agentStepId: string;
  toolCallId: string;
  gateTimeoutMs: number | undefined;
}) {
  const { state, plan } = input;
  const topologyToolTimeoutMs = resolveTopologyToolTimeoutMs(plan.effectiveToolName);
  return sandboxExecutor.enforceToolTimeout({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    agentInstanceId: input.agentInstanceId,
    definition: state.agentDefinition,
    ...(input.gateTimeoutMs !== undefined
      ? { timeoutMs: input.gateTimeoutMs }
      : topologyToolTimeoutMs !== undefined
        ? { timeoutMs: topologyToolTimeoutMs }
        : {}),
    action: async () => {
      if (plan.mcp) {
        try {
          const mcpResult = await dispatchMcpToolCall({
            ...(input.projectId ? { projectId: input.projectId } : {}),
            definitionId: state.agentDefinition.id,
            serverName: plan.mcp.serverName,
            toolName: plan.mcp.toolName,
            arguments: plan.mcp.arguments,
          });
          return { result: "ok" as const, mcpResult };
        } catch (error) {
          return toolError("mcp", error);
        }
      }
      if (plan.connectorTarget) {
        try {
          const policy = await sandboxExecutor.loadPolicy(state.agentDefinition);
          const request = buildAcpRequest({
            sessionId: state.inboundMessage.messageId,
            workflowId: state.workflowId,
            senderAgent: input.agentInstanceId,
            targetKind: "connector",
            targetName: plan.connectorTarget,
            intent: plan.effectiveToolName,
            payload: { operation: plan.effectiveToolName, params: input.params },
            timeoutMs: input.gateTimeoutMs ?? policy.maxToolCallMs,
          });
          const response = await defaultAcpCaller.call(request);
          if (response.status !== "success") {
            const code = response.errorCode ?? response.status ?? "connector_call_failed";
            const detail = response.errorDetail?.trim();
            return toolError("connector", detail ? `${code}: ${detail}` : code);
          }
          return { result: "ok" as const, connectorResult: response.result };
        } catch (error) {
          return toolError("connector", error);
        }
      }
      if (isBuiltinTool(plan.effectiveToolName)) {
        try {
          const builtinResult = await dispatchBuiltinTool(
            plan.effectiveToolName,
            {
              workflowId: state.workflowId,
              runId: state.runId,
              traceId: state.traceId,
              agentInstanceId: input.agentInstanceId,
              ...(input.projectId ? { projectId: input.projectId } : {}),
              definition: state.agentDefinition,
              ...(state.reasonText ? { reasonText: state.reasonText } : {}),
              inboundPayload: state.inboundMessage.payload as Record<string, unknown>,
              toolCallId: input.toolCallId,
              agentStepId: input.agentStepId,
            },
            {
              ...input.params,
              ticker:
                (input.params.ticker as string | undefined) ??
                (input.params.symbol as string | undefined),
            }
          );
          if (plan.effectiveToolName === "run_analyst_team") {
            return { result: "ok" as const, analystTeamResult: builtinResult };
          }
          if (plan.effectiveToolName === "edit_agent_pack") {
            return { result: "ok" as const, packEdit: builtinResult };
          }
          if (plan.effectiveToolName === "fuse_signals") {
            return { result: "ok" as const, fusionResult: builtinResult };
          }
          return { result: "ok" as const, builtinResult };
        } catch (error) {
          return toolError("builtin", error);
        }
      }
      return {
        result: "error" as const,
        toolError: true,
        errorSource: "unknown" as const,
        errorMessage: `Tool "${plan.effectiveToolName}" is not implemented. Add it to builtin-tools or tool-routes (connector).`,
      };
    },
    meta: { toolName: plan.effectiveToolName },
  });
}

function toolError(source: "mcp" | "connector" | "builtin", error: unknown) {
  return {
    result: "error" as const,
    toolError: true,
    errorSource: source,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}
