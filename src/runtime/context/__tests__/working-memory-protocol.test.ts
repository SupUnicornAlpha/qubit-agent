import { describe, expect, test } from "bun:test";
import { toProtocolWorkingMemory } from "../../context/working-memory-protocol";
import type { WorkingMemory } from "../../context/types";

describe("toProtocolWorkingMemory", () => {
  test("camelCase → snake_case wire", () => {
    const wm: WorkingMemory = {
      version: 1,
      hypotheses: [
        {
          id: "h1",
          text: "momentum works",
          stance: "bull",
          symbols: ["AAPL"],
          evidenceRefs: ["ev-1"],
          confidence: 0.7,
          status: "open",
        },
      ],
      openQuestions: ["IR stable?"],
      decisions: ["use rank ic"],
      debate: { bullPoints: ["trend"], bearPoints: ["crowding"], resolution: "watch" },
      financeRefs: { factorIds: ["f1"], symbols: ["AAPL"] },
      trailStub: [{ step: 1, tool: "factor.list", ok: true, oneLiner: "listed" }],
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const wire = toProtocolWorkingMemory(wm);
    expect(wire.open_questions).toEqual(["IR stable?"]);
    expect(wire.finance_refs.factor_ids).toEqual(["f1"]);
    expect(wire.hypotheses[0]?.evidence_refs).toEqual(["ev-1"]);
    expect(wire.trail_stub[0]?.one_liner).toBe("listed");
    expect(wire.debate?.bull_points).toEqual(["trend"]);
    expect(wire.updated_at).toBe("2026-01-01T00:00:00Z");
  });
});
