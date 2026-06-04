/**
 * Candidate matcher —— 给 tool_gap_log 的 gap_signature 在
 * `mcp_catalog`（builtin/registry/fsi 合表）里找候选。
 *
 * 设计原则：
 *   - 纯函数，所有 IO 显式注入（便于单测）
 *   - 评分规则确定性、可解释（每一分都有一条 ruleHit 文字）
 *   - 评分 cap 在 1.0；阈值 < 0.3 视为"无候选"
 *
 * Schema 收敛 C4（migration 0071）：原 `mcp_catalog_item` 已并入 `mcp_catalog`，
 * 用 `source` 字段区分 'builtin' / 'registry' / 'fsi'，candidate.source 透传给
 * installer 决定走 install_mcp_catalog 还是 install_mcp_external。
 *
 * 文档：docs/SELF_EVOLVING_AGENT_DESIGN.md §6.6
 */

import { eq } from "drizzle-orm";

import { getDb } from "../../db/sqlite/client.js";
import { mcpCatalog } from "../../db/sqlite/schema.js";

import type { CatalogSource, MatchCandidate, ProposalSafetyLevel } from "./types.js";

export interface ParsedSignature {
  kind: "tool" | "mcp" | "concept" | "unknown";
  /** server 部分（仅 mcp:） */
  server?: string;
  /** tool 部分（tool: / mcp:） */
  tool?: string;
  /** keyword（仅 concept:） */
  keyword?: string;
  /** 拆出来的 token，用来跑 description / capabilities 命中 */
  tokens: string[];
}

const MIN_TOKEN_LEN = 3;
const SCORE_CAP = 1.0;
const SCORE_FLOOR = 0.3;
const MAX_DESC_HITS = 3;

function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= MIN_TOKEN_LEN);
}

export function parseGapSignature(signature: string): ParsedSignature {
  const idx = signature.indexOf(":");
  if (idx <= 0) return { kind: "unknown", tokens: tokenize(signature) };
  const ns = signature.slice(0, idx);
  const body = signature.slice(idx + 1);

  if (ns === "tool") {
    return { kind: "tool", tool: body, tokens: tokenize(body) };
  }
  if (ns === "mcp") {
    const slash = body.indexOf("/");
    if (slash <= 0) {
      return { kind: "mcp", server: body, tokens: tokenize(body) };
    }
    const server = body.slice(0, slash);
    const tool = body.slice(slash + 1);
    return {
      kind: "mcp",
      server,
      tool,
      tokens: [...tokenize(server), ...tokenize(tool)],
    };
  }
  if (ns === "concept") {
    return { kind: "concept", keyword: body, tokens: tokenize(body) };
  }
  return { kind: "unknown", tokens: tokenize(body) };
}

interface CatalogRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  riskLevel: ProposalSafetyLevel;
  transport: "stdio" | "http" | "ws";
  source: CatalogSource;
  command: string | null;
  url: string | null;
  defaultToolName: string;
  capabilities: string[];
  enabled: boolean;
}

function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function normalizeSource(value: unknown): CatalogSource {
  return value === "registry" || value === "fsi" ? value : "builtin";
}

