import {
  evaluateDeliveryVerdict,
  getRuntimeSqlite,
  getWorkflowFactsPort,
  isDeliveryVerdictEnforceEnabled,
  persistDeliveryVerdict,
} from "../policy";
import type { DeliveryVerdict } from "../policy/types";
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

/** Finalize decides terminal response and always records DeliveryVerdict when possible. */
export function finalizeLoopState(
  context: LoopFinalizationContext,
  state: AgentGraphState
): AgentGraphState {
  const availableAnswer = extractFinalizeAnswerText(state);
  const delivery = evaluateWorkflowDelivery(context.workflowId, availableAnswer);

  if (delivery) {
    void persistDeliveryVerdict({ workflowId: context.workflowId, verdict: delivery });
  }

  // Early terminal (unproductive / HITL / reason_error): enrich + align lifecycle to researchOk.
  if (state.finalResponse) {
    const mergedResponse = alignExistingFinalResponse({
      existing: state.finalResponse,
      delivery,
      availableAnswer,
    });
    const merged = { ...state, finalResponse: mergedResponse };
    context.snapshot("finalize", state.iteration, merged);
    return merged;
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
  // Soft gate: lifecycle completes on researchOk. Null delivery ⇒ not researchOk.
  const researchOk = Boolean(delivery?.researchOk);
  const enforce = isDeliveryVerdictEnforceEnabled();
  const contractOk = exceeded ? (enforce ? researchOk : false) : researchOk || !enforce;

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
        ? `执行达到最大轮次，研究交付底线未满足${reasonCodes}。以下为收口前最后一版可用分析：\n\n${availableAnswer}`
        : `工具调用已结束，但研究交付底线未满足${reasonCodes}。请重试本轮任务或提高最大迭代次数。`,
      deliveryVerdict: delivery ?? undefined,
    };
  } else if (exceeded && contractOk) {
    const softNote =
      delivery && !delivery.upgradeOk && delivery.softReasonCodes.length > 0
        ? `（软缺口：${delivery.softReasonCodes.slice(0, 3).join(", ")}）`
        : "";
    finalResponse = {
      status: "completed",
      reason: delivery?.upgradeOk
        ? "max_iterations_delivery_satisfied"
        : "max_iterations_research_ok",
      role: context.def.role,
      iteration: state.iteration,
      observation: state.observations.at(-1) ?? {},
      answerText: availableAnswer
        ? `执行达到最大轮次，研究交付底线已满足${softNote}：\n\n${availableAnswer}`
        : `执行达到最大轮次，研究交付底线已满足${softNote}。`,
      deliveryVerdict: delivery ?? undefined,
    };
  } else if (!contractOk && enforce) {
    finalResponse = {
      status: "partial",
      reason: "delivery_research_unsatisfied",
      iteration: state.iteration,
      answerText: availableAnswer
        ? `研究交付底线未满足（${(delivery?.reasonCodes ?? ["delivery_unavailable"]).slice(0, 4).join(", ")}）。\n\n${availableAnswer}`
        : `研究交付底线未满足（${(delivery?.reasonCodes ?? ["delivery_unavailable"]).slice(0, 4).join(", ")}）。`,
      ...(delivery ? { deliveryVerdict: delivery } : {}),
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
  const merged = { ...state, finalResponse };
  context.snapshot("finalize", state.iteration, merged);
  return merged;
}

function alignExistingFinalResponse(input: {
  existing: NonNullable<AgentGraphState["finalResponse"]>;
  delivery: DeliveryVerdict | null;
  availableAnswer: string;
}): NonNullable<AgentGraphState["finalResponse"]> {
  const { existing, delivery, availableAnswer } = input;
  const enforce = isDeliveryVerdictEnforceEnabled();
  let status = existing.status;
  // Don't override HITL / hard terminates.
  const sticky = new Set(["awaiting_approval", "terminated", "cancelled", "failed"]);
  if (enforce && delivery && !sticky.has(String(status))) {
    if (status === "completed" && !delivery.researchOk) {
      status = "partial";
    } else if (
      (status === "partial" || status === "running") &&
      delivery.researchOk &&
      existing.reason === "unproductive_turn_budget_exhausted"
    ) {
      // Soft: unproductive stop but research floor met → completed.
      status = "completed";
    }
  }
  return {
    ...existing,
    status,
    ...(delivery ? { deliveryVerdict: delivery } : {}),
    ...(availableAnswer && !existing.answerText ? { answerText: availableAnswer } : {}),
  };
}

function evaluateWorkflowDelivery(workflowId: string, answerText: string): DeliveryVerdict | null {
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
    // Persist a minimal verdict so H-DV is never silently skipped on scenario runs.
    return {
      state: "partial",
      reasonCodes: ["delivery_eval_unavailable"],
      softReasonCodes: ["delivery_eval_unavailable"],
      missingArtifacts: [],
      missingCapabilities: [],
      dataGaps: [],
      answer: {
        schemaOk: false,
        missingSections: ["goal", "evidence", "decision", "risks", "gaps"],
      },
      researchOk: false,
      upgradeOk: false,
      evaluatorVersion: "fallback",
      recipeKey: null,
      recipeVersion: null,
    };
  }
}
