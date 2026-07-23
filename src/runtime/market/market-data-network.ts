import { execFileSync } from "node:child_process";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "../../util/fetch-with-timeout";
import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";
import type { OperationalMarketDataSource } from "./market-data-source-control";

export type MarketDataNetworkMode = "auto" | "direct" | "proxy";

export interface MarketDataNetworkRoute {
  mode: MarketDataNetworkMode;
  proxyUrl: string | null;
  source: "direct" | "config" | "environment" | "system";
}

const SYSTEM_PROXY_CACHE_TTL_MS = 5_000;
let cachedSystemProxy: { value: string | null; checkedAt: number } | undefined;

function macSystemProxy(): string | null {
  const now = Date.now();
  if (cachedSystemProxy && now - cachedSystemProxy.checkedAt < SYSTEM_PROXY_CACHE_TTL_MS) {
    return cachedSystemProxy.value;
  }
  let value: string | null = null;
  if (process.platform !== "darwin") {
    cachedSystemProxy = { value, checkedAt: now };
    return value;
  }
  try {
    const output = execFileSync("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 1_500,
    });
    const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(output);
    const httpEnabled = /HTTPEnable\s*:\s*1/.test(output);
    const host = output.match(
      new RegExp(`${httpsEnabled ? "HTTPSProxy" : "HTTPProxy"}\\s*:\\s*([^\\s]+)`)
    )?.[1];
    const port = output.match(
      new RegExp(`${httpsEnabled ? "HTTPSPort" : "HTTPPort"}\\s*:\\s*(\\d+)`)
    )?.[1];
    if ((httpsEnabled || httpEnabled) && host && port) value = `http://${host}:${port}`;
  } catch {}
  cachedSystemProxy = { value, checkedAt: now };
  return value;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceOverride(
  config: Record<string, unknown>,
  sourceId: OperationalMarketDataSource
): Record<string, unknown> {
  const overrides = config.marketDataSourceNetwork;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return {};
  const source = (overrides as Record<string, unknown>)[sourceId];
  return source && typeof source === "object" && !Array.isArray(source)
    ? (source as Record<string, unknown>)
    : {};
}

export function resolveMarketDataNetworkRoute(
  settings: BuiltinConnectorInitConfigs,
  sourceId: OperationalMarketDataSource
): MarketDataNetworkRoute {
  const config = (settings["qubit-data"] ?? {}) as Record<string, unknown>;
  const override = sourceOverride(config, sourceId);
  const rawMode = override.mode ?? config.marketDataNetworkMode;
  const mode: MarketDataNetworkMode =
    rawMode === "direct" || rawMode === "proxy" ? rawMode : "auto";
  const configuredProxy = nonEmpty(override.proxyUrl) ?? nonEmpty(config.marketDataProxyUrl);
  const environmentProxy =
    nonEmpty(process.env.HTTPS_PROXY) ??
    nonEmpty(process.env.https_proxy) ??
    nonEmpty(process.env.HTTP_PROXY) ??
    nonEmpty(process.env.http_proxy);
  const systemProxy = config.marketDataUseSystemProxy === false ? null : macSystemProxy();

  if (mode === "direct") return { mode, proxyUrl: null, source: "direct" };
  if (configuredProxy) return { mode, proxyUrl: configuredProxy, source: "config" };
  if (environmentProxy) return { mode, proxyUrl: environmentProxy, source: "environment" };
  if (systemProxy) return { mode, proxyUrl: systemProxy, source: "system" };
  if (mode === "proxy") {
    throw new Error("market data proxy required but marketDataProxyUrl is empty");
  }
  return { mode, proxyUrl: null, source: "direct" };
}

export async function marketDataFetch(
  sourceId: OperationalMarketDataSource,
  settings: BuiltinConnectorInitConfigs,
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const route = resolveMarketDataNetworkRoute(settings, sourceId);
  const requestInit = route.proxyUrl ? ({ ...init, proxy: route.proxyUrl } as RequestInit) : init;
  return fetchWithTimeout(url, requestInit, timeoutMs);
}

export function marketDataProxyForPython(
  settings: BuiltinConnectorInitConfigs,
  sourceId: OperationalMarketDataSource
): string | null {
  return resolveMarketDataNetworkRoute(settings, sourceId).proxyUrl;
}
