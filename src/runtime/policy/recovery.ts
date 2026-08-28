/**
 * RecoveryPlanner — default hint-only. Never silently writes business tables.
 */

import {
  resolveArtifactAutoAdvance,
  resolveContractAutoAdvance,
} from "../tools/contract-auto-advance";
import type { DataGap } from "../tools/data-gap";
import { canDispatchBusinessAutoAdvance, getContractAutoAdvanceMode } from "./flags";
import type { ScenarioRuntimeSnapshot } from "./scenario-snapshot";
import { BUSINESS_WRITE_TOOLS, type RecoverySuggestion } from "./types";

export function planContractRecovery(input: {
  snapshot: ScenarioRuntimeSnapshot;
  availableTools: readonly string[];
  goal?: string | null;
  notAttempted: readonly DataGap[];
}): RecoverySuggestion {
  const draft = resolveContractAutoAdvance({
    snapshot: input.snapshot,
    notAttempted: input.notAttempted,
    availableTools: input.availableTools,
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
  });
  return toSuggestion(draft, input.snapshot);
}

export function planArtifactRecovery(input: {
  snapshot: ScenarioRuntimeSnapshot;
  availableTools: readonly string[];
}): RecoverySuggestion {
  const draft = resolveArtifactAutoAdvance({
    snapshot: input.snapshot,
    availableTools: input.availableTools,
  });
  return toSuggestion(draft, input.snapshot);
}

function toSuggestion(
  draft: { toolName: string; params: Record<string, unknown> } | null,
  snapshot: ScenarioRuntimeSnapshot
): RecoverySuggestion {
  if (!draft) {
    return {
      mode: "hint_only",
      nextTool: null,
      missingParams: [],
      hint:
        snapshot.notAttemptedCapabilities.length > 0
          ? `合同能力尚未完成：${snapshot.notAttemptedCapabilities.join("、")}。请调用对应写工具，禁止探活空转。`
          : snapshot.missingArtifactTables.length > 0
            ? `产物仍缺：${snapshot.missingArtifactTables.join("、")}。请调用对应生产工具。`
            : "请继续完成场景合同工具调用。",
    };
  }

  const missingParams = inferMissingParams(draft.toolName, draft.params);
  const isBusiness = BUSINESS_WRITE_TOOLS.has(draft.toolName);
  const mayDispatch =
    getContractAutoAdvanceMode() === "dispatch" &&
    canDispatchBusinessAutoAdvance(draft.toolName) &&
    !isBusiness; // business writes stay hint-only even if mode=dispatch unless allowlisted later

  // Plan invariant: business write tools are never system-dispatched by default.
  void mayDispatch;

  const hintLines = [
    `下一动作必须是 \`${draft.toolName}\`（系统仅提供草稿参数，须由模型/专家确认后执行）。`,
    missingParams.length > 0 ? `仍需明确参数：${missingParams.join("、")}。` : null,
    snapshot.recipe?.recovery.forbidGapAsFinalAnswer
      ? "禁止把行情/探活失败写成唯一结案正文。"
      : null,
  ].filter(Boolean);

  return {
    mode: "hint_only",
    nextTool: draft.toolName,
    missingParams,
    hint: hintLines.join("\n"),
    draftParams: draft.params,
  };
}

function inferMissingParams(toolName: string, params: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (toolName === "order.create_intent") {
    if (!params.strategy_version_id) missing.push("strategy_version_id");
    if (!params.symbol) missing.push("symbol");
    if (params.qty == null) missing.push("qty");
  }
  if (toolName === "factor.register") {
    if (!params.expression) missing.push("expression");
    if (!params.name) missing.push("name");
  }
  if (toolName === "strategy.compose") {
    if (!params.strategy_version_id) missing.push("strategy_version_id");
    if (!Array.isArray(params.factor_ids) || params.factor_ids.length === 0) {
      missing.push("factor_ids");
    }
  }
  if (toolName === "backtest.run") {
    if (!params.strategy_version_id) missing.push("strategy_version_id");
    if (!Array.isArray(params.symbols) || params.symbols.length === 0) missing.push("symbols");
    if (!params.dataset_snapshot_id && !params.datasetSnapshotId && !params.snapshot_id) {
      missing.push("dataset_snapshot_id（先 market.snapshot.get）");
    }
  }
  if (toolName === "recommendation.record") {
    if (!params.symbol) missing.push("symbol");
    if (!params.rationale) missing.push("rationale");
  }
  return missing;
}
