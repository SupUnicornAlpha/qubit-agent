import { describe, expect, test } from "bun:test";
import type { Experience } from "../../../types/entities";
import {
  EPISODIC_SUBKIND_ALLOWLIST,
  isEpisodicRecallAllowed,
  shouldQueryEpisodicPool,
} from "../episodic-recall-policy";
import type { RecallContext } from "../pipes/recall";

function mkExp(partial: Partial<Experience>): Experience {
  return {
    id: partial.id ?? "exp-1",
    kind: partial.kind ?? "episodic",
    subKind: partial.subKind ?? "workflow_trail",
    scope: partial.scope ?? "workflow",
    scopeId: partial.scopeId ?? "wf-1",
    visibility: partial.visibility ?? "project_shared",
    body: partial.body ?? "trail body",
    summary: partial.summary ?? "",
    tags: partial.tags ?? [],
    qualityScore: partial.qualityScore ?? 0.5,
    validFrom: partial.validFrom ?? new Date().toISOString(),
    validTo: partial.validTo ?? null,
    definitionId: partial.definitionId ?? null,
    metadata: partial.metadata ?? {},
    createdAt: partial.createdAt ?? new Date().toISOString(),
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
  } as Experience;
}

const baseCtx: RecallContext = {
  projectId: "p1",
  definitionId: "def-1",
  query: "continue research",
  workflowRunId: "wf-1",
};

describe("episodic-recall-policy", () => {
  test("shouldQueryEpisodicPool — 无 workflowRunId 时不查", () => {
    expect(shouldQueryEpisodicPool({ ...baseCtx, workflowRunId: undefined })).toBe(false);
    expect(shouldQueryEpisodicPool(baseCtx)).toBe(true);
  });

  test("同 workflow 的 workflow_trail 允许", () => {
    const exp = mkExp({ scopeId: "wf-1", subKind: "workflow_trail" });
    expect(isEpisodicRecallAllowed(exp, baseCtx)).toBe(true);
  });

  test("其它 workflow 的 workflow_trail 拒绝", () => {
    const exp = mkExp({ scopeId: "wf-other", subKind: "workflow_trail" });
    expect(isEpisodicRecallAllowed(exp, baseCtx)).toBe(false);
  });

  test("白名单 subKind 跨 workflow 允许", () => {
    EPISODIC_SUBKIND_ALLOWLIST.add("handoff_note");
    try {
      const exp = mkExp({ scopeId: "wf-other", subKind: "handoff_note" });
      expect(isEpisodicRecallAllowed(exp, baseCtx)).toBe(true);
    } finally {
      EPISODIC_SUBKIND_ALLOWLIST.delete("handoff_note");
    }
  });

  test("非 episodic kind 拒绝", () => {
    const exp = mkExp({ kind: "semantic", subKind: "workflow_summary" });
    expect(isEpisodicRecallAllowed(exp, baseCtx)).toBe(false);
  });
});
