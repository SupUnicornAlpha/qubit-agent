import { describe, expect, test } from "bun:test";
import type { OrchestratorPlan } from "./PlanCard";
import {
  latestPlanFromSegments,
  planStructureKey,
  upsertPlanSegment,
} from "./planSegments";

const base = (): OrchestratorPlan => ({
  mode: "plan",
  goal: { text: "研究 NVDA" },
  steps: [
    { id: "1", title: "拉行情", status: "pending" },
    { id: "2", title: "写 thesis", status: "pending" },
  ],
  updatedAt: "2026-08-07T01:00:00.000Z",
});

describe("planSegments", () => {
  test("structure key ignores status", () => {
    const a = base();
    const b = {
      ...base(),
      steps: [
        { id: "1", title: "拉行情", status: "done" as const },
        { id: "2", title: "写 thesis", status: "in_progress" as const },
      ],
    };
    expect(planStructureKey(a)).toBe(planStructureKey(b));
  });

  test("progress update mutates current segment", () => {
    let segs = upsertPlanSegment([], base(), "2026-08-07T01:00:00.000Z");
    expect(segs).toHaveLength(1);
    segs = upsertPlanSegment(
      segs,
      {
        ...base(),
        steps: [
          { id: "1", title: "拉行情", status: "done" },
          { id: "2", title: "写 thesis", status: "in_progress" },
        ],
      },
      "2026-08-07T01:05:00.000Z"
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]!.startedAt).toBe("2026-08-07T01:00:00.000Z");
    expect(segs[0]!.plan.steps[0]!.status).toBe("done");
    expect(latestPlanFromSegments(segs)?.steps[1]?.status).toBe("in_progress");
  });

  test("new goal/steps opens another segment", () => {
    let segs = upsertPlanSegment([], base(), "2026-08-07T01:00:00.000Z");
    segs = upsertPlanSegment(
      segs,
      {
        mode: "goal",
        goal: { text: "换标的看 AAPL" },
        steps: [
          { id: "a", title: "扫新闻", status: "pending" },
          { id: "b", title: "下单模拟", status: "pending" },
        ],
      },
      "2026-08-07T02:00:00.000Z"
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]!.plan.goal?.text).toBe("研究 NVDA");
    expect(segs[1]!.plan.goal?.text).toBe("换标的看 AAPL");
    expect(segs[1]!.startedAt).toBe("2026-08-07T02:00:00.000Z");
  });
});
