import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../agent/agent-pack-service";

export type WorkflowArtifactPaths = {
  workflowDir: string;
  reportPath?: string;
  strategiesDir: string;
};

function slugSegment(name: string): string {
  const s = name
    .trim()
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (s || "script").slice(0, 48);
}

export function workflowArtifactDir(projectId: string, workflowRunId: string): string {
  return join(getDataDir(), "projects", projectId, "workflows", workflowRunId);
}

export async function saveWorkflowReportArtifact(input: {
  projectId: string;
  workflowRunId: string;
  report: string;
  ticker?: string;
}): Promise<string> {
  const dir = workflowArtifactDir(input.projectId, input.workflowRunId);
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, "report.md");
  const header =
    input.ticker?.trim() ?
      `# 团队分析报告 · ${input.ticker.trim()}\n\n`
    : `# 团队分析报告\n\n`;
  await writeFile(reportPath, header + input.report, "utf8");
  return reportPath;
}

export async function readWorkflowReportArtifact(
  projectId: string,
  workflowRunId: string
): Promise<string | null> {
  try {
    const raw = await readFile(join(workflowArtifactDir(projectId, workflowRunId), "report.md"), "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

export async function exportStrategyScriptToWorkflowDir(input: {
  projectId: string;
  workflowRunId: string;
  scriptId: string;
  name: string;
  ideCode: string;
  signalCode: string;
}): Promise<{ scriptDir: string; files: string[] }> {
  const strategiesRoot = join(
    workflowArtifactDir(input.projectId, input.workflowRunId),
    "strategies"
  );
  const folder = `${slugSegment(input.name)}__${input.scriptId.slice(0, 8)}`;
  const scriptDir = join(strategiesRoot, folder);
  await mkdir(scriptDir, { recursive: true });
  const files: string[] = [];
  const metaPath = join(scriptDir, "meta.json");
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        scriptId: input.scriptId,
        name: input.name,
        workflowRunId: input.workflowRunId,
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
  files.push(metaPath);
  if (input.ideCode.trim()) {
    const p = join(scriptDir, "indicator.md");
    await writeFile(p, input.ideCode, "utf8");
    files.push(p);
  }
  if (input.signalCode.trim()) {
    const p = join(scriptDir, "signal.py");
    await writeFile(p, input.signalCode, "utf8");
    files.push(p);
  }
  return { scriptDir, files };
}

export async function listWorkflowArtifactSummary(
  projectId: string,
  workflowRunId: string
): Promise<{
  workflowDir: string;
  reportPath: string | null;
  strategyFolders: string[];
}> {
  const workflowDir = workflowArtifactDir(projectId, workflowRunId);
  let reportPath: string | null = null;
  try {
    await readFile(join(workflowDir, "report.md"), "utf8");
    reportPath = join(workflowDir, "report.md");
  } catch {
    reportPath = null;
  }
  const strategiesDir = join(workflowDir, "strategies");
  let strategyFolders: string[] = [];
  try {
    const entries = await readdir(strategiesDir, { withFileTypes: true });
    strategyFolders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    strategyFolders = [];
  }
  return { workflowDir, reportPath, strategyFolders };
}
