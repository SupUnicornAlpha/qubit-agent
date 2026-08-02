/**
 * Scenario gate decisions for the loop — pure over Snapshot (no sqlite in caller).
 */

import { buildArtifactGapHint } from "../agent-readiness/quality/artifact-checker";
import type { DataGap } from "../tools/data-gap";
import { buildRequiredToolNextActionHint } from "../tools/required-tool-gate";
import { planArtifactRecovery, planContractRecovery } from "./recovery";
import type { ScenarioRuntimeSnapshot } from "./scenario-snapshot";
import type { RecoverySuggestion } from "./types";

export type ScenarioGateDecision =
  | { kind: "allow_finalize" }
  | {
      kind: "push_back";
      code: string;
      message: string;
      recovery: RecoverySuggestion;
      bumpRequiredToolRetry?: boolean;
      bumpArtifactRetry?: boolean;
    }
  | {
      kind: "partial_stop";
      code: string;
      message: string;
      reason: string;
    };

export function decideToolNoneGate(input: {
  snapshot: ScenarioRuntimeSnapshot;
  availableTools: readonly string[];
  goal?: string | null;
  requiredToolRetryCount: number;
  artifactRetryCount: number;
  maxRequiredToolRetries: number;
  maxArtifactRetries: number;
  notAttempted: readonly DataGap[];
  unavailableRequired: readonly DataGap[];
  artifactOk: boolean;
  artifactMissing: Array<{ table: string; rows: number; minRows: number }>;
}): ScenarioGateDecision {
  const { snapshot } = input;

  if (input.unavailableRequired.length > 0 && input.notAttempted.length === 0) {
    const message = `场景所需能力当前不可用：${input.unavailableRequired
      .map((gap) => `${gap.capability}（${gap.kind}）`)
      .join("、")}。系统不会把未配置或无覆盖误报为无数据。`;
    return {
      kind: "partial_stop",
      code: "REQUIRED_TOOL_CAPABILITY_UNAVAILABLE",
      message,
      reason: "required_tool_capability_unavailable",
    };
  }

  if (input.notAttempted.length > 0) {
    if (input.requiredToolRetryCount < input.maxRequiredToolRetries) {
      const recovery = planContractRecovery({
        snapshot,
        availableTools: input.availableTools,
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        notAttempted: input.notAttempted,
      });
      const nextActionHint =
        recovery.hint || buildRequiredToolNextActionHint({ notAttempted: input.notAttempted });
      const message = [
        `场景必备能力尚未调用：${input.notAttempted.map((gap) => gap.capability).join("、")}。`,
        "这属于 not_attempted，不能作为“无数据”结束；禁止只写计划/澄清而不调工具。",
        nextActionHint,
        recovery.nextTool
          ? `草稿参数（须模型确认后自行调用）：${JSON.stringify(recovery.draftParams ?? {})}`
          : null,
        snapshot.a2aGap
          ? `仍有 ${snapshot.openA2aTasks?.length ?? 0} 个未完成 A2A 子任务，勿忽略专家回传。`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        kind: "push_back",
        code: "REQUIRED_TOOL_GATE_NOT_ATTEMPTED",
        message,
        recovery,
        bumpRequiredToolRetry: true,
      };
    }
    const message = `场景必备能力在补救后仍未调用：${input.notAttempted
      .map((gap) => gap.capability)
      .join("、")}。系统仅交付当前已有证据，不能标记为 completed。`;
    return {
      kind: "partial_stop",
      code: "REQUIRED_TOOL_GATE_UNSATISFIED",
      message,
      reason: "required_tool_gate_unsatisfied",
    };
  }

  if (!input.artifactOk) {
    if (input.artifactRetryCount < input.maxArtifactRetries) {
      const recovery = planArtifactRecovery({
        snapshot,
        availableTools: input.availableTools,
      });
      const hint =
        recovery.hint ||
        buildArtifactGapHint({
          ok: false,
          missing: input.artifactMissing,
          scenario: snapshot.scenarioKey ?? "unknown",
        } as never);
      return {
        kind: "push_back",
        code: "ARTIFACT_RECOVERY_HINT",
        message: `产物闸拦截 tool=none；${hint}`,
        recovery,
        bumpArtifactRetry: true,
      };
    }
    const missing = input.artifactMissing
      .map((m) => `${m.table}=${m.rows}/${m.minRows}`)
      .join(", ");
    return {
      kind: "partial_stop",
      code: "ARTIFACT_GATE_UNSATISFIED",
      message: `任务未能完成：必需产物在补救后仍不完整（${missing}）。`,
      reason: "artifact_gate_unsatisfied",
    };
  }

  // Soft underfill nudge: research floor ok, but upgrade minRows still short.
  // Push back a couple of times, then allow finalize (soft gate).
  if (!snapshot.artifactsOk && input.artifactRetryCount < 2) {
    const recovery = planArtifactRecovery({
      snapshot,
      availableTools: input.availableTools,
    });
    if (recovery.nextTool) {
      return {
        kind: "push_back",
        code: "ARTIFACT_UNDERFILL_SOFT",
        message: [
          "研究地板已满足，但升级级产物仍不足；请再补一轮写工具后再结案。",
          recovery.hint,
          recovery.draftParams
            ? `草稿参数：${JSON.stringify(recovery.draftParams)}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
        recovery,
        bumpArtifactRetry: true,
      };
    }
  }

  return { kind: "allow_finalize" };
}
