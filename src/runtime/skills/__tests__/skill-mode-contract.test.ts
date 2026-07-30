import { describe, expect, test } from "bun:test";
import {
  inferSkillModeTags,
  normalizeSkillRecallMode,
  skillExecutionQuality,
} from "../skill-service";

describe("skill recall mode contract", () => {
  test("maps workflow modes to stable recall tags", () => {
    expect(normalizeSkillRecallMode("research")).toBe("research");
    expect(normalizeSkillRecallMode("backtest")).toBe("simulation");
    expect(normalizeSkillRecallMode("live")).toBe("trading");
    expect(normalizeSkillRecallMode("unknown")).toBeNull();
  });

  test("keeps legacy skill rows compatible while denying trading recipes by inference", () => {
    expect(inferSkillModeTags({ name: "order-intent-buy-checklist" })).toEqual(["trading"]);
    expect(inferSkillModeTags({ name: "quant-factor-review" })).toEqual(["research", "simulation"]);
    expect(inferSkillModeTags({ name: "legacy-note" })).toEqual(["general"]);
  });

  test("uses neutral cold-start scores and penalizes repeatedly unexecuted recalls", () => {
    expect(skillExecutionQuality(0, 0).multiplier).toBe(0.7);
    expect(skillExecutionQuality(4, 0).multiplier).toBe(0.7);
    expect(skillExecutionQuality(5, 0).multiplier).toBe(0.2);
    expect(skillExecutionQuality(20, 10)).toMatchObject({ executedRate: 0.5, multiplier: 0.7 });
  });
});
