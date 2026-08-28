/**
 * 用户行情上下文：手动自选 + 已关联券商的真实持仓。
 *
 * 这是单用户桌面应用的本机配置，故复用 builtin_connector_settings 的单行 JSON，
 * 避免把“用户偏好”伪装成券商数据。券商自选尚无统一 connector 能力时，持仓会
 * 自动并入列表，而用户可独立维护自己的自选。
 */
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { brokerAccount, builtinConnectorSettings } from "../../db/sqlite/schema";
import { brokerGetPositions } from "../execution/broker/broker-service";
import type { BrokerPosition } from "../reia/broker-connector";
import { resolveTickerMarket } from "./resolve-ticker-market";

const SETTINGS_ID = "default";
const WATCHLIST_KEY = "marketWatchlist";
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,23}$/;
const BROKER_POSITION_TIMEOUT_MS = 5_000;

export type MarketWatchlistEntry = {
  symbol: string;
  exchange: string;
  label: string | null;
  sources: Array<"manual" | "broker_position">;
  position: { quantity: number; averagePrice: number; provider: string; accountRef: string } | null;
};

/**
 * IDE 订阅清单只代表用户在本机维护的自选，不会为了读取它而访问券商。
 * 持仓是另一个事实源，仍由 getMarketWatchlist() 在需要时再聚合。
 */
export type IdeMarketSubscription = Pick<
  MarketWatchlistEntry,
  "symbol" | "exchange" | "label"
>;

type StoredWatchlistItem = { symbol: string; exchange?: string; label?: string; createdAt?: string };

