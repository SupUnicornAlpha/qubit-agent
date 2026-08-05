/**
 * Futu OpenD runtime — wire configured broker_account to trade HTTP + quote WS bridges.
 *
 * Trading:  python_connectors/broker_http_server.py  (default :18765)
 * Quotes:   python_connectors/market_bridge.server --provider futu  (default :8765)
 *
 * OpenD host/port come from the enabled futu broker_account.providerConfigJson
 * (same fields as BrokerAccountsPanel). Starting the quote bridge sets
 * QUBIT_FUTU_MARKET_WS_URL so market-stream-gateway picks it up.
 */

import { join } from "node:path";
import { getDb } from "../../db/sqlite/client";
import { brokerAccount } from "../../db/sqlite/schema";
import type { FutuProviderConfig } from "../../types/broker";
import { and, desc, eq } from "drizzle-orm";
import { getPythonConnectorsDir } from "../app-paths";
import { getPythonBin } from "../sandbox/python-runtime";

export const FUTU_DEFAULT_TRADE_BASE_URL = "http://127.0.0.1:18765";
export const FUTU_DEFAULT_QUOTE_WS_URL = "ws://127.0.0.1:8765";
export const FUTU_DEFAULT_TRADE_PORT = 18765;
export const FUTU_DEFAULT_QUOTE_PORT = 8765;

export type FutuOpenDConfig = {
  opendHost: string;
  opendPort: number;
  market?: "HK" | "US" | "CN";
  accId?: string;
  accountRef: string;
  mode: "mock" | "sandbox" | "live";
  baseUrl: string | null;
};

export type FutuBridgeProcessStatus = {
  running: boolean;
  pid: number | null;
  url: string;
  lastError: string | null;
  startedAt: string | null;
};

export type FutuRuntimeStatus = {
  configured: boolean;
  openD: FutuOpenDConfig | null;
  trade: FutuBridgeProcessStatus & { healthy: boolean };
  quote: FutuBridgeProcessStatus;
  /** Env / managed URL used by market-stream-gateway. */
  marketWsUrl: string | null;
  message: string;
};

type ManagedProc = {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  startedAt: string;
  lastError: string | null;
};

let tradeManaged: ManagedProc | null = null;
let quoteManaged: ManagedProc | null = null;
let ensureInflight: Promise<FutuRuntimeStatus> | null = null;

function parseTradeUrl(baseUrl: string | null | undefined): { host: string; port: number; url: string } {
  const raw = (baseUrl?.trim() || FUTU_DEFAULT_TRADE_BASE_URL).replace(/\/$/, "");
  try {
    const u = new URL(raw);
    return {
      host: u.hostname || "127.0.0.1",
      port: u.port ? Number(u.port) : 80,
      url: raw,
    };
  } catch {
    return { host: "127.0.0.1", port: FUTU_DEFAULT_TRADE_PORT, url: FUTU_DEFAULT_TRADE_BASE_URL };
  }
}

function quoteUrlFromEnvOrDefault(): string {
  return (
    process.env.QUBIT_FUTU_MARKET_WS_URL?.trim() ||
    process.env.QUBIT_BROKER_MARKET_WS_URL_FUTU?.trim() ||
    FUTU_DEFAULT_QUOTE_WS_URL
  );
}

function quoteListen(url: string): { host: string; port: number } {
  try {
    const u = new URL(url.replace(/^ws/i, "http"));
    return { host: u.hostname || "127.0.0.1", port: u.port ? Number(u.port) : FUTU_DEFAULT_QUOTE_PORT };
  } catch {
    return { host: "127.0.0.1", port: FUTU_DEFAULT_QUOTE_PORT };
  }
}

