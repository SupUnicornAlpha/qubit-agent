import { resolveEffectiveAgentTools } from "../../orchestration/resolve-effective-tools";
import { parseToolCallFromReason } from "../../tools/tool-call-format";
import { extractHitlHintFromText } from "../../workflow/hitl-hint-parse";
import {
  buildHitlInputSchemaFromHint,
  createHitlRequest,
  evaluateChatHitlTrigger,
  getHitlRequest,
  loadWorkflowLoopContext,
  parseHitlApproval,
  shouldHitlGateToolCall,
  verifyHitlApproval,
  verifyHitlApprovalForTool,
} from "../../workflow/hitl-service";
import type { AgentGraphState, StepStreamEvent } from "../state";

async function consumeApprovedUserQuestion(input: {
  state: AgentGraphState;
  requestId: string;
  consumedApprovalIds: string[];
}): Promise<Partial<AgentGraphState> | null> {
  const row = await getHitlRequest(input.requestId);
  if (!row || row.workflowRunId !== input.state.workflowId) return null;
  if (row.requestKind !== "user_question" || row.status !== "approved") return null;
  return {
    contextMemory: {
      ...input.state.contextMemory,
      consumedHitlApprovalRequestIds: [...input.consumedApprovalIds, input.requestId],
    },
  };
}

export async function hitlGateNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  agentInstanceId: string
): Promise<Partial<AgentGraphState>> {
  if (state.finalResponse) return {};

  const payload = state.inboundMessage.payload as Record<string, unknown>;
  const payloadParams = (payload.params ?? {}) as Record<string, unknown>;
  const hitlApproval = parseHitlApproval(payloadParams.hitlApproval);

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

  const consumedApprovalIds = Array.isArray(state.contextMemory.consumedHitlApprovalRequestIds)
    ? (state.contextMemory.consumedHitlApprovalRequestIds as string[])
    : [];

  // user_question 审批只绑定「下一轮 reason」，不绑定具体 tool —— 先消费再放行。
  if (hitlApproval?.requestId && !consumedApprovalIds.includes(hitlApproval.requestId)) {
    const consumed = await consumeApprovedUserQuestion({
      state,
      requestId: hitlApproval.requestId,
      consumedApprovalIds,
    });
    if (consumed) return consumed;
  }

  const hitlHint = extractHitlHintFromText(state.reasonText ?? "");
  const { workflow, loopOptions } = await loadWorkflowLoopContext(state.workflowId);

  /**
   * 独立提问断点：LLM 未发起工具、但显式 needed=true → 创建 user_question HITL。
   * 常见：让用户选路径 / 填成本股数后再继续。
   */
  const effective = await resolveEffectiveAgentTools(state.agentDefinition, state.workflowId);
  const parsed = parseToolCallFromReason(state.reasonText ?? "", effective.tools);
  const modeAllowsAsk =
    loopOptions.hitlChatMode !== "off" && state.agentDefinition.role === "orchestrator";
  if (
    modeAllowsAsk &&
    hitlHint?.needed === true &&
    (parsed.kind === "none" || parsed.kind === "parse_error")
  ) {
    const inputKind = hitlHint.inputKind ?? (hitlHint.fields?.length ? "form" : "free_form");
    const question =
      hitlHint.question?.trim() || hitlHint.reason?.trim() || "Orchestrator 需要你的输入后才能继续";
    const title = `[提问] ${question.slice(0, 80)}`;
    const summary = (state.reasonText ?? question).slice(0, 6000);
    const { id: requestId } = await createHitlRequest({
      workflowRunId: state.workflowId,
      runId: state.runId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      stepIndex: state.iteration,
      agentInstanceId,
      scope: "chat_orchestrator",
      requestKind: "user_question",
      title,
      summary,
      payloadJson: {
        question,
        reasonText: state.reasonText,
        iteration: state.iteration,
        triggerSource: "ai_hint",
        triggerReason: hitlHint.reason ?? question,
        hitlHint,
      },
      inputKind,
      inputSchema: buildHitlInputSchemaFromHint(hitlHint),
    });
    void emit;
    return {
      finalResponse: {
        status: "awaiting_approval",
        hitlRequestId: requestId,
        title,
        summary: summary.slice(0, 1200),
        iteration: state.iteration,
        role: state.agentDefinition.role,
      },
    };
  }

  if (parsed.kind === "none" || parsed.kind === "parse_error") return {};

  // run_analyst_team 走团队编排内部 HITL（pauseForTeamOrchestratorHitl），这里要让路。
  if (!shouldHitlGateToolCall(parsed.toolName)) return {};

  if (hitlApproval?.requestId && !consumedApprovalIds.includes(hitlApproval.requestId)) {
    const verifiedTool = await verifyHitlApprovalForTool({
      requestId: hitlApproval.requestId,
      workflowRunId: state.workflowId,
      toolName: parsed.toolName,
      toolParams: parsed.params,
    });
    if (verifiedTool.rejected) {
      return {
        finalResponse: {
          status: "terminated",
          reason: "hitl_rejected",
          iteration: state.iteration,
        },
      };
    }
    if (verifiedTool.approved && verifiedTool.matches) {
      return {
        contextMemory: {
          ...state.contextMemory,
          consumedHitlApprovalRequestIds: [...consumedApprovalIds, hitlApproval.requestId],
        },
      };
    }
  }

  const decision = evaluateChatHitlTrigger({
    workflow,
    loopOptions,
    role: state.agentDefinition.role,
    toolName: parsed.toolName,
    hitlHint,
  });
  if (!decision.trigger) return {};

  const toolLabel = parsed.mcp
    ? `MCP ${parsed.mcp.serverName}/${parsed.mcp.toolName}`
    : parsed.toolName;
  const titlePrefix =
    decision.source === "rule_high_risk"
      ? "[高危操作] "
      : decision.source === "ai_hint"
        ? "[AI 建议确认] "
        : "";
  const question =
    hitlHint?.question?.trim() ||
    hitlHint?.reason?.trim() ||
    decision.reason ||
    `确认执行 ${toolLabel}`;
  const title = `${titlePrefix}${
    decision.source === "ai_hint" && hitlHint?.question
      ? question.slice(0, 80)
      : `Orchestrator 请求执行工具：${toolLabel}`
  }`;
  const reasonHeader = decision.reason ? `[HITL 原因] ${decision.reason}\n\n` : "";
  const summary = (reasonHeader + (state.reasonText ?? "")).slice(0, 6000);

  const inputKind = decision.inputKind ?? "approve_only";
  const inputSchema = {
    ...buildHitlInputSchemaFromHint(hitlHint),
    ...(inputKind === "single_choice" || inputKind === "multi_choice"
      ? { options: decision.options ?? hitlHint?.options ?? [] }
      : {}),
    ...(inputKind === "free_form" && !hitlHint?.placeholder
      ? {
          placeholder: "请用一句话告诉 Orchestrator 你的侧重点 / 修正",
          maxLength: 500,
        }
      : {}),
  };

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
      question,
      reasonText: state.reasonText,
      iteration: state.iteration,
      triggerSource: decision.source,
      triggerReason: decision.reason,
      hitlHint: hitlHint ?? null,
    },
    inputKind,
    inputSchema,
  });

  void emit;

  return {
    finalResponse: {
      status: "awaiting_approval",
      hitlRequestId: requestId,
      title,
      summary: summary.slice(0, 1200),
      iteration: state.iteration,
      role: state.agentDefinition.role,
    },
  };
}
