import type { ScenarioRecipe } from "../types";

export const factorRecipe: ScenarioRecipe = {
  key: "factor",
  aliases: ["factor_research", "f"],
  version: "2026-08-03.1",
  capabilityOwners: {
    factor: "factor",
  },
  roleToolAllowlist: {
    orchestrator: ["update_plan", "topology.dispatch"],
    factor: ["factor.register", "factor.compute", "factor.evaluate", "factor.autoEvaluate", "factor.list"],
  },
  stallBudget: {
    tools: ["market.readiness", "market.resolve_symbol", "factor.list", "update_plan"],
    key: "tool",
    maxSuccess: 1,
    onExceed: "strip_from_surface",
  },
  recovery: {
    afterProbeFailure: "continue_without_realtime",
    forbidGapAsFinalAnswer: true,
  },
  completion: {
    artifacts: [
      {
        table: "factor_definition",
        minRows: 1,
        researchMinRows: 1,
        requiredFields: ["name", "expression"],
        scope: "workflow",
      },
      {
        table: "factor_evaluation",
        minRows: 1,
        /** Research may complete after register; evaluate is upgrade-grade. */
        researchMinRows: 0,
        scope: "workflow",
      },
    ],
    requiredTools: [{ capability: "factor", minSuccess: 1 }],
    answerSchema: {
      requiredSections: ["goal", "evidence", "decision", "risks", "gaps"],
    },
  },
  checklistPrompt: [
    "1. factor.register（qlib_expr：close / Ref(close, 21) - 1；勿用 Ref(close,252) 超长窗；勿用未声明 Python 名）",
    "2. factor.compute → factor.evaluate 或 factor.autoEvaluate 闭环",
    "3. 输出五段答案；禁止仅 list 旧因子结案",
  ],
};
