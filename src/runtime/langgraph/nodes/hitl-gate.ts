import { parseToolCallFromReason } from "../../tools/tool-call-format";
import { resolveEffectiveAgentTools } from "../../orchestration/resolve-effective-tools";
import {
  createHitlRequest,
  parseHitlApproval,
  resolveChatOrchestratorHitl,
  shouldHitlGateToolCall,
  verifyHitlApproval,
} from "../../workflow/hitl-service";
import { loadWorkflowLoopContext } from "../../workflow/hitl-service";
import type { AgentGraphState, StepStreamEvent } from "../state";

export async function hitlGateNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  agentInstanceId: string
): Promise<Partial<AgentGraphState>> {
  if (state.finalResponse) return {};

  const payload = state.inboundMessage.payload as Record<string, unknown>;
  const payloadParams = (payload["params"] ?? {}) as Record<string, unknown>;
  const hitlApproval = parseHitlApproval(payloadParams["hitlApproval"]);

  if (hitlApproval?.decision === "rejected") {
    return {
      finalResponse: {
        status: "terminated",
        reason: "hitl_rejected",
        iteration: state.iteration,
      },
    };
  }

  if (hitlApproval?.requestId) {
    const verified = await verifyHitlApproval(hitlApproval.requestId, state.workflowId);
    if (verified.approved) return {};
    if (verified.rejected) {
      return {
        finalResponse: {
          status: "terminated",
          reason: "hitl_rejected",
          iteration: state.iteration,
        },
      };
    }
  }

  const effective = await resolveEffectiveAgentTools(state.agentDefinition, state.workflowId);
  const parsed = parseToolCallFromReason(state.reasonText ?? "", effective.tools);
  if (parsed.kind === "none" || parsed.kind === "parse_error") return {};

  const { workflow, loopOptions } = await loadWorkflowLoopContext(state.workflowId);
  if (!resolveChatOrchestratorHitl(workflow, loopOptions, state.agentDefinition.role)) {
    return {};
  }
  if (!shouldHitlGateToolCall(parsed.toolName)) return {};

  const toolLabel = parsed.mcp
    ? `MCP ${parsed.mcp.serverName}/${parsed.mcp.toolName}`
    : parsed.toolName;
  const title = `Orchestrator 请求执行工具：${toolLabel}`;
  const summary = (state.reasonText ?? "").slice(0, 6000);

  const { id: requestId } = await createHitlRequest({
    workflowRunId: state.workflowId,
    runId: state.runId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    stepIndex: state.iteration,
    agentInstanceId,
    scope: "chat_orchestrator",
    requestKind: "tool_call",
    title,
    summary,
    payloadJson: {
      toolName: parsed.toolName,
      toolParams: parsed.params,
      mcp: parsed.mcp ?? null,
      reasonText: state.reasonText,
      iteration: state.iteration,
    },
  });

  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "final",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: {
      status: "awaiting_approval",
      hitlRequestId: requestId,
      title,
      summary: summary.slice(0, 1200),
      iteration: state.iteration,
      role: state.agentDefinition.role,
    },
  });

  return {
    finalResponse: {
      status: "awaiting_approval",
      hitlRequestId: requestId,
      title,
      iteration: state.iteration,
      role: state.agentDefinition.role,
    },
  };
}
