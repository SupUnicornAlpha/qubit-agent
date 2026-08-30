/**
 * Scenario-focused prompt block for Orchestrator / specialists.
 * Host-side policy text — not part of an Agent loop implementation.
 */

import { resolveScenarioRecipe } from "../policy";
import { resolveRegistryScenarioKey } from "./scenario-key-aliases";

/** Recipe is the single source of scenario prompt constraints. */
export function buildFocusedResearchScenarioPrompt(scenarioKey: string | null): string {
  if (!scenarioKey) return "";
  const recipe =
    resolveScenarioRecipe(scenarioKey) ??
    resolveScenarioRecipe(resolveRegistryScenarioKey(scenarioKey) ?? "");
  if (!recipe) return "";
  const checklist = recipe.checklistPrompt ?? [];
  const opsHint =
    recipe.key === "factor"
      ? "- 因子表达式默认 lang=qlib_expr；使用 Ref/Mean/Std 等，勿写未声明的 Python 名（shift/pd/np）。"
      : null;
  return [
    `## 专业研究场景硬约束：${scenarioKey} @${recipe.version}`,
    "本任务由 Orchestrator 统一裁决，但不得自动扩成通用研究团队或固定多 Agent 流程。",
    "答案须包含五段：goal / evidence / decision / risks / gaps。",
    "禁止把行情探活失败写成唯一结案；系统不会代执行业务写工具，须你自行调用。",
    ...checklist.map((rule) => `- ${rule}`),
    opsHint,
    "- 工具返回空数组、barCount=0、no_bars、no_data 或仅 transport success 时，视为数据失败，不得显示为研究证据。",
    "- 最终答复只包含场景合同要求的结构化结果、关键证据和阻塞项，不生成额外长报告。",
  ]
    .filter(Boolean)
    .join("\n");
}
