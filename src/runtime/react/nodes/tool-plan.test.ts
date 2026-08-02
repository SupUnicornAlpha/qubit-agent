import { describe, expect, test } from "bun:test";
import { buildToolPlan } from "./tool-plan";

describe("tool plan", () => {
  test("binds workflow and project context before admission", async () => {
    const plan = await buildToolPlan({
      parsed: {
        kind: "tool",
        toolName: "update_plan",
        params: { workflowRunId: "forged", project_id: "forged-project", steps: [] },
      },
      workflowId: "wf-1",
      projectId: "project-1",
    });

    expect(plan.targetName).toBe("update_plan");
    expect(plan.params).toMatchObject({
      workflowRunId: "wf-1",
      projectId: "project-1",
      project_id: "project-1",
    });
  });

  test("resolves a deprecated tool to its executable route", async () => {
    const plan = await buildToolPlan({
      parsed: { kind: "tool", toolName: "check_risk", params: {} },
      workflowId: "wf-1",
      projectId: undefined,
    });

    expect(plan.executionRoute).toMatchObject({
      originalName: "check_risk",
      effectiveName: "evaluate_risk",
      aliased: true,
    });
    expect(plan.effectiveToolName).toBe("evaluate_risk");
  });
});
