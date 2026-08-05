import { describe, expect, test } from "bun:test";
import { isBuiltinTool } from "../builtin-tools";
import { resolveFsWorkspaceIdFromParams } from "../prime-memory-handlers";

describe("resolveFsWorkspaceIdFromParams", () => {
  test("prefers fs_workspace_id", () => {
    expect(
      resolveFsWorkspaceIdFromParams({
        fs_workspace_id: "ws-abc",
        workspace_id: "other",
      })
    ).toBe("ws-abc");
  });

  test("accepts workspace_id when not wf_ prefix", () => {
    expect(resolveFsWorkspaceIdFromParams({ workspace_id: "ws-fs-1" })).toBe("ws-fs-1");
  });

  test("rejects Core wf_ session workspace_id", () => {
    expect(resolveFsWorkspaceIdFromParams({ workspace_id: "wf_run-123" })).toBeNull();
  });

  test("accepts camelCase aliases", () => {
    expect(resolveFsWorkspaceIdFromParams({ fsWorkspaceId: "ws-cam" })).toBe("ws-cam");
    expect(resolveFsWorkspaceIdFromParams({ workspaceId: "ws-cam2" })).toBe("ws-cam2");
  });
});

describe("prime memory builtins registration", () => {
  test("memory.recall and workspace.memory.search are builtin", () => {
    expect(isBuiltinTool("memory.recall")).toBe(true);
    expect(isBuiltinTool("workspace.memory.search")).toBe(true);
    expect(isBuiltinTool("workspace.context.snapshot")).toBe(true);
  });
});
