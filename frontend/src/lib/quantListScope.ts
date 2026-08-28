/**
 * 量化工作台列表 scope：project + workflow / session  lineage 组合查询。
 *
 * - workflow_run_id 全局唯一，按 workflow 过滤时不应再强卡 projectId（研究侧栏契约）
 * - session 下可能有多个 workflow_run，需展开后 merge
 * - 脚本列表 API 原生支持 session_id，可走直连
 */
import {
  flattenMonitorWorkflowRows,
  listBacktestJobs,
  listDiscoveryJobs,
  listFactors,
  listMonitorWorkflows,
  listProjectStrategyScripts,
  listRules,
  listStrategyVersions,
  type BacktestJobRecord,
  type DiscoveryJobRecord,
  type FactorRecord,
  type QuantStrategyScriptSummary,
  type RuleRecord,
  type StrategyVersionFlatRecord,
} from "../api/backend";
import type { QuantLineageFilter } from "../store";

export type QuantListProjectFilter = { projectId?: string };

export type QuantListQuery = QuantListProjectFilter & {
  workflowRunId?: string;
  sessionId?: string;
};

export function quantListProjectFilter(scopeProjectId: string | null): QuantListProjectFilter {
  return scopeProjectId ? { projectId: scopeProjectId } : {};
}

export function quantLineageFilterActive(lineage: QuantLineageFilter): boolean {
  return lineage.mode !== "none" && lineage.id.trim().length > 0;
}

export function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

export async function resolveSessionWorkflowIds(sessionId: string): Promise<string[]> {
  const trimmed = sessionId.trim();
  if (!trimmed) return [];
  const data = await listMonitorWorkflows({ sessionId: trimmed });
  const rows = flattenMonitorWorkflowRows(data) as Array<{ id?: unknown }>;
  return [
    ...new Set(
      rows
        .map((row) => String(row.id ?? "").trim())
        .filter(Boolean)
    ),
  ];
}

async function fetchWithWorkflowLineage<T extends { id: string }>(
  fetch: (query: QuantListQuery) => Promise<T[]>,
  projectFilter: QuantListProjectFilter,
  lineage: QuantLineageFilter,
  options?: { sessionDirect?: boolean }
): Promise<T[]> {
  if (!quantLineageFilterActive(lineage)) {
    return fetch({ ...projectFilter });
  }
  if (lineage.mode === "workflow") {
    return fetch({ ...projectFilter, workflowRunId: lineage.id.trim() });
  }
  if (options?.sessionDirect) {
    return fetch({ ...projectFilter, sessionId: lineage.id.trim() });
  }
  const workflowIds = await resolveSessionWorkflowIds(lineage.id);
  if (workflowIds.length === 0) return [];
  const batches = await Promise.all(
    workflowIds.map((workflowRunId) => fetch({ ...projectFilter, workflowRunId }))
  );
  return dedupeById(batches.flat());
}

function filterDiscoveryByLineage(
  rows: DiscoveryJobRecord[],
  lineage: QuantLineageFilter
): DiscoveryJobRecord[] {
  if (!quantLineageFilterActive(lineage)) return rows;
  if (lineage.mode === "workflow") {
    const wf = lineage.id.trim();
    return rows.filter((row) => row.workflowRunId === wf);
  }
  return rows;
}

export async function fetchQuantFactors(
  projectFilter: QuantListProjectFilter,
  lineage: QuantLineageFilter
): Promise<FactorRecord[]> {
  return fetchWithWorkflowLineage(
    (query) => listFactors(query),
    projectFilter,
    lineage
  );
}

export async function fetchQuantBacktestJobs(
  projectFilter: QuantListProjectFilter,
  lineage: QuantLineageFilter
): Promise<BacktestJobRecord[]> {
  return fetchWithWorkflowLineage(
    (query) => listBacktestJobs(query),
    projectFilter,
    lineage
  );
}

export async function fetchQuantStrategyVersions(
  projectFilter: QuantListProjectFilter,
  lineage: QuantLineageFilter
): Promise<StrategyVersionFlatRecord[]> {
  return fetchWithWorkflowLineage(
    (query) => listStrategyVersions(query),
    projectFilter,
    lineage
  );
}

export async function fetchQuantRules(
  projectFilter: QuantListProjectFilter,
  lineage: QuantLineageFilter
): Promise<RuleRecord[]> {
  const rows = await listRules(projectFilter);
  if (!quantLineageFilterActive(lineage)) return rows;
  if (lineage.mode === "workflow") {
    const wf = lineage.id.trim();
    return rows.filter((row) => row.workflowRunId === wf);
  }
  const workflowIds = new Set(await resolveSessionWorkflowIds(lineage.id));
  if (workflowIds.size === 0) return [];
  return rows.filter((row) => row.workflowRunId && workflowIds.has(row.workflowRunId));
}

export async function fetchQuantDiscoveryJobs(
  projectFilter: QuantListProjectFilter,
  lineage: QuantLineageFilter
): Promise<DiscoveryJobRecord[]> {
  const rows = await listDiscoveryJobs(projectFilter);
  if (!quantLineageFilterActive(lineage)) return rows;
  if (lineage.mode === "workflow") {
    return filterDiscoveryByLineage(rows, lineage);
  }
  const workflowIds = new Set(await resolveSessionWorkflowIds(lineage.id));
  if (workflowIds.size === 0) return [];
  return rows.filter((row) => row.workflowRunId && workflowIds.has(row.workflowRunId));
}

export async function fetchQuantStrategyScripts(
  projectFilter: QuantListProjectFilter,
  lineage: QuantLineageFilter,
  extra?: { purpose?: "research" | "live_trading" | "both" }
): Promise<QuantStrategyScriptSummary[]> {
  const base = { ...projectFilter, ...(extra?.purpose ? { purpose: extra.purpose } : {}) };
  return fetchWithWorkflowLineage(
    (query) => listProjectStrategyScripts(query),
    base,
    lineage,
    { sessionDirect: true }
  );
}
