/**
 * Self-Evolving Agent P7 — 3 路 detector。
 *
 * 设计原则：
 *   - detector 不写任何表，只返回 GapSignal[]；落库由 ToolGapWatcher 统一处理。
 *   - 规则尽量保守：宁可漏（漏掉的下次跑批会重扫）也不要把"agent 正常参数错"误识别为 gap。
 *   - 三路 detector 都按 project 过滤 + 时间窗口（默认最近 24h）。
 */

import { and, between, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentInstance,
  agentStep,
  experience as experienceTable,
  toolCallLog,
  workflowRun,
} from "../../db/sqlite/schema";
import {
  makeConceptSignature,
  makeMcpSignature,
  makeToolSignature,
} from "./signature";
import type { GapSignal, DetectorResult } from "./types";

// ─────────── 命中模式（unknown_tool） ───────────
// errorMessage / errorSource 中出现以下文字片段 → unknown_tool。
// 保留中英 + parseJSON / args invalid 类，因为 LLM 输出格式问题最终也会被 agent 视作"工具不可用"。
const UNKNOWN_TOOL_PATTERNS = [
  /unknown\s+tool/i,
  /tool\s+not\s+found/i,
  /no\s+such\s+tool/i,
  /tool\s+["'`]?[\w\-./]+["'`]?\s+is\s+not\s+registered/i,
  /unregistered\s+tool/i,
  /找不到.*?工具/,
  /未知.*?工具/,
  /工具.*?不存在/,
  /不支持.*?工具/,
];

const PARSE_RETRY_PATTERNS = [
  /failed\s+to\s+parse\s+(tool\s+)?(arguments|args)/i,
  /invalid\s+(tool\s+)?(arguments|args)/i,
  /could\s+not\s+parse\s+tool/i,
  /JSON\s*decode.*?(arguments|args|tool)/i,
];

// ─────────── 命中模式（reflective_mention） ───────────
// "需要 / 缺少 / 没有 / want / need + 工具/tool/能力" 触发；只取前 200 字摘要 + 关键词作 signature。
const MENTION_REGEXES = [
  /(?:需要|想要|缺(?:少|了)?|没有|缺乏)[^。.\n]{0,40}?(?:工具|能力|API|tool)[^。.\n]{0,40}/g,
  /\b(?:need|want|missing|lack(?:ing)?)\b[^.\n]{0,40}?\b(tool|api|capability|integration)\b[^.\n]{0,40}/gi,
];

const STOP_KEYWORDS = new Set([
  "the","a","an","of","to","for","is","are","was","were","be","been","with","that","this",
  "工具","能力","api","need","want","missing","tool","integration","capability",
]);

interface DetectorOptions {
  projectId: string;
  /** 扫描窗口起点 ISO；默认 24h 前 */
  fromTs: string;
  /** 扫描窗口结束 ISO；默认 now */
  toTs: string;
  /** 单 detector 最多产 N 条 signal（防爆）；默认 500 */
  maxSignals?: number;
  /** repeated_fail 阈值：同 toolName 在窗口内 ≥ 该值 + 同 errorMessage 模式 */
  repeatedFailThreshold?: number;
}

// ───────────────────────────── unknown_tool ─────────────────────────────
// 拉 tool_call_log status='error'，匹配上面正则 → 一条 signal
export async function detectUnknownTool(opts: DetectorOptions): Promise<DetectorResult> {
  const max = opts.maxSignals ?? 500;
  const db = await getDb();

  const rows = await db
    .select({
      id: toolCallLog.id,
      toolName: toolCallLog.toolName,
      toolKind: toolCallLog.toolKind,
      errorMessage: toolCallLog.errorMessage,
      responseJson: toolCallLog.responseJson,
      requestJson: toolCallLog.requestJson,
      createdAt: toolCallLog.createdAt,
      workflowRunId: toolCallLog.workflowRunId,
      agentStepId: toolCallLog.agentStepId,
    })
    .from(toolCallLog)
    .innerJoin(workflowRun, eq(toolCallLog.workflowRunId, workflowRun.id))
    .where(
      and(
        eq(workflowRun.projectId, opts.projectId),
        eq(toolCallLog.status, "error"),
        between(toolCallLog.createdAt, opts.fromTs, opts.toTs)
      )
    )
    .limit(max * 4); // worst case 留余量给规则过滤

  const definitionIds = await loadDefinitionMap(rows.map((r) => r.agentStepId).filter(Boolean));

  const signals: GapSignal[] = [];
  for (const r of rows) {
    if (signals.length >= max) break;
    const msg = combineErrorMessage(r.errorMessage, r.responseJson);
    if (!isUnknownTool(msg)) continue;
    const sig = computeSignature(r);
    if (!sig) continue;
    signals.push({
      kind: "unknown_tool",
      signature: sig,
      projectId: opts.projectId,
      workflowRunId: r.workflowRunId ?? null,
      definitionId: definitionIds.get(r.agentStepId) ?? null,
      requestedToolName: r.toolName,
      requestedToolKind: r.toolKind,
      excerpt: msg.slice(0, 240),
      sourceToolCallId: r.id,
      occurredAt: r.createdAt,
      metadata: { errorMessage: r.errorMessage ?? null },
    });
  }
  return { kind: "unknown_tool", scannedRows: rows.length, signals };
}

// ───────────────────────────── repeated_fail ─────────────────────────────
// 同 toolName 在窗口内 status='error' 次数 ≥ 阈值（默认 3）
// 注意：unknown_tool 已经覆盖的 toolName 会再次命中——这里不去重，由 watcher 合流时
// 按 signature 折叠，最后只剩一条 gap row。
export async function detectRepeatedFail(opts: DetectorOptions): Promise<DetectorResult> {
  const threshold = opts.repeatedFailThreshold ?? 3;
  const max = opts.maxSignals ?? 500;
  const db = await getDb();

  // 按 toolName + toolKind 聚合 error 次数
  const agg = await db
    .select({
      toolName: toolCallLog.toolName,
      toolKind: toolCallLog.toolKind,
      cnt: sql<number>`COUNT(*)`.as("cnt"),
    })
    .from(toolCallLog)
    .innerJoin(workflowRun, eq(toolCallLog.workflowRunId, workflowRun.id))
    .where(
      and(
        eq(workflowRun.projectId, opts.projectId),
        eq(toolCallLog.status, "error"),
        between(toolCallLog.createdAt, opts.fromTs, opts.toTs)
      )
    )
    .groupBy(toolCallLog.toolName, toolCallLog.toolKind)
    .all();

  const hotTools = agg.filter((a) => a.cnt >= threshold).slice(0, max);
  if (hotTools.length === 0) {
    return { kind: "repeated_fail", scannedRows: agg.length, signals: [] };
  }

  // 给每个 hot tool 拉最新一条具体记录做代表（excerpt / workflow_run / def）
  const signals: GapSignal[] = [];
  for (const h of hotTools) {
    const sample = (
      await db
        .select({
          id: toolCallLog.id,
          toolName: toolCallLog.toolName,
          toolKind: toolCallLog.toolKind,
          errorMessage: toolCallLog.errorMessage,
          responseJson: toolCallLog.responseJson,
          requestJson: toolCallLog.requestJson,
          createdAt: toolCallLog.createdAt,
          workflowRunId: toolCallLog.workflowRunId,
          agentStepId: toolCallLog.agentStepId,
        })
        .from(toolCallLog)
        .innerJoin(workflowRun, eq(toolCallLog.workflowRunId, workflowRun.id))
        .where(
          and(
            eq(workflowRun.projectId, opts.projectId),
            eq(toolCallLog.toolName, h.toolName),
            eq(toolCallLog.status, "error"),
            between(toolCallLog.createdAt, opts.fromTs, opts.toTs)
          )
        )
        .orderBy(sql`${toolCallLog.createdAt} DESC`)
        .limit(1)
    )[0];
    if (!sample) continue;
    const defMap = await loadDefinitionMap([sample.agentStepId]);
    const sig = computeSignature(sample);
    if (!sig) continue;
    const msg = combineErrorMessage(sample.errorMessage, sample.responseJson);
    signals.push({
      kind: "repeated_fail",
      signature: sig,
      projectId: opts.projectId,
      workflowRunId: sample.workflowRunId ?? null,
      definitionId: defMap.get(sample.agentStepId) ?? null,
      requestedToolName: sample.toolName,
      requestedToolKind: sample.toolKind,
      excerpt: `${h.cnt}× errors in window | latest: ${msg.slice(0, 200)}`,
      sourceToolCallId: sample.id,
      occurredAt: sample.createdAt,
      metadata: { failCount: h.cnt, threshold },
    });
  }
  return { kind: "repeated_fail", scannedRows: agg.length, signals };
}

// ───────────────────────────── reflective_mention ─────────────────────────────
export async function detectReflectiveMention(opts: DetectorOptions): Promise<DetectorResult> {
  const max = opts.maxSignals ?? 500;
  const db = await getDb();

  const rows = await db
    .select({
      id: experienceTable.id,
      contentJson: experienceTable.contentJson,
      createdAt: experienceTable.createdAt,
    })
    .from(experienceTable)
    .where(
      and(
        eq(experienceTable.scope, "project"),
        eq(experienceTable.scopeId, opts.projectId),
        eq(experienceTable.kind, "reflective"),
        between(experienceTable.createdAt, opts.fromTs, opts.toTs)
      )
    )
    .limit(max * 4);

  const signals: GapSignal[] = [];
  for (const r of rows) {
    if (signals.length >= max) break;
    const c = (r.contentJson ?? {}) as Record<string, unknown>;
    const body = `${c.summary ?? ""}\n${c.body ?? ""}`.toString();
    if (!body.trim()) continue;
    for (const re of MENTION_REGEXES) {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(body)) !== null) {
        const excerpt = m[0]?.trim() ?? "";
        if (!excerpt) continue;
        const keyword = pickConceptKeyword(excerpt);
        if (!keyword) continue;
        signals.push({
          kind: "reflective_mention",
          signature: makeConceptSignature(keyword),
          projectId: opts.projectId,
          excerpt: excerpt.slice(0, 240),
          sourceExperienceId: r.id,
          occurredAt: r.createdAt,
        });
        if (signals.length >= max) break;
      }
      if (signals.length >= max) break;
    }
  }
  return { kind: "reflective_mention", scannedRows: rows.length, signals };
}

