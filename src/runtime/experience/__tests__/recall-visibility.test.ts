import { describe, expect, test } from "bun:test";
import type { Experience } from "../../../types/entities";
import {
  experienceRoleTags,
  filterSharedPool,
  isExperienceVisibleToCaller,
  sharedVisibilitiesForScopeTarget,
} from "../recall-visibility";

function exp(partial: Partial<Experience> & Pick<Experience, "visibility">): Experience {
  return {
    id: "e1",
    kind: "semantic",
    subKind: "test",
    scope: "project",
    scopeId: "p1",
    definitionId: null,
    contentJson: { summary: "s" },
    tagsJson: [],
    qualityScore: 0.5,
    useCount: 0,
    successCount: 0,
    failCount: 0,
    decayAt: null,
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    parentId: null,
    sourceRunId: null,
    embeddingRef: null,
    pinned: false,
    metadataJson: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("recall-visibility", () => {
  test("workspace_shared only visible on workspace scope target", () => {
    const row = exp({ visibility: "workspace_shared", scope: "workspace", scopeId: "ws-1" });
    expect(
      isExperienceVisibleToCaller(row, {
        definitionId: null,
        scopeTarget: { scope: "workspace", scopeId: "ws-1" },
      })
    ).toBe(true);
    expect(
      isExperienceVisibleToCaller(row, {
        definitionId: null,
        scopeTarget: { scope: "project", scopeId: "p1" },
      })
    ).toBe(false);
  });

  test("role_shared matches role tag or metadata.role", () => {
    const row = exp({
      visibility: "role_shared",
      tagsJson: ["role:research"],
    });
    expect(
      isExperienceVisibleToCaller(row, {
        definitionId: null,
        role: "research",
        scopeTarget: { scope: "project", scopeId: "p1" },
      })
    ).toBe(true);
    expect(
      isExperienceVisibleToCaller(row, {
        definitionId: null,
        role: "risk",
        scopeTarget: { scope: "project", scopeId: "p1" },
      })
    ).toBe(false);
    expect(experienceRoleTags(exp({ tagsJson: [], metadataJson: { role: "Orchestrator" } }))).toContain(
      "orchestrator"
    );
  });

  test("sharedVisibilitiesForScopeTarget includes workspace_shared on workspace", () => {
    expect(sharedVisibilitiesForScopeTarget({ scope: "workspace", scopeId: "ws" })).toContain(
      "workspace_shared"
    );
    expect(sharedVisibilitiesForScopeTarget({ scope: "project", scopeId: "p" })).not.toContain(
      "workspace_shared"
    );
  });

  test("filterSharedPool drops cross-role role_shared", () => {
    const rows = [
      exp({ id: "a", visibility: "project_shared" }),
      exp({ id: "b", visibility: "role_shared", tagsJson: ["role:research"] }),
      exp({ id: "c", visibility: "role_shared", tagsJson: ["role:risk"] }),
    ];
    const out = filterSharedPool(rows, {
      definitionId: null,
      role: "research",
      scopeTarget: { scope: "project", scopeId: "p1" },
    });
    expect(out.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });
});
