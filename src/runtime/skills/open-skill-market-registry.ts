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

/** @deprecated Prefer searchOpenSkillMarketEntriesPaginated */
export function searchOpenSkillMarketEntries(q: string, limit: number): OpenSkillMarketEntry[] {
  return searchOpenSkillMarketEntriesPaginated(q, 1, limit).items;
}

export function getOpenSkillMarketEntry(id: string): OpenSkillMarketEntry | undefined {
  return cache?.byId.get(id);
}

export function listOpenSkillRepositories(): Record<string, OpenSkillMarketRepository> {
  return cache?.repositories ?? {};
}
