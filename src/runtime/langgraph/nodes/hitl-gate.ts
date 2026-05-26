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
import { extractHitlHintFromText } from "../../workflow/hitl-hint-parse";
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
  /**
   * v2：从对话 orchestrator 的 reasonText 尾部抠出 hitlHint（与团队 plan 同协议，
   * 见 `runtime/workflow/hitl-hint-parse.ts`）。LLM 想让用户做选择题 / 自由输入时，
   * 就在 reasonText 末尾追加 `---HITL_HINT_JSON---` + JSON。这里 best-effort 解析，
   * 失败就当作没暗示（evaluator 仍会按 mode + 高危规则做兜底判定）。
   */
  const hitlHint = extractHitlHintFromText(state.reasonText ?? "");
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
  const title = `${titlePrefix}Orchestrator 请求执行工具：${toolLabel}`;
  // 把触发原因拼进 summary 顶部，让用户立刻看到"为什么这次需要审批"。
  const reasonHeader = decision.reason ? `[HITL 原因] ${decision.reason}\n\n` : "";
  const summary = (reasonHeader + (state.reasonText ?? "")).slice(0, 6000);

  /**
   * v2 inputSchema 派生：
   *   - approve_only / 缺省 → `{}`（前端画两按钮）
   *   - single_choice / multi_choice → `{ options: [{label,value,description?}] }`
   *   - free_form → `{ placeholder, maxLength }`
   *
   * inputKind 与 evaluator 决策保持一致；高危路径已被 evaluator 强制改成
   * approve_only，这里不需要再拦截。
   */
  const inputKind = decision.inputKind ?? "approve_only";
  const inputSchema: Record<string, unknown> =
    inputKind === "single_choice" || inputKind === "multi_choice"
      ? { options: decision.options ?? [] }
      : inputKind === "free_form"
        ? {
            placeholder: "请用一句话告诉 Orchestrator 你的侧重点 / 修正",
            maxLength: 500,
          }
        : {};

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
      /**
       * 记录 LLM 当时输出的 hitlHint 原样，便于线上回放 / 调参（user 不直接看到）。
       * resolveHitlRequest 在 approve 时会把用户实际选择写到 response_json，
       * 与此处的 hitlHint 一起构成"AI 期望 vs 人类决定"的对照样本。
       */
      hitlHint: hitlHint ?? null,
    },
    inputKind,
    inputSchema,
  });

  /**
   * P0-C：HITL pause 只设置 finalResponse，让 `executeAgentReact` 的 finally 统一
   * emit final 帧。原 emit 与 graph 跑完后的 finally emit 形成"双 final"，前端会
   * 看到 awaiting_approval 帧出现两次（hitl-gate / hitl_gate-as-final）。
   *
   * graph 的边路由保证 hitl_gate → finalize 几乎瞬时（finalize 节点对已设
   * finalResponse short-circuit），不会引入显著延迟。
   */
  void emit; // intentionally unused after P0-C 收敛

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