function scoreCatalog(row: CatalogRow, parsed: ParsedSignature): { score: number; hits: string[] } {
  const hits: string[] = [];
  let score = 0;

  // 1. exact tool 命中
  const toolBody = parsed.tool ?? "";
  if (toolBody && row.defaultToolName && row.defaultToolName === toolBody) {
    score += 0.7;
    hits.push(`exact_tool:${row.defaultToolName}`);
  }

  // 2. slug 完全命中（server 或 tool 等于 slug）
  if (parsed.server && row.slug === parsed.server) {
    score += 0.4;
    hits.push(`exact_slug:${row.slug}`);
  } else if (parsed.tool && row.slug === parsed.tool) {
    score += 0.3;
    hits.push(`tool_eq_slug:${row.slug}`);
  } else if (
    parsed.server &&
    (row.slug.includes(parsed.server) || parsed.server.includes(row.slug))
  ) {
    score += 0.2;
    hits.push(`slug_partial:${row.slug}`);
  }

  // 3. name / description token 命中（concept / reflective 主要靠这条）
  const tokens = parsed.tokens;
  if (tokens.length > 0) {
    const haystack = `${row.name} ${row.description}`.toLowerCase();
    const matched = tokens.filter((t) => haystack.includes(t));
    if (matched.length > 0) {
      const inc = Math.min(MAX_DESC_HITS, matched.length) * 0.15;
      score += inc;
      hits.push(`desc_hits:${matched.join(",")}`);
    }

    const capStr = row.capabilities.join(" ").toLowerCase();
    const capMatched = tokens.filter((t) => capStr.includes(t));
    if (capMatched.length > 0) {
      score += 0.1;
      hits.push(`cap_hits:${capMatched.join(",")}`);
    }
  }

  return { score: Math.min(SCORE_CAP, score), hits };
}

function catalogRowToCandidate(
  row: CatalogRow,
  s: ReturnType<typeof scoreCatalog>
): MatchCandidate {
  return {
    targetKind: "mcp_catalog",
    targetId: row.id,
    targetSlug: row.slug,
    source: row.source,
    name: row.name,
    description: row.description,
    safetyLevel: row.riskLevel,
    score: Number(s.score.toFixed(3)),
    ruleHits: s.hits,
    toolName: row.defaultToolName || null,
    payload: {
      transport: row.transport,
      command: row.command,
      url: row.url,
      defaultToolName: row.defaultToolName,
      capabilities: row.capabilities,
    },
  };
}

export interface MatchOptions {
  topK?: number;
  /** matchScore < threshold 视为 "无候选" */
  scoreThreshold?: number;
}

/**
 * 给一个 gap_signature 找候选，返回 score 降序的 top-K。
 *
 * 注意：candidate-matcher 不做 propose 写入，只返回打分结果；写入由 worker 处理。
 */
export async function findCandidatesForGap(
  signature: string,
  options: MatchOptions = {}
): Promise<MatchCandidate[]> {
  const topK = options.topK ?? 3;
  const threshold = options.scoreThreshold ?? SCORE_FLOOR;
  const parsed = parseGapSignature(signature);
  if (parsed.kind === "unknown" && parsed.tokens.length === 0) return [];

  const db = await getDb();
  const catalogs = await db.select().from(mcpCatalog).where(eq(mcpCatalog.enabled, true)).all();

  const candidates: MatchCandidate[] = [];

  for (const c of catalogs) {
    const row: CatalogRow = {
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description ?? "",
      riskLevel: c.riskLevel as ProposalSafetyLevel,
      transport: c.transport,
      source: normalizeSource(c.source),
      command: c.command,
      url: c.url,
      defaultToolName: c.defaultToolName ?? "",
      capabilities: asStrArray(c.defaultCapabilitiesJson),
      enabled: c.enabled,
    };
    const s = scoreCatalog(row, parsed);
    if (s.score >= threshold) candidates.push(catalogRowToCandidate(row, s));
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topK);
}

export { scoreCatalog };

/** 给单测使用 —— 不走 db */
export function _scoreCatalogForTest(
  row: {
    id: string;
    slug: string;
    name: string;
    description?: string;
    riskLevel?: ProposalSafetyLevel;
    transport?: "stdio" | "http" | "ws";
    defaultToolName?: string;
    capabilities?: string[];
    source?: CatalogSource;
  },
  signature: string
): { score: number; hits: string[] } {
  return scoreCatalog(
    {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description ?? "",
      riskLevel: row.riskLevel ?? "medium",
      transport: row.transport ?? "stdio",
      source: row.source ?? "builtin",
      command: null,
      url: null,
      defaultToolName: row.defaultToolName ?? "",
      capabilities: row.capabilities ?? [],
      enabled: true,
    },
    parseGapSignature(signature)
  );
}
