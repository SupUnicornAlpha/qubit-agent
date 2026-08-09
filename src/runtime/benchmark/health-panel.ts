import { getDb, getSqliteForTesting } from "../../db/sqlite/client";
import { buildToolCatalog } from "../tools/tool-catalog";

export type BenchmarkHealth = "healthy" | "degraded" | "unhealthy" | "sample_low" | "unused";

export interface BenchmarkHealthRow {
  name: string;
  kind: "builtin" | "connector" | "dynamic" | "mcp" | "skill";
  calls: number;
  successes: number;
  failures: number;
  timeouts: number;
  failureRate: number;
  maxLatencyMs: number;
  health: BenchmarkHealth;
  lifecycle?: string;
  category?: string;
}

export interface BenchmarkHealthPanel {
  schemaVersion: "1.0";
  generatedAt: string;
  workflowRunIds: string[];
  summary: {
    totalCalls: number;
    totalFailures: number;
    toolCount: number;
    dynamicCount: number;
    mcpCount: number;
    skillCount: number;
  };
  rows: BenchmarkHealthRow[];
}

export async function buildBenchmarkHealthPanel(
  workflowRunIds: readonly string[]
): Promise<BenchmarkHealthPanel> {
  await getDb();
  const sqlite = getSqliteForTesting();
  const ids = [...new Set(workflowRunIds.filter(Boolean))];
  const placeholders = ids.map(() => "?").join(",");
  const toolRows = ids.length
    ? (sqlite
        .prepare(
          `SELECT tool_name AS name,
                  tool_kind AS toolKind,
                  COUNT(*) AS calls,
                  SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successes,
                  SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) AS failures,
                  SUM(CASE WHEN status='timeout' THEN 1 ELSE 0 END) AS timeouts,
                  MAX(COALESCE(latency_ms,0)) AS maxLatencyMs
           FROM tool_call_log
           WHERE workflow_run_id IN (${placeholders})
           GROUP BY tool_name, tool_kind`
        )
        .all(...ids) as Array<{
        name: string;
        toolKind: string;
        calls: number;
        successes: number;
        failures: number;
        timeouts: number;
        maxLatencyMs: number;
      }>)
    : [];
  const actual = new Map(toolRows.map((row) => [row.name, row]));
  const catalog = buildToolCatalog();
  const catalogNames = new Set(catalog.map((entry) => entry.name));
  const rows: BenchmarkHealthRow[] = catalog.map((entry) => {
    const stat = actual.get(entry.name);
    return healthRow({
      name: entry.name,
      kind: entry.kind === "connector" ? "connector" : "builtin",
      calls: stat?.calls ?? 0,
      successes: stat?.successes ?? 0,
      failures: stat?.failures ?? 0,
      timeouts: stat?.timeouts ?? 0,
      maxLatencyMs: stat?.maxLatencyMs ?? 0,
      lifecycle: entry.lifecycle ?? "stable",
      ...(entry.category ? { category: entry.category } : {}),
    });
  });

  for (const stat of toolRows) {
    if (catalogNames.has(stat.name)) continue;
    const isMcp = stat.toolKind === "mcp" || stat.name.startsWith("mcp:");
    rows.push(
      healthRow({
        name: stat.name,
        kind: isMcp ? "mcp" : "dynamic",
        calls: stat.calls,
        successes: stat.successes,
        failures: stat.failures,
        timeouts: stat.timeouts,
        maxLatencyMs: stat.maxLatencyMs,
      })
    );
  }

  if (ids.length) {
    const skillRows = sqlite
      .prepare(
        `SELECT s.name,
                COUNT(*) AS calls,
                SUM(CASE WHEN r.outcome='success' THEN 1 ELSE 0 END) AS successes,
                SUM(CASE WHEN r.outcome!='success' THEN 1 ELSE 0 END) AS failures
         FROM agent_skill_run r
         INNER JOIN agent_skill s ON s.id=r.skill_id
         WHERE r.workflow_run_id IN (${placeholders})
         GROUP BY s.name`
      )
      .all(...ids) as Array<{ name: string; calls: number; successes: number; failures: number }>;
    for (const stat of skillRows) {
      rows.push(
        healthRow({
          ...stat,
          name: `skill:${stat.name}`,
          kind: "skill",
          maxLatencyMs: 0,
          timeouts: 0,
        })
      );
    }
  }

  rows.sort(
    (a, b) => b.calls - a.calls || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
  );
  const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0);
  const totalFailures = rows.reduce((sum, row) => sum + row.failures, 0);
  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    workflowRunIds: ids,
    summary: {
      totalCalls,
      totalFailures,
      toolCount: rows.filter((row) => row.kind === "builtin" || row.kind === "connector").length,
      dynamicCount: rows.filter((row) => row.kind === "dynamic").length,
      mcpCount: rows.filter((row) => row.kind === "mcp").length,
      skillCount: rows.filter((row) => row.kind === "skill").length,
    },
    rows,
  };
}

export function renderBenchmarkHealthMarkdown(panel: BenchmarkHealthPanel): string {
  const lines = [
    "# Benchmark Tool / MCP / Dynamic / Skills Health",
    "",
    `- workflows: ${panel.workflowRunIds.length}`,
    `- calls: ${panel.summary.totalCalls}; failures: ${panel.summary.totalFailures}`,
    `- catalog tools: ${panel.summary.toolCount}; dynamic: ${panel.summary.dynamicCount}; MCP: ${panel.summary.mcpCount}; Skills: ${panel.summary.skillCount}`,
    "",
    "| Kind | Name | Calls | Success | Failure | Timeout | Failure % | Max ms | Health |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const row of panel.rows) {
    lines.push(
      `| ${row.kind} | ${row.name} | ${row.calls} | ${row.successes} | ${row.failures} | ${row.timeouts} | ${(row.failureRate * 100).toFixed(1)} | ${row.maxLatencyMs} | ${row.health} |`
    );
  }
  return lines.join("\n");
}

function healthRow(input: Omit<BenchmarkHealthRow, "failureRate" | "health">): BenchmarkHealthRow {
  const failureRate = input.calls > 0 ? input.failures / input.calls : 0;
  const health = classifyBenchmarkHealth({
    calls: input.calls,
    failures: input.failures,
    timeouts: input.timeouts,
  });
  return { ...input, failureRate, health };
}

export function classifyBenchmarkHealth(input: {
  calls: number;
  failures: number;
  timeouts: number;
}): BenchmarkHealth {
  const failureRate = input.calls > 0 ? input.failures / input.calls : 0;
  const timeoutRate = input.calls > 0 ? input.timeouts / input.calls : 0;
  return input.calls === 0
    ? "unused"
    : input.calls >= 3 && (failureRate >= 0.5 || timeoutRate >= 0.4)
      ? "unhealthy"
      : input.calls >= 5 && failureRate >= 0.2
        ? "degraded"
        : input.failures > 0 && input.calls < 5
          ? "sample_low"
          : "healthy";
}
