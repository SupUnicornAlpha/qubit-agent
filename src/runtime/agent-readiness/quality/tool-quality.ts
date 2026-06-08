/**
 * B 类 · 工具/Skill 调用质量。
 *
 *   B-1 必备工具召回率   = matched / required（按 scenario.requiredTools 子串前缀匹配）
 *   B-2 参数合理性比例   = 1 - 异常参数 / 总调用（异常 = qty<=0 / NaN 数值 / 空 symbol）
 *   B-3 工具失败率       = error_count / total（同原 T-1，但保留按 toolKind 分桶）
 *   B-7 单元素最大重复数 = max((toolName, requestHash) → count)（绿 ≤ 2，黄 3-4，红 ≥ 5）
 *
 * 设计取舍：
 *   - B-1 子串匹配（不精确名称比对）：avoid "get_quote" vs "yahoo_finance.get_quote" 写死
 *   - B-2 参数检查只看"明显坏值"，不试图深度 schema 校验（schema 在 dispatcher 层已有）
 *   - B-7 用 hash(JSON.stringify(request))，对 request 做 stable 序列化
 */
import type { Database } from "bun:sqlite";

import { getScenarioExpectation } from "./scenario-expectations";
import type { ScenarioRecipe } from "../scenarios";

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

// ── B-1 ────────────────────────────────────────────────────────────────────

function metricB1(
  rows: ToolCallRow[],
  required: ReadonlyArray<string>
): { value: number; matched: string[]; missed: string[] } {
  if (!required.length) return { value: 1, matched: [], missed: [] };
  const distinctTools = new Set(rows.map((r) => r.toolName.toLowerCase()));
  const matched: string[] = [];
  const missed: string[] = [];
  for (const req of required) {
    const reqLow = req.toLowerCase();
    const hit = [...distinctTools].some((t) => t.includes(reqLow));
    if (hit) matched.push(req);
    else missed.push(req);
  }
  return { value: matched.length / required.length, matched, missed };
}

// ── B-2 ────────────────────────────────────────────────────────────────────

function isAbnormalRequest(raw: string | null | undefined): boolean {
  if (raw == null || raw === "") return false;
  let obj: unknown;
  try {
    obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    // 非 JSON 不算异常（builtin 工具可能传 string）
    return false;
  }
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  // 1) qty 必须 > 0
  if (typeof r.qty === "number" && (Number.isNaN(r.qty) || r.qty <= 0)) return true;
  if (typeof r.quantity === "number" && (Number.isNaN(r.quantity) || r.quantity <= 0))
    return true;
  // 2) price 不允许负
  if (typeof r.price === "number" && (Number.isNaN(r.price) || r.price < 0)) return true;
  // 3) symbol/ticker 字段必须非空字符串
  for (const key of ["symbol", "ticker"]) {
    const v = r[key];
    if (v !== undefined && (typeof v !== "string" || v.trim() === "")) return true;
  }
  // 4) date / asof 字符串必须形如 YYYY-MM-DD（如果存在）
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
  const b1 = metricB1(rows, exp.requiredTools);
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
      failureByKind: b3.byKind,
      repeatedCallTop: b7.top,
    },
  };
}
