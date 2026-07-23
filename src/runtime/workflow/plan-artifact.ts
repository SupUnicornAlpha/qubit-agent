import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPlanSnapshot } from "../agent-control-mode";
import { getDataDir } from "../agent/agent-pack-service";

export interface WorkflowPlanArtifactPaths {
  workflowDir: string;
  jsonPath: string;
  markdownPath: string;
}

export function workflowWorkspaceDir(projectId: string, workflowRunId: string): string {
  return join(getDataDir(), "projects", projectId, "workflows", workflowRunId);
}

function markdownCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

export function renderWorkflowPlanMarkdown(input: {
  workflowRunId: string;
  projectId: string;
  plan: AgentPlanSnapshot;
}): string {
  const lines = [
    "# Workflow Plan",
    "",
    `- Workflow: \`${markdownCell(input.workflowRunId)}\``,
    `- Project: \`${markdownCell(input.projectId)}\``,
    `- Mode: \`${markdownCell(input.plan.mode ?? "agent")}\``,
    `- Updated: ${markdownCell(input.plan.updatedAt ?? "")}`,
  ];
  if (input.plan.goal?.text) {
    lines.push("", "## Goal", "", markdownCell(input.plan.goal.text));
  }
  lines.push("", "## Steps", "", "| Status | Step | Note |", "| --- | --- | --- |");
  for (const step of input.plan.steps) {
    lines.push(
      `| ${markdownCell(step.status)} | ${markdownCell(step.title)} | ${markdownCell(step.note)} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 将 DB 中的权威计划镜像到 workflow 自己的受控 workspace。
 *
 * 路径完全由数据库里的 projectId + 当前 workflowId 生成，不接受 LLM 提供的 cwd/path，
 * 因而不会越出 `$dataDir/projects/<projectId>/workflows/<workflowId>/`。
 */
export async function writeWorkflowPlanArtifacts(input: {
  projectId: string;
  workflowRunId: string;
  plan: AgentPlanSnapshot;
}): Promise<WorkflowPlanArtifactPaths> {
  const workflowDir = workflowWorkspaceDir(input.projectId, input.workflowRunId);
  const jsonPath = join(workflowDir, "plan.json");
  const markdownPath = join(workflowDir, "PLAN.md");
  await mkdir(workflowDir, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(input.plan, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderWorkflowPlanMarkdown(input), "utf8"),
  ]);
  return { workflowDir, jsonPath, markdownPath };
}
