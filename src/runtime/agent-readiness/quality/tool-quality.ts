/**
 * B 类 · 工具/Skill 调用质量。
 *
 *   B-1 必备工具召回率   = matched / scorableRequired
 *                          scorable = required − waived（manifest/DataGap/未授权）
 *   B-2 参数合理性比例   = 1 - 异常参数 / 总调用（异常 = qty<=0 / NaN 数值 / 空 symbol）
 *   B-3 工具失败率       = error_count / total（同原 T-1，但保留按 toolKind 分桶）
 *   B-7 单元素最大重复数 = max((toolName, requestHash) → count)（绿 ≤ 2，黄 3-4，红 ≥ 5）
 *
 * 设计取舍：
 *   - B-1 子串匹配（不精确名称比对）：avoid "get_quote" vs "yahoo_finance.get_quote" 写死
 *   - B-1 与 runtime capability 对齐：未配置新闻 / DataGap(unconfigured|no_coverage) /
 *     项目内无授权工具的能力不进入分母，避免把“诚实不可用”打成召回失败
 *   - B-2 参数检查只看"明显坏值"，不试图深度 schema 校验（schema 在 dispatcher 层已有）
 *   - B-7 用 hash(JSON.stringify(request))，对 request 做 stable 序列化
 */
import type { Database } from "bun:sqlite";

import { toolMatchesRequiredCapability } from "../../tools/data-gap";
import { listAuthorizedToolsFromSqlite } from "../../tools/required-tool-gate";
import type { ScenarioRecipe } from "../scenarios";
import { getScenarioExpectation } from "./scenario-expectations";

export interface ToolQualityInput {
  workflowRunId: string;
  scenario: ScenarioRecipe["key"];
}

export interface ToolQualityResult {
  "B-1": number;
  "B-2": number;
  "B-3": number;
  "B-7": number;
  details: {
    requiredTools: ReadonlyArray<string>;
    matchedTools: ReadonlyArray<string>;
    missedTools: ReadonlyArray<string>;
    waivedTools: ReadonlyArray<string>;
    failureByKind: Record<string, { errors: number; total: number }>;
    repeatedCallTop: ReadonlyArray<{ toolName: string; count: number }>;
  };
}

interface ToolCallRow {
  toolName: string;
  toolKind: string;
  status: string;
  requestJson: string;
}

function readToolCalls(sqlite: Database, workflowRunId: string): ToolCallRow[] {
  return sqlite
    .prepare(
      `SELECT tool_name AS toolName, tool_kind AS toolKind, status,
              request_json AS requestJson
       FROM tool_call_log WHERE workflow_run_id = ?`
    )
    .all(workflowRunId) as ToolCallRow[];
}

function tableExists(sqlite: Database, name: string): boolean {
  const row = sqlite
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as { ok?: number } | undefined;
  return Boolean(row?.ok);
}

function readDataGapWaivers(sqlite: Database, workflowRunId: string): Set<string> {
  const waived = new Set<string>();
  if (!tableExists(sqlite, "workflow_artifact_ledger")) return waived;
  const rows = sqlite
    .prepare(
      `SELECT tool_name AS toolName, payload_json AS payloadJson
       FROM workflow_artifact_ledger
       WHERE workflow_run_id = ?
         AND artifact_kind = 'DataGap'`
    )
    .all(workflowRunId) as Array<{ toolName: string; payloadJson: string }>;
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try {
      payload =
        typeof row.payloadJson === "string"
          ? (JSON.parse(row.payloadJson) as Record<string, unknown>)
          : ((row.payloadJson as Record<string, unknown>) ?? {});
    } catch {
      payload = {};
    }
    const kind = String(payload.kind ?? "");
    if (kind !== "unconfigured" && kind !== "no_coverage") continue;
    const capability = String(payload.capability ?? row.toolName ?? "").trim();
    if (capability) waived.add(capability);
  }
  return waived;
}

function newsProviderConfigured(sqlite: Database): boolean | null {
  if (!tableExists(sqlite, "builtin_connector_settings")) return null;
  const row = sqlite
    .prepare(
      `SELECT config_json AS configJson FROM builtin_connector_settings WHERE id = 'default'`
    )
    .get() as { configJson?: string } | undefined;
  if (!row?.configJson) return null;
  try {
    const parsed =
      typeof row.configJson === "string"
        ? (JSON.parse(row.configJson) as Record<string, unknown>)
        : (row.configJson as Record<string, unknown>);
    const news = (parsed["qubit-news"] ?? {}) as Record<string, unknown>;
    const base = typeof news.newsApiBaseUrl === "string" ? news.newsApiBaseUrl.trim() : "";
    const synthetic = news.syntheticWhenEmpty === true || news.syntheticWhenEmpty === "true";
    return base.length > 0 && !synthetic;
  } catch {
    return null;
  }
}

/**
 * Capabilities that should not count against B-1 because they were never
 * honestly callable for this workflow / environment.
 */
