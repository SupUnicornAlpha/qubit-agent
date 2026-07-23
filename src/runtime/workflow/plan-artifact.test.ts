import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { renderWorkflowPlanMarkdown, writeWorkflowPlanArtifacts } from "./plan-artifact";

const plan = {
  mode: "plan" as const,
  goal: {
    text: "分析 VIX 风险",
    status: "planning" as const,
    completedSteps: 0,
    totalSteps: 2,
  },
  steps: [
    { id: "s1", title: "读取 VIX | SPX", status: "pending" as const },
    {
      id: "s2",
      title: "归因",
      status: "pending" as const,
      note: "缺失项\n标记待核实",
    },
  ],
  updatedAt: "2026-07-23T06:00:00.000Z",
};

describe("workflow plan artifacts", () => {
  test("renders stable markdown and escapes table-breaking content", () => {
    const markdown = renderWorkflowPlanMarkdown({
      projectId: "project-1",
      workflowRunId: "workflow-1",
      plan,
    });
    expect(markdown).toContain("# Workflow Plan");
    expect(markdown).toContain("读取 VIX \\| SPX");
    expect(markdown).toContain("缺失项 标记待核实");
  });

  test("writes PLAN.md and plan.json inside the workflow workspace", async () => {
    const suffix = crypto.randomUUID();
    const paths = await writeWorkflowPlanArtifacts({
      projectId: `project-${suffix}`,
      workflowRunId: `workflow-${suffix}`,
      plan,
    });
    expect(paths.workflowDir).toContain(`/projects/project-${suffix}/workflows/workflow-${suffix}`);
    expect(await readFile(paths.markdownPath, "utf8")).toContain("分析 VIX 风险");
    expect(JSON.parse(await readFile(paths.jsonPath, "utf8"))).toEqual(plan);
  });
});
