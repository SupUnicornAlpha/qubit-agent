import { describe, expect, test } from "bun:test";
import {
  buildKnowledgeIntentGuard,
  classifyGoalIntent,
  detectGoalTopicShift,
  shouldSuppressExecutionSkill,
  shouldSuppressWorkflowPlayRecall,
} from "../goal-scope";

describe("goal-scope", () => {
  test("classifies knowledge vs execution intents", () => {
    expect(
      classifyGoalIntent("查查理芒格、巴菲特以及各种中国牛散是怎么选股的，沉淀选股skills")
    ).toBe("knowledge");
    expect(classifyGoalIntent("设计半导体 long/short 配对策略并回测")).toBe("execution");
    expect(classifyGoalIntent("对策略回测")).toBe("execution");
  });

  test("detects shift from strategy design to stock-picking methodology", () => {
    const shift = detectGoalTopicShift(
      "设计半导体行业内的 long/short 配对策略，明确配对逻辑、净敞口、单边上限、借券与回测假设。",
      "你帮我查下查理芒格、巴菲特以及各种中国牛散是怎么选股的，给我沉淀下来相关的选股skills"
    );
    expect(shift.shifted).toBe(true);
    expect(shift.reason).toBe("intent_execution_to_knowledge");
  });

  test("does not shift when user continues backtest on same execution thread", () => {
    const shift = detectGoalTopicShift(
      "你给我做一些因子和策略出来，在我自选上，落地低频和中频",
      "对策略回测"
    );
    expect(shift.shifted).toBe(false);
  });

  test("does not shift on bare continuation cues like 继续", () => {
    const shift = detectGoalTopicShift(
      "研究团队 · 查寻一下巴菲特和查理芒格的思想，归纳一下他们的选股思路，并且固化成我们的选股skills",
      "继续"
    );
    expect(shift.shifted).toBe(false);
  });

  test("suppresses workflow_play recall for knowledge goals", () => {
    expect(
      shouldSuppressWorkflowPlayRecall({
        query: "巴菲特选股方法是什么",
        hitTitle: "auto-play(orchestrator)",
        hitSummary: "workspace.context.snapshot → factor.register → strategy.compose → backtest.run",
        hitSubKind: "workflow_play",
      })
    ).toBe(true);
  });

  test("suppresses quant fastpath skills for knowledge goals", () => {
    expect(
      shouldSuppressExecutionSkill("quant:factor-compose-backtest-fastpath", "量化策略有哪些类型")
    ).toBe(true);
    expect(
      shouldSuppressExecutionSkill("quant:factor-compose-backtest-fastpath", "在我自选上落地低频策略")
    ).toBe(false);
  });

  test("builds knowledge intent guard", () => {
    const guard = buildKnowledgeIntentGuard("一般量化之中会有哪些类型的策略");
    expect(guard).toContain("INTENT_GUARD");
    expect(guard).toContain("Do NOT register factors");
  });
});
