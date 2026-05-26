import { parseToolCallFromReason } from "../../tools/tool-call-format";
import { resolveEffectiveAgentTools } from "../../orchestration/resolve-effective-tools";
import {
  createHitlRequest,
  evaluateChatHitlTrigger,
  parseHitlApproval,
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

  // run_analyst_team 走团队编排内部 HITL（pauseForTeamOrchestratorHitl），这里要让路。
  if (!shouldHitlGateToolCall(parsed.toolName)) return {};

  const { workflow, loopOptions } = await loadWorkflowLoopContext(state.workflowId);
  const decision = evaluateChatHitlTrigger({
    workflow,
    loopOptions,
    role: state.agentDefinition.role,
    toolName: parsed.toolName,
  });
  if (!decision.trigger) return {};

  const toolLabel = parsed.mcp
    ? `MCP ${parsed.mcp.serverName}/${parsed.mcp.toolName}`
    : parsed.toolName;
  const titlePrefix = decision.source === "rule_high_risk" ? "[高危操作] " : "";
  const title = `${titlePrefix}Orchestrator 请求执行工具：${toolLabel}`;
  // 把触发原因拼进 summary 顶部，让用户立刻看到"为什么这次需要审批"。
  const reasonHeader = decision.reason ? `[HITL 原因] ${decision.reason}\n\n` : "";
  const summary = (reasonHeader + (state.reasonText ?? "")).slice(0, 6000);

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
      triggerSource: decision.source,
      triggerReason: decision.reason,
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
