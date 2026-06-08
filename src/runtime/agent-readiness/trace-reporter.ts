/**
 * trace-reporter：把单条 workflow_run 的全过程导成人可读 Markdown。
 *
 * 用途：B 模式调优时，agent grade 只能告诉你"哪个指标红了"，
 *      但不告诉你"具体哪一步 tool 失败 / 哪个 prompt 跑飞了"。这份 trace 就是补这一段。
 *
 * 内容（按时间线交织）：
 *   - agent_step：thought / action_type
 *   - tool_call_log（按 agent_step_id 关联）
 *   - llm_call_log（按 workflow_run_id 关联，按 created_at 排序）
 */

import type { Database } from "bun:sqlite";
import { getDb, getSqliteForTesting } from "../../db/sqlite/client";

export interface TraceInput {
  workflowRunId: string;
  /** 截断超长 JSON 字段，默认 400 字符 */
  truncateAt?: number;
}

interface AgentStepRow {
  id: string;
  stepIndex: number;
  phase: string;
  thought: string | null;
  actionType: string;
  actionJson: string;
  observationJson: string | null;
  latencyMs: number | null;
  createdAt: string;
}

interface ToolCallRow {
  id: string;
  agentStepId: string;
  toolName: string;
  status: string;
  errorMessage: string | null;
  latencyMs: number | null;
  createdAt: string;
}

interface LlmCallRow {
  id: string;
  agentStepId: string | null;
  provider: string;
  model: string;
  totalTokens: number | null;
  status: string;
  errorMessage: string | null;
  finishReason: string | null;
  createdAt: string;
}

export async function renderTraceMarkdown(input: TraceInput): Promise<string> {
  await getDb();
  const sqlite = getSqliteForTesting();
  const truncate = input.truncateAt ?? 400;

  const wf = sqlite
    .prepare(
      "SELECT id, status, goal, mode FROM workflow_run WHERE id = ?"
    )
    .get(input.workflowRunId) as
    | { id: string; status: string; goal: string; mode: string }
    | undefined;
  if (!wf) {
    return `# Trace not found\n\nworkflow_run.id = \`${input.workflowRunId}\`\n`;
  }

  const steps = readSteps(sqlite, input.workflowRunId);
  const tools = readTools(sqlite, input.workflowRunId);
  const llms = readLlms(sqlite, input.workflowRunId);
  const toolsByStep = groupBy(tools, (t) => t.agentStepId);
  const llmsByStep = groupBy(llms, (l) => l.agentStepId ?? "_orphan");

  const lines: string[] = [];
  lines.push(`# Workflow Trace — ${wf.id}`);
  lines.push("");
  lines.push(`- mode: \`${wf.mode}\``);
  lines.push(`- status: \`${wf.status}\``);
  lines.push(`- goal: ${wf.goal}`);
  lines.push("");
  lines.push(`总览：${steps.length} steps · ${tools.length} tool calls · ${llms.length} llm calls`);
  lines.push("");

  for (const step of steps) {
    lines.push(`## Step ${step.stepIndex} · ${step.phase} · \`${step.actionType}\``);
    lines.push("");
    lines.push(`- id: \`${step.id}\``);
    lines.push(`- createdAt: ${step.createdAt}`);
    if (step.latencyMs !== null) lines.push(`- latencyMs: ${step.latencyMs}`);
    if (step.thought) {
      lines.push("");
      lines.push("### Thought");
      lines.push("");
      lines.push("```");
      lines.push(truncateText(step.thought, truncate));
      lines.push("```");
    }
    lines.push("");
    lines.push("### Action");
    lines.push("");
    lines.push("```json");
    lines.push(truncateText(prettyJson(step.actionJson), truncate));
    lines.push("```");

    if (step.observationJson) {
      lines.push("");
      lines.push("### Observation");
      lines.push("");
      lines.push("```json");
      lines.push(truncateText(prettyJson(step.observationJson), truncate));
      lines.push("```");
    }

    const stepTools = toolsByStep.get(step.id) ?? [];
    if (stepTools.length > 0) {
      lines.push("");
      lines.push("### Tool calls");
      lines.push("");
      for (const t of stepTools) {
        const errSuffix = t.errorMessage ? ` · err=${truncateText(t.errorMessage, 80)}` : "";
        lines.push(
          `- \`${t.toolName}\` · ${t.status} · ${t.latencyMs ?? "?"} ms${errSuffix}`
        );
      }
    }

    const stepLlms = llmsByStep.get(step.id) ?? [];
    if (stepLlms.length > 0) {
      lines.push("");
      lines.push("### LLM calls");
      lines.push("");
      for (const l of stepLlms) {
        const errSuffix = l.errorMessage ? ` · err=${truncateText(l.errorMessage, 80)}` : "";
        const finish = l.finishReason ? ` · finish=${l.finishReason}` : "";
        lines.push(
          `- ${l.provider}/${l.model} · ${l.status} · tokens=${l.totalTokens ?? "?"}${finish}${errSuffix}`
        );
      }
    }
    lines.push("");
  }

  // 没绑定到 step 的 LLM 调用也一并输出
  const orphans = llmsByStep.get("_orphan") ?? [];
  if (orphans.length > 0) {
    lines.push("## LLM calls without step binding");
    lines.push("");
    for (const l of orphans) {
      lines.push(
        `- ${l.provider}/${l.model} · ${l.status} · tokens=${l.totalTokens ?? "?"} · ${l.createdAt}`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function readSteps(sqlite: Database, workflowRunId: string): AgentStepRow[] {
  return sqlite
    .prepare(
      `SELECT id, step_index AS stepIndex, phase, thought, action_type AS actionType,
              action_json AS actionJson, observation_json AS observationJson,
              latency_ms AS latencyMs, created_at AS createdAt
       FROM agent_step
       WHERE workflow_run_id = ?
       ORDER BY step_index ASC, datetime(created_at) ASC`
    )
    .all(workflowRunId) as AgentStepRow[];
}

function readTools(sqlite: Database, workflowRunId: string): ToolCallRow[] {
  return sqlite
    .prepare(
      `SELECT id, agent_step_id AS agentStepId, tool_name AS toolName, status,
              error_message AS errorMessage, latency_ms AS latencyMs, created_at AS createdAt
       FROM tool_call_log
       WHERE workflow_run_id = ?
       ORDER BY datetime(created_at) ASC`
    )
    .all(workflowRunId) as ToolCallRow[];
}

function readLlms(sqlite: Database, workflowRunId: string): LlmCallRow[] {
  return sqlite
    .prepare(
      `SELECT id, agent_step_id AS agentStepId, provider, model,
              total_tokens AS totalTokens, status, error_message AS errorMessage,
              finish_reason AS finishReason, created_at AS createdAt
       FROM llm_call_log
       WHERE workflow_run_id = ?
       ORDER BY datetime(created_at) ASC`
    )
    .all(workflowRunId) as LlmCallRow[];
}

function groupBy<T, K>(arr: T[], keyFn: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of arr) {
    const k = keyFn(item);
    const list = m.get(k);
    if (list) list.push(item);
    else m.set(k, [item]);
  }
  return m;
}

function truncateText(text: string, n: number): string {
  if (text.length <= n) return text;
  return `${text.slice(0, n)} …(${text.length - n} more chars)`;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