export function listWaivedRequiredTools(
  sqlite: Database,
  workflowRunId: string,
  required: ReadonlyArray<string>
): string[] {
  const authorized = listAuthorizedToolsFromSqlite(sqlite, []);
  const gapWaivers = readDataGapWaivers(sqlite, workflowRunId);
  const newsOk = newsProviderConfigured(sqlite);
  return required.filter((capability) => {
    if (gapWaivers.has(capability)) return true;
    if (capability === "news" && newsOk === false) return true;
    if (authorized.length === 0) return false;
    return !authorized.some((tool) => toolMatchesRequiredCapability(tool, capability));
  });
}

function metricB1(
  rows: ToolCallRow[],
  required: ReadonlyArray<string>,
  waived: ReadonlyArray<string>
): { value: number; matched: string[]; missed: string[]; waived: string[] } {
  const waivedSet = new Set(waived);
  const scorable = required.filter((req) => !waivedSet.has(req));
  if (!scorable.length) {
    return { value: 1, matched: [], missed: [], waived: [...waived] };
  }
  const distinctTools = [...new Set(rows.map((r) => r.toolName))];
  const matched: string[] = [];
  const missed: string[] = [];
  for (const req of scorable) {
    const hit = distinctTools.some((t) => toolMatchesRequiredCapability(t, req));
    if (hit) matched.push(req);
    else missed.push(req);
  }
  return {
    value: matched.length / scorable.length,
    matched,
    missed,
    waived: [...waived],
  };
}

// ── B-2 ────────────────────────────────────────────────────────────────────

function isAbnormalRequest(raw: string | null | undefined): boolean {
  if (raw == null || raw === "") return false;
  let obj: unknown;
  try {
    obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return false;
  }
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  if (typeof r.qty === "number" && (Number.isNaN(r.qty) || r.qty <= 0)) return true;
  if (typeof r.quantity === "number" && (Number.isNaN(r.quantity) || r.quantity <= 0)) return true;
  if (typeof r.price === "number" && (Number.isNaN(r.price) || r.price < 0)) return true;
  for (const key of ["symbol", "ticker"]) {
    const v = r[key];
    if (v !== undefined && (typeof v !== "string" || v.trim() === "")) return true;
  }
  for (const key of ["date", "asof"]) {
    const v = r[key];
    if (typeof v === "string" && !/^\d{4}-\d{2}-\d{2}/.test(v)) return true;
  }
  return false;
}

function metricB2(rows: ToolCallRow[]): number {
  if (!rows.length) return 1;
  const abnormal = rows.filter((r) => isAbnormalRequest(r.requestJson)).length;
  return 1 - abnormal / rows.length;
}

// ── B-3 ────────────────────────────────────────────────────────────────────

function metricB3(rows: ToolCallRow[]): {
  value: number;
  byKind: Record<string, { errors: number; total: number }>;
} {
  const byKind: Record<string, { errors: number; total: number }> = {};
  let totalErr = 0;
  for (const r of rows) {
    const kind = r.toolKind || "unknown";
    byKind[kind] ??= { errors: 0, total: 0 };
    byKind[kind].total++;
    if (r.status === "error" || r.status === "timeout" || r.status === "sandbox_blocked") {
      byKind[kind].errors++;
      totalErr++;
    }
  }
  const value = rows.length === 0 ? 0 : totalErr / rows.length;
  return { value, byKind };
}

// ── B-7 ────────────────────────────────────────────────────────────────────

function stableStringify(obj: unknown): string {
  try {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj ?? "");
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = (obj as Record<string, unknown>)[k];
    return JSON.stringify(out);
  } catch {
    return String(obj);
  }
}

function metricB7(rows: ToolCallRow[]): {
  value: number;
  top: Array<{ toolName: string; count: number }>;
} {
  if (!rows.length) return { value: 0, top: [] };
  const counter = new Map<string, { toolName: string; count: number }>();
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = typeof r.requestJson === "string" ? JSON.parse(r.requestJson) : r.requestJson;
    } catch {
      parsed = r.requestJson;
    }
    const key = `${r.toolName}::${stableStringify(parsed)}`;
    const cur = counter.get(key);
    if (cur) cur.count++;
    else counter.set(key, { toolName: r.toolName, count: 1 });
  }
  const sorted = [...counter.values()].sort((a, b) => b.count - a.count);
  return { value: sorted[0]?.count ?? 0, top: sorted.slice(0, 5) };
}

// ── 汇总 ───────────────────────────────────────────────────────────────────

export async function collectToolQuality(
  sqlite: Database,
  input: ToolQualityInput
): Promise<ToolQualityResult> {
  const exp = getScenarioExpectation(input.scenario);
  const rows = readToolCalls(sqlite, input.workflowRunId);
  const waived = listWaivedRequiredTools(sqlite, input.workflowRunId, exp.requiredTools);
  const b1 = metricB1(rows, exp.requiredTools, waived);
  const b2 = metricB2(rows);
  const b3 = metricB3(rows);
  const b7 = metricB7(rows);
  return {
    "B-1": b1.value,
    "B-2": b2,
    "B-3": b3.value,
    "B-7": b7.value,
    details: {
      requiredTools: exp.requiredTools,
      matchedTools: b1.matched,
      missedTools: b1.missed,
      waivedTools: b1.waived,
      failureByKind: b3.byKind,
      repeatedCallTop: b7.top,
    },
  };
}
