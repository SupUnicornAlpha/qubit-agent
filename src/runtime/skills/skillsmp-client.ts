/**
 * SkillsMP REST API — keyword search (anonymous or API key).
 * @see https://skillsmp.com/docs/api
 */
import type { OpenSkillMarketEntry, SkillMarketPageResult } from "./open-skill-market-registry";

const SKILLSMP_SEARCH_URL = "https://skillsmp.com/api/v1/skills/search";
const MAX_ID_CACHE = 12_000;

const skillsMpById = new Map<string, OpenSkillMarketEntry>();

function envSkillsMpApiKey(): string | undefined {
  const k = process.env.SKILLSMP_API_KEY?.trim();
  return k || undefined;
}

function trimIdCache(): void {
  if (skillsMpById.size <= MAX_ID_CACHE) return;
  const entries = [...skillsMpById.entries()].slice(-Math.floor(MAX_ID_CACHE / 2));
  skillsMpById.clear();
  for (const [k, v] of entries) {
    skillsMpById.set(k, v);
  }
}

export function rememberSkillsMpEntries(entries: OpenSkillMarketEntry[]): void {
  for (const e of entries) {
    if (e?.id) skillsMpById.set(e.id, e);
  }
  trimIdCache();
}

export function getSkillsMpEntry(id: string): OpenSkillMarketEntry | undefined {
  return skillsMpById.get(id);
}

export function getSkillsMpCacheSize(): number {
  return skillsMpById.size;
}

function mapRow(row: Record<string, unknown>): OpenSkillMarketEntry | null {
  const id = typeof row.id === "string" ? row.id : "";
  const name = typeof row.name === "string" ? row.name : "";
  if (!id || !name) return null;
  const description = typeof row.description === "string" ? row.description : "";
  const author = typeof row.author === "string" ? row.author : "";
  const githubUrl = typeof row.githubUrl === "string" ? row.githubUrl : "";
  const skillUrl = typeof row.skillUrl === "string" ? row.skillUrl : "";
  /*
   * SkillsMP 直接返回 GitHub stars 和 updatedAt（Unix 秒字符串）。
   * 之前的 mapRow 只取了 url/author，把这两个有信息量的字段丢掉了 →
   * 前端无法显示 stars，也无法做"按 stars 排序"这种常用筛选。
   */
  const starsNum =
    typeof row.stars === "number"
      ? row.stars
      : typeof row.stars === "string" && row.stars.trim() !== ""
        ? Number(row.stars)
        : undefined;
  const stars = typeof starsNum === "number" && Number.isFinite(starsNum) ? starsNum : undefined;
  const updatedAt =
    typeof row.updatedAt === "string" || typeof row.updatedAt === "number" ? row.updatedAt : undefined;
  const compatibility: Record<string, unknown> = { skillsmp: true };
  if (skillUrl) compatibility.skillUrl = skillUrl;
  if (githubUrl) compatibility.githubUrl = githubUrl;
  return {
    id,
    name,
    description,
    ...(author ? { author } : {}),
    ...(githubUrl ? { repo: githubUrl } : {}),
    ...(stars !== undefined ? { stars } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    compatibility,
  };
}

export async function searchSkillsMpPaginated(input: {
  q: string;
  page?: number;
  pageSize?: number;
  apiKey?: string;
}): Promise<SkillMarketPageResult> {
  const query = input.q.trim() || "skill";
  const pageSize = Math.min(Math.max(input.pageSize ?? 24, 1), 100);
  const page = Math.max(input.page ?? 1, 1);
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("page", String(page));
  params.set("limit", String(pageSize));
  params.set("sortBy", "stars");
  const key = input.apiKey?.trim() || envSkillsMpApiKey();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "qubit-agent/skillsmp-client",
  };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${SKILLSMP_SEARCH_URL}?${params.toString()}`, { headers });
  if (!res.ok) {
    throw new Error(`SkillsMP search HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    success?: boolean;
    data?: {
      skills?: unknown[];
      pagination?: {
        page?: number;
        limit?: number;
        total?: number;
        totalPages?: number;
      };
    };
    error?: { message?: string };
  };
  if (!json.success) {
    throw new Error(json.error?.message ?? "SkillsMP search failed");
  }
  const raw = json.data?.skills ?? [];
  const out: OpenSkillMarketEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const mapped = mapRow(row as Record<string, unknown>);
    if (mapped) out.push(mapped);
  }
  rememberSkillsMpEntries(out);
  const pag = json.data?.pagination;
  const total = typeof pag?.total === "number" ? pag.total : out.length;
  const apiPage = typeof pag?.page === "number" ? pag.page : page;
  const apiPageSize = typeof pag?.limit === "number" ? pag.limit : pageSize;
  const totalPages =
    typeof pag?.totalPages === "number" && pag.totalPages > 0
      ? pag.totalPages
      : Math.max(1, Math.ceil(total / apiPageSize));
  return {
    items: out,
    total,
    page: apiPage,
    pageSize: apiPageSize,
    totalPages,
  };
}

export async function searchSkillsMp(
  q: string,
  limit: number,
  apiKey?: string
): Promise<OpenSkillMarketEntry[]> {
  const { items } = await searchSkillsMpPaginated({
    q,
    page: 1,
    pageSize: limit,
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
  return items;
}

/** Resolve a skill id for install: cache → search by id string. */
export async function resolveSkillsMpEntryForInstall(
  id: string,
  apiKey?: string
): Promise<OpenSkillMarketEntry | undefined> {
  const cached = getSkillsMpEntry(id);
  if (cached) return cached;
  const rows = await searchSkillsMp(id, 40, apiKey);
  return rows.find((r) => r.id === id);
}