function normalizeSymbol(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeExchange(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * 自选允许用户留空市场，而券商持仓也经常只返回 AUTO。订阅前统一规范到
 * 市场解析器的 canonical exchange，保证 BABA/AAPL 等美股不会带着 AUTO
 * 进入推流选择与市场筛选。
 */
export function resolveWatchlistExchange(symbol: string, value: unknown): string {
  const requested = normalizeExchange(value);
  const hintExchange = ["", "AUTO", "UNKNOWN", "UNSPECIFIED"].includes(requested)
    ? undefined
    : requested;
  const resolved = resolveTickerMarket(symbol, { ...(hintExchange ? { hintExchange } : {}) });
  return resolved.exchange !== "UNKNOWN" ? resolved.exchange : requested;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseStoredItems(value: unknown): StoredWatchlistItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: StoredWatchlistItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as StoredWatchlistItem;
    const symbol = normalizeSymbol(item.symbol);
    const exchange = normalizeExchange(item.exchange);
    const key = `${symbol}:${exchange}`;
    if (!SYMBOL_PATTERN.test(symbol) || seen.has(key)) continue;
    seen.add(key);
    items.push({
      symbol,
      exchange,
      label: typeof item.label === "string" && item.label.trim() ? item.label.trim().slice(0, 80) : undefined,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    });
  }
  return items;
}

async function loadStoredConfig(): Promise<Record<string, unknown>> {
  const db = await getDb();
  const row = (
    await db
      .select()
      .from(builtinConnectorSettings)
      .where(eq(builtinConnectorSettings.id, SETTINGS_ID))
      .limit(1)
  )[0];
  const raw = row?.configJson;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

async function saveStoredItems(items: StoredWatchlistItem[]): Promise<void> {
  const db = await getDb();
  const config = await loadStoredConfig();
  config[WATCHLIST_KEY] = items;
  await db
    .insert(builtinConnectorSettings)
    .values({ id: SETTINGS_ID, configJson: config as never, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: builtinConnectorSettings.id,
      set: { configJson: config as never, updatedAt: new Date().toISOString() },
    });
}

/**
 * 读取 IDE 内部订阅清单。它是纯本机配置读取：不调用 broker，也不发起行情请求。
 * Agent 用它理解“我的自选”这一用户范围，再按需要决定是否查券商行情。
 */
export async function getIdeMarketSubscriptions(): Promise<{
  entries: IdeMarketSubscription[];
  source: "ide_local_subscription";
}> {
  const config = await loadStoredConfig();
  const stored = parseStoredItems(config[WATCHLIST_KEY]);
  const entries = stored.map((item) => ({
    symbol: item.symbol,
    exchange: resolveWatchlistExchange(item.symbol, item.exchange),
    label: item.label ?? null,
  }));
  return { entries, source: "ide_local_subscription" };
}

async function brokerPositions(): Promise<{
  positions: Array<BrokerPosition & { provider: string; accountRef: string }>;
  connectedAccounts: number;
  errors: string[];
}> {
  const db = await getDb();
  const accounts = await db
    .select()
    .from(brokerAccount)
    .where(eq(brokerAccount.enabled, true))
    .orderBy(desc(brokerAccount.isDefault), desc(brokerAccount.updatedAt));
  const settled = await Promise.allSettled(
    accounts.map(async (account) => ({
      account,
      positions: await withTimeout(
        brokerGetPositions({ provider: account.provider, accountRef: account.accountRef }),
        BROKER_POSITION_TIMEOUT_MS,
        `Broker ${account.provider} positions`
      ),
    }))
  );
  const positions: Array<BrokerPosition & { provider: string; accountRef: string }> = [];
  const errors: string[] = [];
  for (const row of settled) {
    if (row.status === "fulfilled") {
      positions.push(
        ...row.value.positions.map((position) => ({
          ...position,
          provider: row.value.account.provider,
          accountRef: row.value.account.accountRef,
        }))
      );
    } else {
      errors.push(row.reason instanceof Error ? row.reason.message : String(row.reason));
    }
  }
  return { positions, connectedAccounts: accounts.length, errors };
}

export type MarketWatchlistSnapshot = {
  entries: MarketWatchlistEntry[];
  /** 用户显式维护的自选；不混入券商持仓，删除操作只会作用于这一组。 */
  watchlistEntries: MarketWatchlistEntry[];
  /** 每次读取时从已启用的券商账户拉取的只读持仓。 */
  positionEntries: MarketWatchlistEntry[];
  connectedAccounts: number;
  brokerErrors: string[];
  brokerWatchlistSupported: false;
};

export async function getMarketWatchlist(options?: {
  /** 默认 true（Agent/兼容）；IDE 首屏传 false 跳过券商持仓拉取。 */
  includePositions?: boolean;
}): Promise<MarketWatchlistSnapshot> {
  const includePositions = options?.includePositions !== false;
  const config = await loadStoredConfig();
  const stored = parseStoredItems(config[WATCHLIST_KEY]);
  const watchlistEntries = stored.map((item) => {
    const exchange = resolveWatchlistExchange(item.symbol, item.exchange);
    return {
      symbol: item.symbol,
      exchange,
      label: item.label ?? null,
      sources: ["manual"],
      position: null,
    } satisfies MarketWatchlistEntry;
  });
  if (!includePositions) {
    return {
      entries: watchlistEntries,
      watchlistEntries,
      positionEntries: [],
      connectedAccounts: 0,
      brokerErrors: [],
      brokerWatchlistSupported: false,
    };
  }
  const broker = await brokerPositions();
  const positionEntries = broker.positions
    .filter((position) => {
      const symbol = normalizeSymbol(position.symbol);
      return SYMBOL_PATTERN.test(symbol) && Number.isFinite(position.qty) && position.qty !== 0;
    })
    .map((position) => {
      const symbol = normalizeSymbol(position.symbol);
      return {
        symbol,
        exchange: resolveWatchlistExchange(symbol, position.market),
        label: null,
        sources: ["broker_position"],
        position: {
          quantity: position.qty,
          averagePrice: position.avgPrice,
          provider: position.provider,
          accountRef: position.accountRef,
        },
      } satisfies MarketWatchlistEntry;
    })
    .sort(
      (left, right) =>
        left.symbol.localeCompare(right.symbol) ||
        (left.position?.accountRef ?? "").localeCompare(right.position?.accountRef ?? "")
    );

  // 保留原先合并列表，供尚未迁移的消费者继续使用；新界面使用上面的两组明确数据。
  const merged = new Map<string, MarketWatchlistEntry>();
  for (const entry of watchlistEntries) {
    merged.set(`${entry.symbol}:${entry.exchange}`, { ...entry });
  }
  for (const entry of positionEntries) {
    const key = `${entry.symbol}:${entry.exchange}`;
    const existing = merged.get(key);
    if (existing) {
      existing.sources = [...new Set([...existing.sources, "broker_position"])];
      existing.position = entry.position;
    } else {
      merged.set(key, { ...entry });
    }
  }
  return {
    entries: [...merged.values()].sort((a, b) => Number(Boolean(b.position)) - Number(Boolean(a.position)) || a.symbol.localeCompare(b.symbol)),
    watchlistEntries,
    positionEntries,
    connectedAccounts: broker.connectedAccounts,
    brokerErrors: broker.errors,
    brokerWatchlistSupported: false,
  };
}

export async function addMarketWatchlistItem(input: { symbol: string; exchange?: string; label?: string }) {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = resolveWatchlistExchange(symbol, input.exchange);
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error("invalid_symbol");
  const config = await loadStoredConfig();
  const items = parseStoredItems(config[WATCHLIST_KEY]);
  const exists = items.some(
    (item) => item.symbol === symbol && resolveWatchlistExchange(item.symbol, item.exchange) === exchange
  );
  if (!exists) {
    items.push({ symbol, exchange, label: input.label?.trim().slice(0, 80) || undefined, createdAt: new Date().toISOString() });
    await saveStoredItems(items);
  }
  return getMarketWatchlist({ includePositions: false });
}

export async function removeMarketWatchlistItem(input: { symbol: string; exchange?: string }) {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = resolveWatchlistExchange(symbol, input.exchange);
  const config = await loadStoredConfig();
  const items = parseStoredItems(config[WATCHLIST_KEY]);
  await saveStoredItems(
    items.filter(
      (item) =>
        !(item.symbol === symbol && resolveWatchlistExchange(item.symbol, item.exchange) === exchange)
    )
  );
  return getMarketWatchlist({ includePositions: false });
}
