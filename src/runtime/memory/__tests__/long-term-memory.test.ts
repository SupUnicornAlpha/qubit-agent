import { describe, expect, test } from "bun:test";
import type { Experience } from "../../../types/entities";
import {
  isFsWorkspaceId,
  resolveFsWorkspaceIdFromEnv,
  resolveFsWorkspaceIdFromLoopOptions,
  resolveFsWorkspaceIdFromParams,
} from "../fs-workspace-id";
import { projectedFsEntryId, shouldProjectExperienceToFs } from "../project-experience-to-fs";

function makeExp(
  partial: Partial<Experience> & Pick<Experience, "kind" | "contentJson">
): Experience {
  return {
    id: partial.id ?? "e1",
    kind: partial.kind,
    subKind: partial.subKind ?? "iteration_summary",
    scope: partial.scope ?? "workspace",
    scopeId: partial.scopeId ?? "ws-1",
    definitionId: null,
    visibility: "project_shared",
    contentJson: partial.contentJson,
    tagsJson: [],
    qualityScore: partial.qualityScore ?? 0.6,
    useCount: 0,
    successCount: 0,
    failCount: 0,
    decayAt: null,
    validFrom: "2026-08-08T00:00:00Z",
    validTo: partial.validTo ?? null,
    parentId: null,
    sourceRunId: null,
    embeddingRef: null,
    pinned: false,
    metadataJson: {},
    createdAt: "2026-08-08T00:00:00Z",
    updatedAt: "2026-08-08T00:00:00Z",
  };
}

describe("fs-workspace-id", () => {
  test("rejects Core wf_ session ids", () => {
    expect(isFsWorkspaceId("wf_abc")).toBe(false);
    expect(resolveFsWorkspaceIdFromParams({ workspace_id: "wf_run-1" })).toBeNull();
  });

  test("resolves camel/snake params", () => {
    expect(resolveFsWorkspaceIdFromParams({ fs_workspace_id: "ws-a" })).toBe("ws-a");
    expect(resolveFsWorkspaceIdFromParams({ fsWorkspaceId: "ws-b" })).toBe("ws-b");
  });

  test("resolves loop options", () => {
    expect(resolveFsWorkspaceIdFromLoopOptions({ fsWorkspaceId: "ws-loop" })).toBe("ws-loop");
    expect(resolveFsWorkspaceIdFromLoopOptions({ fsWorkspaceId: "wf_x" })).toBeNull();
  });

  test("env resolver", () => {
    const prev = process.env.QUBIT_ACTIVE_FS_WORKSPACE_ID;
    process.env.QUBIT_ACTIVE_FS_WORKSPACE_ID = "ws-env";
    expect(resolveFsWorkspaceIdFromEnv()).toBe("ws-env");
    process.env.QUBIT_ACTIVE_FS_WORKSPACE_ID = "wf_env";
    expect(resolveFsWorkspaceIdFromEnv()).toBeNull();
    if (prev === undefined) delete process.env.QUBIT_ACTIVE_FS_WORKSPACE_ID;
    else process.env.QUBIT_ACTIVE_FS_WORKSPACE_ID = prev;
  });
});

describe("project-experience-to-fs gates", () => {
  test("projects iteration_summary semantic", () => {
    expect(
      shouldProjectExperienceToFs(
        makeExp({
          kind: "semantic",
          subKind: "iteration_summary",
          contentJson: { summary: "结论：波动偏低", body: "细节…" },
        })
      )
    ).toBe(true);
  });

  test("rejects reflective / archived / delivery narrative", () => {
    expect(
      shouldProjectExperienceToFs(
        makeExp({
          kind: "reflective",
          subKind: "lesson",
          contentJson: { summary: "反思" },
        })
      )
    ).toBe(false);
    expect(
      shouldProjectExperienceToFs(
        makeExp({
          kind: "semantic",
          subKind: "iteration_summary",
          validTo: "2026-08-09T00:00:00Z",
          contentJson: { summary: "旧" },
        })
      )
    ).toBe(false);
  });

  test("idempotent projected id", () => {
    expect(projectedFsEntryId("abc-123")).toBe("exp_abc-123");
  });
});
