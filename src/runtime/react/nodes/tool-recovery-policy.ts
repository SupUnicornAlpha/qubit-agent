import { getToolCatalogMap } from "../../tools/tool-catalog";
import { resolveConnectorForTool } from "../../tools/tool-routes";
import {
  inferMarketScope,
  isToolNegativelyCached,
} from "../../tools/tool-governance-policy";
import type { ToolErrorClass } from "./tool-error-classifier";

export interface ToolRecoveryPlan {
  failedAttempts: number;
  allowSameToolRetry: boolean;
  alternatives: string[];
  nextAction: "retry_once" | "switch_tool" | "continue_with_limits";
  guidance: string;
}

/**
 * Turn a low-level tool failure into an executable recovery plan for the next
 * reason round. The policy is deliberately bounded: one retry for transport
 * failures, then switch source; data-empty and permanent failures switch
 * immediately. If no equivalent authorised tool exists, the agent must keep
 * working with explicit evidence gaps instead of inventing data or spinning.
 */
export function buildToolRecoveryPlan(input: {
  failedTool: string;
  availableTools: string[];
  priorToolCalls: Array<Record<string, unknown>>;
  errorClass: ToolErrorClass;
  semanticFailure: boolean;
  workflowId?: string;
  params?: Record<string, unknown>;
}): ToolRecoveryPlan {
  const failedName = input.failedTool.split("/").at(-1) ?? input.failedTool;
  const failedAttempts =
    input.priorToolCalls.filter(
      (call) =>
        call.status === "failed" &&
        (call.toolName === input.failedTool || call.toolName === failedName)
    ).length + 1;
  const allowSameToolRetry =
    input.errorClass === "transient" && !input.semanticFailure && failedAttempts === 1;
  const alternatives = findAlternatives(
    failedName,
    input.availableTools,
    input.workflowId,
    input.params
  );
  const nextAction = allowSameToolRetry
    ? "retry_once"
    : alternatives.length > 0
      ? "switch_tool"
      : "continue_with_limits";

  const alternativeText = alternatives.length
    ? `可改用本轮已授权的同类工具：${alternatives.join("、")}。`
    : "本轮没有识别到已授权的同类替代工具。";
  const actionText =
    nextAction === "retry_once"
      ? "这是首次瞬时故障：允许原调用最多重试一次；再次失败必须切换数据源。"
      : nextAction === "switch_tool"
        ? "不要原样重试；请选择一个替代工具，并根据其参数契约重新组装调用。"
        : "不要继续空转：基于已有观测完成可完成的部分，明确缺失数据、假设、置信度和取得该数据后的验证步骤；若核心结论依赖缺失事实，只给条件式结论。";

  return {
    failedAttempts,
    allowSameToolRetry,
    alternatives,
    nextAction,
    guidance: `${actionText}${alternativeText}`,
  };
}

function findAlternatives(
  failedTool: string,
  availableTools: string[],
  workflowId?: string,
  params: Record<string, unknown> = {}
): string[] {
  const catalog = getToolCatalogMap();
  const failed = catalog.get(failedTool);
  if (!failed?.category) return [];
  return availableTools
    .filter(
      (name) => {
        const connector = resolveConnectorForTool(name);
        const targetName = connector ? `${connector}/${name}` : name;
        return (
          name !== failedTool &&
          (!workflowId ||
            !isToolNegativelyCached(workflowId, targetName, inferMarketScope(params)))
        );
      }
    )
    .map((name) => catalog.get(name))
    .filter(
      (entry): entry is NonNullable<typeof entry> =>
        Boolean(entry) &&
        entry.category === failed.category &&
        entry.lifecycle !== "stub" &&
        entry.lifecycle !== "deprecated"
    )
    .sort((a, b) => similarityScore(b.name, failedTool) - similarityScore(a.name, failedTool))
    .slice(0, 5)
    .map((entry) => entry.name);
}

function similarityScore(candidate: string, failed: string): number {
  const tokens = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .split(/[._:/-]+/)
        .filter((part) => part.length > 2)
    );
  const failedTokens = tokens(failed);
  return [...tokens(candidate)].filter((token) => failedTokens.has(token)).length;
}
