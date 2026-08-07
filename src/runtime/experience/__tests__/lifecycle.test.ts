import { describe, expect, test } from "bun:test";
import type { Experience } from "../../../types/entities";
import {
  applyLifecycleToScore,
  inferExperienceLifecycle,
} from "../lifecycle";

function exp(partial: Partial<Experience> & Pick<Experience, "id">): Experience {
  return {
    id: partial.id,
    kind: partial.kind ?? "semantic",
    subKind: partial.subKind ?? "note",
    scope: partial.scope ?? "project",
    scopeId: partial.scopeId ?? "p1",
    definitionId: partial.definitionId ?? null,
    visibility: partial.visibility ?? "project_shared",
    contentJson: partial.contentJson ?? { summary: "ok" },
    tagsJson: partial.tagsJson ?? [],
    qualityScore: partial.qualityScore ?? 0.8,
    useCount: 0,
    successCount: 0,
    failCount: 0,
    decayAt: null,
    validFrom: partial.validFrom ?? new Date().toISOString(),
    validTo: partial.validTo ?? null,
    parentId: null,
    sourceRunId: null,
    embeddingRef: null,
    pinned: false,
    metadataJson: partial.metadataJson ?? {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("experience lifecycle", () => {
  test("respects metadata lifecycle", () => {
    expect(
      inferExperienceLifecycle(
        exp({ id: "1", metadataJson: { lifecycle: "superseded" } })
      )
    ).toBe("superseded");
    expect(applyLifecycleToScore(exp({ id: "1", metadataJson: { lifecycle: "archived" } }), 1)).toBeNull();
  });

  test("demotes playbook / 人肉说明书 content", () => {
    const manual = exp({
      id: "2",
      subKind: "playbook",
      contentJson: {
        summary: "oversold 人肉说明书",
        body: "详细操作步骤\n".repeat(20),
      },
    });
    expect(inferExperienceLifecycle(manual)).toBe("delivered_artifact");
    const scored = applyLifecycleToScore(manual, 1);
    expect(scored).not.toBeNull();
    expect(scored!).toBeLessThan(0.2);
  });

  test("keeps active research conclusions", () => {
    const e = exp({
      id: "3",
      subKind: "research_conclusion",
      contentJson: { summary: "半导体超跌候选五只" },
    });
    expect(inferExperienceLifecycle(e)).toBe("active");
    expect(applyLifecycleToScore(e, 0.9)).toBe(0.9);
  });
});