export async function resolveFutuOpenDConfig(): Promise<FutuOpenDConfig | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(brokerAccount)
    .where(and(eq(brokerAccount.provider, "futu"), eq(brokerAccount.enabled, true)))
    .orderBy(desc(brokerAccount.isDefault), desc(brokerAccount.updatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const cfg = (row.providerConfigJson ?? {}) as FutuProviderConfig;
  return {
    opendHost: (cfg.opendHost ?? "127.0.0.1").trim() || "127.0.0.1",
    opendPort: Number(cfg.opendPort) || 11111,
    market: cfg.market,
    accId: cfg.accId,
    accountRef: row.accountRef,
    mode: row.mode,
    baseUrl: row.baseUrl,
  };
}

/** Prefer account baseUrl; otherwise default local trade bridge. */
export function defaultFutuTradeBaseUrl(existing?: string | null): string {
  const t = existing?.trim();
  return t || FUTU_DEFAULT_TRADE_BASE_URL;
}

async function probeTradeHealth(baseUrl: string): Promise<boolean> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/health?provider=futu`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2_500) });
    return res.ok;
  } catch {
    return false;
  }
}

function isProcAlive(managed: ManagedProc | null): boolean {
  if (!managed) return false;
  try {
    // Bun Subprocess: exitCode null while running
    return managed.proc.exitCode === null;
  } catch {
    return false;
  }
}

function killManaged(managed: ManagedProc | null): void {
  if (!managed) return;
  try {
    managed.proc.kill();
  } catch {
    /* ignore */
  }
}

async function spawnTradeBridge(opend: FutuOpenDConfig): Promise<ManagedProc> {
  const { host, port, url } = parseTradeUrl(opend.baseUrl);
  const pythonBin = getPythonBin();
  const cwd = getPythonConnectorsDir();
  const script = join(cwd, "broker_http_server.py");
  const proc = Bun.spawn([pythonBin, script], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      QUBIT_BROKER_HOST: host,
      QUBIT_BROKER_PORT: String(port),
      QUBIT_BROKER_PROVIDER: "futu",
      QUBIT_FUTU_OPEND_HOST: opend.opendHost,
      QUBIT_FUTU_OPEND_PORT: String(opend.opendPort),
    },
  });
  return {
    proc,
    url,
    startedAt: new Date().toISOString(),
    lastError: null,
  };
}

async function spawnQuoteBridge(opend: FutuOpenDConfig): Promise<ManagedProc> {
  const url = quoteUrlFromEnvOrDefault();
  const { host, port } = quoteListen(url);
  const pythonBin = getPythonBin();
  const cwd = getPythonConnectorsDir();
  const proc = Bun.spawn(
    [pythonBin, "-m", "market_bridge.server", "--provider", "futu", "--host", host, "--port", String(port)],
    {
      cwd,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...process.env,
        QUBIT_FUTU_OPEND_HOST: opend.opendHost,
        QUBIT_FUTU_OPEND_PORT: String(opend.opendPort),
        QUBIT_MARKET_BRIDGE_PROVIDER: "futu",
        QUBIT_MARKET_BRIDGE_HOST: host,
        QUBIT_MARKET_BRIDGE_PORT: String(port),
      },
    }
  );
  // Publish for market-stream-gateway / credentialsReady.
  process.env.QUBIT_FUTU_MARKET_WS_URL = url;
  if (!process.env.QUBIT_MARKET_STREAM_PROVIDER?.trim()) {
    process.env.QUBIT_MARKET_STREAM_PROVIDER = "futu";
  }
  return {
    proc,
    url,
    startedAt: new Date().toISOString(),
    lastError: null,
  };
}

async function waitForTrade(url: string, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeTradeHealth(url)) return true;
    await Bun.sleep(400);
  }
  return false;
}

async function waitForQuotePort(url: string, timeoutMs = 8_000): Promise<boolean> {
  const { host, port } = quoteListen(url);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // TCP connect probe via fetch to non-HTTP may fail; use Bun.connect when available.
      const socket = await Bun.connect({
        hostname: host,
        port,
        socket: {
          data() {},
          open(sock) {
            sock.end();
          },
          close() {},
          error() {},
        },
      });
      void socket;
      return true;
    } catch {
      await Bun.sleep(400);
    }
  }
  return false;
}

export async function getFutuRuntimeStatus(): Promise<FutuRuntimeStatus> {
  const openD = await resolveFutuOpenDConfig();
  const tradeUrl = defaultFutuTradeBaseUrl(openD?.baseUrl);
  const envWs =
    process.env.QUBIT_FUTU_MARKET_WS_URL?.trim() ||
    process.env.QUBIT_BROKER_MARKET_WS_URL_FUTU?.trim() ||
    null;
  const quoteUrl = envWs || (isProcAlive(quoteManaged) ? quoteManaged!.url : FUTU_DEFAULT_QUOTE_WS_URL);

  const tradeHealthy = await probeTradeHealth(tradeUrl);
  const tradeRunning = tradeHealthy || isProcAlive(tradeManaged);
  const quoteRunning = isProcAlive(quoteManaged) || Boolean(envWs);

  let message = "未配置启用的 Futu 券商账户";
  if (openD) {
    if (openD.mode === "mock") {
      message = "Futu 账户为 mock：交易走本地模拟；可仍启动行情桥连 OpenD";
    } else if (tradeHealthy && quoteRunning) {
      message = "Futu 交易 HTTP 与行情 WS 已就绪";
    } else if (tradeHealthy) {
      message = "交易桥已就绪；行情桥未启动或未配置 WS URL";
    } else {
      message = "已配置 Futu 账户，但交易/行情桥未就绪 — 可调用 ensure";
    }
  }

  return {
    configured: Boolean(openD),
    openD,
    trade: {
      running: tradeRunning,
      healthy: tradeHealthy,
      pid: isProcAlive(tradeManaged) ? (tradeManaged!.proc.pid ?? null) : null,
      url: tradeUrl,
      lastError: tradeManaged?.lastError ?? null,
      startedAt: tradeManaged?.startedAt ?? null,
    },
    quote: {
      running: quoteRunning,
      pid: isProcAlive(quoteManaged) ? (quoteManaged!.proc.pid ?? null) : null,
      url: quoteUrl,
      lastError: quoteManaged?.lastError ?? null,
      startedAt: quoteManaged?.startedAt ?? null,
    },
    marketWsUrl: envWs || (isProcAlive(quoteManaged) ? quoteManaged!.url : null),
    message,
  };
}

/**
 * Ensure local Futu trade HTTP + quote WS bridges are running for the configured account.
 * No-op (status only) when no enabled futu broker_account exists.
 */
export async function ensureFutuRuntime(options?: {
  /** Also start quote bridge when mode=mock (default true). */
  startQuoteInMock?: boolean;
}): Promise<FutuRuntimeStatus> {
  if (ensureInflight) return ensureInflight;
  ensureInflight = (async () => {
    try {
      const openD = await resolveFutuOpenDConfig();
      if (!openD) return getFutuRuntimeStatus();

      const tradeUrl = defaultFutuTradeBaseUrl(openD.baseUrl);
      const needTrade = openD.mode !== "mock";
      const needQuote = openD.mode !== "mock" || options?.startQuoteInMock !== false;

      if (needTrade) {
        const healthy = await probeTradeHealth(tradeUrl);
        if (!healthy) {
          if (isProcAlive(tradeManaged)) {
            killManaged(tradeManaged);
            tradeManaged = null;
          }
          tradeManaged = await spawnTradeBridge({ ...openD, baseUrl: tradeUrl });
          const ok = await waitForTrade(tradeUrl);
          if (!ok) {
            tradeManaged.lastError = "trade bridge did not become healthy in time";
          }
        }
      }

      if (needQuote) {
        const existingWs = process.env.QUBIT_FUTU_MARKET_WS_URL?.trim();
        const managedAlive = isProcAlive(quoteManaged);
        if (!managedAlive) {
          // If user already pointed env at an external bridge, don't spawn.
          if (existingWs && existingWs !== FUTU_DEFAULT_QUOTE_WS_URL) {
            // leave external
          } else {
            killManaged(quoteManaged);
            quoteManaged = await spawnQuoteBridge(openD);
            const ok = await waitForQuotePort(quoteManaged.url);
            if (!ok) {
              quoteManaged.lastError =
                "quote bridge port not open (check websockets/futu-api + OpenD)";
            }
          }
        } else if (!process.env.QUBIT_FUTU_MARKET_WS_URL?.trim() && quoteManaged) {
          process.env.QUBIT_FUTU_MARKET_WS_URL = quoteManaged.url;
        }
      }

      return getFutuRuntimeStatus();
    } finally {
      ensureInflight = null;
    }
  })();
  const status = await ensureInflight;
  // Refresh control-plane credentialsReady after env / managed WS is published.
  try {
    const { syncMarketDataSourceCredentials } = await import("./market-data-source-control");
    await syncMarketDataSourceCredentials();
  } catch {
    /* non-fatal — listMarketDataSources also recomputes live */
  }
  return status;
}

/** Best-effort stop of processes we spawned (not external bridges). */
export function stopManagedFutuRuntime(): void {
  killManaged(tradeManaged);
  killManaged(quoteManaged);
  tradeManaged = null;
  quoteManaged = null;
}

/**
 * When saving a futu account for sandbox/live, fill default trade baseUrl if empty.
 */
export function applyFutuAccountDefaults(input: {
  provider: string;
  mode?: "mock" | "sandbox" | "live";
  baseUrl?: string | null;
}): { baseUrl?: string } {
  if (input.provider !== "futu") return {};
  const mode = input.mode ?? "mock";
  if (mode === "mock") return {};
  if (input.baseUrl?.trim()) return {};
  return { baseUrl: FUTU_DEFAULT_TRADE_BASE_URL };
}

/**
 * Ensure a default enabled Futu broker account exists (sandbox + local bridges).
 * Used when installing the official Futu connector plugin.
 */
export async function ensureDefaultFutuBrokerAccount(): Promise<FutuOpenDConfig> {
  const existing = await resolveFutuOpenDConfig();
  if (existing) return existing;

  const { upsertBrokerAccount } = await import("../execution/broker/broker-admin");
  await upsertBrokerAccount({
    provider: "futu",
    accountRef: "default",
    mode: "sandbox",
    baseUrl: FUTU_DEFAULT_TRADE_BASE_URL,
    isDefault: true,
    enabled: true,
    providerConfig: {
      opendHost: process.env.QUBIT_FUTU_OPEND_HOST?.trim() || "127.0.0.1",
      opendPort: Number(process.env.QUBIT_FUTU_OPEND_PORT) || 11111,
      market: "HK",
    },
  });
  const created = await resolveFutuOpenDConfig();
  if (!created) throw new Error("failed to create default futu broker account");
  return created;
}
