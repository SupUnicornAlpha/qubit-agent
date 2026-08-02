import {
  evaluateDeliveryVerdict,
  getRuntimeSqlite,
  getWorkflowFactsPort,
  isDeliveryVerdictEnforceEnabled,
  persistDeliveryVerdict,
} from "../policy";
import { stripToolCallSentinels } from "../tools/tool-call-format";
import type { RuntimeAgentDefinition } from "../types";
import type { AgentGraphState, StepStreamEvent } from "./state";

export type LoopFinalizationContext = {
  runId: string;
  workflowId: string;
  traceId: string;
  def: Pick<RuntimeAgentDefinition, "role" | "maxIterations">;
  forceReactLoop: boolean;
  emit: (event: StepStreamEvent) => void;
  snapshot: (phase: string, stepIndex: number, state: AgentGraphState) => void;
};

/**
 * 从最后一轮 reason / observation 中提取可面向用户展示的文本。
 *
 * ReAct 可能在工具调用完成后刚好耗尽最大迭代。此时历史实现只返回
 * `{ reason: "max_iterations" }`，导致 Orchestrator 明明已经有一版分析正文，
 * 用户侧却只能看到工具轨迹。这里剥离 tool sentinel，并依次回退到最近 observation。
 */
export function extractFinalizeAnswerText(
  state: Pick<AgentGraphState, "reasonText" | "observations">
): string {
  const candidates: unknown[] = [state.reasonText];
  for (const observation of [...state.observations].reverse()) {
    candidates.push(observation.answerText, observation.reasonText, observation.summary);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const cleaned = stripToolCallSentinels(candidate).trim();
    if (cleaned && cleaned !== "no tool requested") return cleaned;
  }
  return "";
}

/** Finalize only decides the terminal response and records the delivery verdict. */
export function finalizeLoopState(
  context: LoopFinalizationContext,
  state: AgentGraphState
): AgentGraphState {
  if (state.finalResponse) {
    context.snapshot("finalize", state.iteration, state);
    return state;
  }
  const exceeded = context.forceReactLoop && state.iteration >= context.def.maxIterations;
  if (exceeded) {
    context.emit({
      runId: context.runId,
      workflowId: context.workflowId,
      traceId: context.traceId,
      role: context.def.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: {
        code: "MAX_ITERATIONS",
        alertType: "iteration_exceeded",
        message: "react loop terminated by max iterations",
      },
    });
  }
  const availableAnswer = extractFinalizeAnswerText(state);
  const delivery = evaluateWorkflowDelivery(context.workflowId, availableAnswer);
  const delivered = delivery?.state === "delivered" || delivery?.state === "delivered_with_gaps";
  const enforce = isDeliveryVerdictEnforceEnabled();
  // Never salvage to completed on row-count/attempted alone. Only DeliveryVerdict
  // "delivered*" counts when enforce is on; otherwise fall back to partial.
  const contractOk = exceeded ? (enforce ? Boolean(delivered) : false) : false;

  let finalResponse: AgentGraphState["finalResponse"];
  if (exceeded && !contractOk) {
    const reasonCodes = delivery?.reasonCodes?.length
      ? `（${delivery.reasonCodes.slice(0, 4).join(", ")}）`
      : "";
    finalResponse = {
      status: "partial",
      reason: delivery ? "max_iterations_delivery_unsatisfied" : "max_iterations",
      iteration: state.iteration,
      answerText: availableAnswer
        ? `执行达到最大轮次，交付谓词未满足${reasonCodes}。以下为收口前最后一版可用分析：\n\n${availableAnswer}`
        : `工具调用已结束，但交付谓词未满足${reasonCodes}。请重试本轮任务或提高最大迭代次数。`,
      deliveryVerdict: delivery ?? undefined,
    };
  } else if (exceeded && contractOk) {
    finalResponse = {
      status: "completed",
      reason: "max_iterations_delivery_satisfied",
      role: context.def.role,
      iteration: state.iteration,
      observation: state.observations.at(-1) ?? {},
      answerText: availableAnswer
        ? `执行达到最大轮次，但 DeliveryVerdict 已满足，按已有证据完成交付：\n\n${availableAnswer}`
        : "执行达到最大轮次，但 DeliveryVerdict 已满足。",
      deliveryVerdict: delivery ?? undefined,
    };
  } else {
    finalResponse = {
      status: "completed",
      role: context.def.role,
      iteration: state.iteration,
      observation: state.observations.at(-1) ?? {},
      ...(availableAnswer ? { answerText: availableAnswer } : {}),
      ...(delivery ? { deliveryVerdict: delivery } : {}),
    };
  }
  if (delivery) {
    void persistDeliveryVerdict({ workflowId: context.workflowId, verdict: delivery });
  }
  const merged = { ...state, finalResponse };
  context.snapshot("finalize", state.iteration, merged);
  return merged;
}

function evaluateWorkflowDelivery(workflowId: string, answerText: string) {
  try {
    const port = getWorkflowFactsPort();
    const snapshot = port.loadSnapshot(workflowId, { includeA2a: true });
    if (!snapshot.scenarioKey) return null;
    return evaluateDeliveryVerdict({
      sqlite: getRuntimeSqlite(),
      snapshot,
      answerText,
      enforceBenchmarkTerms: false,
    });
  } catch {
    return null;
  }
}