// ───────── helpers ─────────

function combineErrorMessage(msg: string | null | undefined, resp: unknown): string {
  const parts: string[] = [];
  if (msg) parts.push(msg);
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    if (typeof r.errorMessage === "string") parts.push(r.errorMessage);
  }
  return parts.join(" | ");
}

function isUnknownTool(msg: string): boolean {
  if (!msg) return false;
  if (UNKNOWN_TOOL_PATTERNS.some((re) => re.test(msg))) return true;
  if (PARSE_RETRY_PATTERNS.some((re) => re.test(msg))) return true;
  return false;
}

interface MinimalLogRow {
  toolName: string;
  toolKind: string;
  requestJson: unknown;
}

function computeSignature(r: MinimalLogRow): string | null {
  if (!r.toolName) return null;
  if (r.toolKind === "mcp") {
    // requestJson.mcp = { serverName, toolName, arguments }
    const req = (r.requestJson ?? {}) as Record<string, unknown>;
    const mcp = req.mcp as Record<string, unknown> | undefined;
    if (mcp && typeof mcp.serverName === "string" && typeof mcp.toolName === "string") {
      return makeMcpSignature(mcp.serverName, mcp.toolName);
    }
  }
  return makeToolSignature(r.toolName);
}

function pickConceptKeyword(excerpt: string): string | null {
  // 简单：取 excerpt 里去停用词后最长的一个 ascii 词或 2-4 字中文片段；不做花哨 NLP
  const ascii = excerpt
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{2,}/g)
    ?.filter((w) => !STOP_KEYWORDS.has(w))
    .sort((a, b) => b.length - a.length);
  if (ascii && ascii[0]) return ascii[0];
  const cn = excerpt.match(/[\u4e00-\u9fff]{2,6}/g)?.filter((w) => !STOP_KEYWORDS.has(w));
  if (cn && cn[0]) return cn[0];
  return null;
}

/** agentStepId → definitionId（一次性 join，避免 N+1） */
async function loadDefinitionMap(stepIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const cleaned = [...new Set(stepIds.filter((s): s is string => Boolean(s)))];
  if (cleaned.length === 0) return new Map();
  const db = await getDb();
  const rows = await db
    .select({
      stepId: agentStep.id,
      definitionId: agentInstance.definitionId,
    })
    .from(agentStep)
    .innerJoin(agentInstance, eq(agentStep.agentInstanceId, agentInstance.id))
    .where(inArray(agentStep.id, cleaned));
  return new Map(rows.map((r) => [r.stepId, r.definitionId]));
}
