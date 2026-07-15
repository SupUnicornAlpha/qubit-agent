import { describe, expect, test } from "bun:test";
import { quantNavigationForArtifact } from "./quantArtifactNavigation";

describe("quantNavigationForArtifact", () => {
  test("factor 携带精确 factorId 进入因子工坊", () => {
    const target = quantNavigationForArtifact(
      { id: "factor-1", kind: "factor", title: "VPR", projectId: "project-a", workflowRunId: "wf-a" },
      "project-default",
      "wf-default"
    );
    expect(target.tab).toBe("factor");
    expect(target.context?.projectId).toBe("project-a");
    expect(target.handoff).toMatchObject({ kind: "factor-to-workbench", factorId: "factor-1" });
  });

  test("strategy 携带 strategyVersionId 进入组合工坊", () => {
    const target = quantNavigationForArtifact(
      { id: "version-1", kind: "strategy", title: "VPR Strategy" },
      "project-default",
      "wf-default"
    );
    expect(target.tab).toBe("composer");
    expect(target.context?.projectId).toBe("project-default");
    expect(target.handoff).toMatchObject({
      kind: "strategy-version-to-composer",
      strategyVersionId: "version-1",
    });
  });

  test("script 携带 scriptId 进入脚本工坊", () => {
    const target = quantNavigationForArtifact(
      { id: "script-1", kind: "script", title: "on_bar" },
      "project-default",
      "wf-default"
    );
    expect(target.tab).toBe("script");
    expect(target.handoff).toMatchObject({ kind: "script-to-workbench", scriptId: "script-1" });
  });

  test("产物缺 projectId 时使用当前 workflow 项目", () => {
    const target = quantNavigationForArtifact(
      { id: "factor-2", kind: "factor", title: "fallback" },
      "project-from-workflow",
      "wf-from-selection"
    );
    expect(target.context).toMatchObject({
      projectId: "project-from-workflow",
      workflowRunId: "wf-from-selection",
    });
  });
});
