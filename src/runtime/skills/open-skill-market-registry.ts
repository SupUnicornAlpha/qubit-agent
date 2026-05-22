/**
 * Client for the Open Skill Market compact registry (GitHub-hosted JSON).
 * @see https://github.com/coolzwc/open-skill-market
 */

export const DEFAULT_OPEN_SKILL_MARKET_BASE =
  "https://raw.githubusercontent.com/coolzwc/open-skill-market/main/market";

export type OpenSkillMarketMeta = {
  generatedAt?: string;
  totalSkills?: number;
  apiVersion?: string;
  compact?: boolean;
  chunks?: string[];
  rateLimited?: boolean;
  timedOut?: boolean;
  [key: string]: unknown;
};

export type OpenSkillMarketRepository = {
  url?: string;
  branch?: string;
  stars?: number;
  forks?: number;
  lastUpdated?: string | null;
};

export type OpenSkillMarketEntry = {
  id: string;
  name: string;
  description: string;
  categories?: string[];
  author?: string;
  repo?: string;
  path?: string;
  commitHash?: string;
  files?: string[];
  version?: string;
  tags?: string[];
  compatibility?: Record<string, unknown>;
  /**
   * GitHub stars。SkillsMP 的 API 直接返回；
   * Open Skill Market 的 compact JSON 把 stars 放在 `repositories[repo]` 里，
   * 我们在 `loadOpenSkillMarketRegistry` 末尾回填到每个 entry，方便前端直接按 stars 排序/展示。
   */
  stars?: number;
  /** ISO 字符串或 Unix 秒/毫秒（取决于上游 API） */
  updatedAt?: string | number;
};

type RegistryPayload = {
  meta?: OpenSkillMarketMeta;
  repositories?: Record<string, OpenSkillMarketRepository>;
  skills?: OpenSkillMarketEntry[];
};

const CACHE_TTL_MS = 45 * 60 * 1000;
const FETCH_TIMEOUT_MS = 120_000;

let cache: {
  baseUrl: string;
  loadedAt: number;
  meta: OpenSkillMarketMeta;
  repositories: Record<string, OpenSkillMarketRepository>;
  skills: OpenSkillMarketEntry[];
  byId: Map<string, OpenSkillMarketEntry>;
} | null = null;

let loadPromise: Promise<void> | null = null;

function mergeRepositories(
  a: Record<string, OpenSkillMarketRepository>,
  b: Record<string, OpenSkillMarketRepository> | undefined
): Record<string, OpenSkillMarketRepository> {
  if (!b) return a;
  return { ...a, ...b };
}

function dedupeSkills(skills: OpenSkillMarketEntry[]): OpenSkillMarketEntry[] {
  const map = new Map<string, OpenSkillMarketEntry>();
  for (const s of skills) {
    if (s?.id && typeof s.id === "string") map.set(s.id, s);
  }
  return [...map.values()];
}

async function fetchJson(url: string): Promise<RegistryPayload> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "qubit-agent/open-skill-market-registry",
      },
    });
    if (!res.ok) throw new Error(`open skill market fetch failed ${res.status}: ${url}`);
    return (await res.json()) as RegistryPayload;
  } finally {
    clearTimeout(t);
  }
}

export async function loadOpenSkillMarketRegistry(
  baseUrl = DEFAULT_OPEN_SKILL_MARKET_BASE
): Promise<void> {
  const root = await fetchJson(`${baseUrl.replace(/\/$/, "")}/skills.json`);
  const meta = root.meta ?? {};
  const chunks = Array.isArray(meta.chunks)
    ? meta.chunks.filter((x): x is string => typeof x === "string")
    : [];

  let repositories: Record<string, OpenSkillMarketRepository> = { ...(root.repositories ?? {}) };
  let skills: OpenSkillMarketEntry[] = [...(root.skills ?? [])];

  for (const chunk of chunks) {
    const chunkUrl = `${baseUrl.replace(/\/$/, "")}/${chunk}`;
    const part = await fetchJson(chunkUrl);
    repositories = mergeRepositories(repositories, part.repositories ?? {});
    skills = skills.concat(part.skills ?? []);
  }

  skills = dedupeSkills(skills);
  /*
   * Open Skill Market 的 compact JSON 把 GitHub 元数据（stars/forks/lastUpdated）放在
   * 顶层 `repositories[repo]` 里，每条 skill 只引用了 repo URL。这里做一次扁平化回填，
   * 让前端无须再拿 repositories map 做二次 join。
   */
  for (const s of skills) {
    if (s.stars !== undefined) continue;
    const meta = s.repo ? repositories[s.repo] : undefined;
    if (!meta) continue;
    if (typeof meta.stars === "number") s.stars = meta.stars;
    if (meta.lastUpdated) s.updatedAt = meta.lastUpdated;
  }
  const byId = new Map(skills.map((s) => [s.id, s]));

  cache = {
    baseUrl: baseUrl.replace(/\/$/, ""),
    loadedAt: Date.now(),
    meta,
    repositories,
    skills,
    byId,
  };
}

export function getOpenSkillMarketCacheSnapshot(): {
  loaded: boolean;
  loadedAt: number | null;
  skillCount: number;
  meta: OpenSkillMarketMeta | null;
  baseUrl: string | null;
} {
  if (!cache) {
    return { loaded: false, loadedAt: null, skillCount: 0, meta: null, baseUrl: null };
  }
  return {
    loaded: true,
    loadedAt: cache.loadedAt,
    skillCount: cache.skills.length,
    meta: cache.meta,
    baseUrl: cache.baseUrl,
  };
}

export async function ensureOpenSkillMarketLoaded(
  baseUrl = DEFAULT_OPEN_SKILL_MARKET_BASE
): Promise<void> {
  const now = Date.now();
  if (
    cache &&
    cache.baseUrl === baseUrl.replace(/\/$/, "") &&
    now - cache.loadedAt < CACHE_TTL_MS
  ) {
    return;
  }
  if (loadPromise) {
    await loadPromise;
    return;
  }
  loadPromise = (async () => {
    try {
      await loadOpenSkillMarketRegistry(baseUrl);
    } finally {
      loadPromise = null;
    }
  })();
  await loadPromise;
}

export type SkillMarketPageResult = {
  items: OpenSkillMarketEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

function filterOpenSkillMarketPool(q: string): OpenSkillMarketEntry[] {
  if (!cache) return [];
  const needle = q.trim().toLowerCase();
  if (!needle) return cache.skills;
  return cache.skills.filter((s) => {
    const hay = [
      s.id,
      s.name,
      s.description,
      ...(s.categories ?? []),
      ...(s.tags ?? []),
      s.repo ?? "",
      s.author ?? "",
    ]
      .join("\n")
      .toLowerCase();
    return hay.includes(needle);
  });
}

export function searchOpenSkillMarketEntriesPaginated(
  q: string,
  page = 1,
  pageSize = 24
): SkillMarketPageResult {
  const pool = filterOpenSkillMarketPool(q);
  const ps = Math.min(Math.max(pageSize, 1), 100);
  const total = pool.length;
  const totalPages = Math.max(1, Math.ceil(total / ps));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const offset = (safePage - 1) * ps;
  return {
    items: pool.slice(offset, offset + ps),
    total,
    page: safePage,
    pageSize: ps,
    totalPages,
  };
}

export function getOpenSkillMarketEntry(id: string): OpenSkillMarketEntry | undefined {
  return cache?.byId.get(id);
}

export function listOpenSkillRepositories(): Record<string, OpenSkillMarketRepository> {
  return cache?.repositories ?? {};
}
