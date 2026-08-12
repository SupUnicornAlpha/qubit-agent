/**
 * 同花顺 iFinD historical OHLCV — Python `connectors.ifind`.
 *
 * SuperMind backtest `history()` is sandbox-only; desktop history uses iFinDPy.
 * Control-plane source id remains `supermind_bridge` (同花顺 family).
 */

import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { config } from "../../config";
import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { PythonConnectorBridgeImpl } from "../../connectors/python-bridge";
import { getDb } from "../../db/sqlite/client";
import { brokerAccount } from "../../db/sqlite/schema";
import type { SuperMindProviderConfig } from "../../types/broker";
import { getPythonConnectorsDir, resolvePythonBin } from "../app-paths";
import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";

let bridge: PythonConnectorBridgeImpl | null = null;
let bridgeInit: Promise<PythonConnectorBridgeImpl> | null = null;
let bridgeKey = "";

let ifindConfigured = false;

export function markIfindConfigured(ready: boolean): void {
  ifindConfigured = ready;
}

export function isIfindConfiguredCached(): boolean {
  return ifindConfigured;
}

export type IfindCredentials = {
  username: string;
  password: string;
};

export function ifindCredentialsFromSettings(
  settings?: BuiltinConnectorInitConfigs
): IfindCredentials | null {
  const data = (settings?.["qubit-data"] ?? {}) as Record<string, unknown>;
  const username =
    (typeof data.ifindUsername === "string" && data.ifindUsername.trim()) ||
    process.env.QUBIT_IFIND_USERNAME?.trim() ||
    "";
  const password =
    (typeof data.ifindPassword === "string" && data.ifindPassword.trim()) ||
    process.env.QUBIT_IFIND_PASSWORD?.trim() ||
    "";
  if (!username || !password) return null;
  return { username, password };
}

export async function resolveIfindCredentials(
  settings?: BuiltinConnectorInitConfigs
): Promise<IfindCredentials | null> {
  const fromSettings = ifindCredentialsFromSettings(settings);
  if (fromSettings) return fromSettings;

  try {
    const db = await getDb();
    const rows = await db
      .select()
      .from(brokerAccount)
      .where(and(eq(brokerAccount.provider, "supermind"), eq(brokerAccount.enabled, true)))
      .orderBy(desc(brokerAccount.isDefault), desc(brokerAccount.updatedAt))
      .limit(1);
    const cfg = (rows[0]?.providerConfigJson ?? {}) as SuperMindProviderConfig & {
      ifindUsername?: string;
      ifindPassword?: string;
    };
    const username = cfg.ifindUsername?.trim() || "";
    const password = cfg.ifindPassword?.trim() || "";
    if (username && password) return { username, password };
  } catch {
    /* ignore */
  }
  return null;
}

function connectorRunnerPath(): string {
  return join(getPythonConnectorsDir(), "connector_runner.py");
}

async function getIfindBridge(creds: IfindCredentials): Promise<PythonConnectorBridgeImpl> {
  const key = `${creds.username}:${creds.password.length}`;
  if (bridge && bridgeKey === key) return bridge;
  if (bridgeInit && bridgeKey === key) return bridgeInit;

  if (bridge) {
    try {
      await bridge.shutdown();
    } catch {
      /* ignore */
    }
    bridge = null;
  }

  bridgeKey = key;
  bridgeInit = (async () => {
    const instance = new PythonConnectorBridgeImpl({
      scriptPath: connectorRunnerPath(),
      connectorName: "ifind",
      cwd: getPythonConnectorsDir(),
      pythonBin: resolvePythonBin(config.dataDir),
      meta: {
        name: "ifind-history",
        version: "1.0.0",
        connectorType: "data",
        capabilities: ["fetch_bars"],
        assetClasses: ["stock"],
        latencyProfile: "batch",
        description: "Tonghuashun iFinD historical K-line (supermind_bridge)",
      },
    });
    await instance.init({
      username: creds.username,
      password: creds.password,
    });
    bridge = instance;
    return instance;
  })();

  try {
    return await bridgeInit;
  } catch (e) {
    bridgeInit = null;
    bridgeKey = "";
    throw e;
  }
}

export async function refreshIfindAccountCache(
  settings?: BuiltinConnectorInitConfigs
): Promise<boolean> {
  try {
    const creds = await resolveIfindCredentials(settings);
    markIfindConfigured(Boolean(creds));
    return Boolean(creds);
  } catch {
    markIfindConfigured(false);
    return false;
  }
}

export async function probeIfindHistoryAvailable(
  settings?: BuiltinConnectorInitConfigs
): Promise<boolean> {
  try {
    const creds = await resolveIfindCredentials(settings);
    if (!creds) return false;
    markIfindConfigured(true);
    const b = await getIfindBridge(creds);
    const hc = await b.healthcheck();
    return hc.status === "healthy";
  } catch {
    return false;
  }
}

export async function fetchIfindBars(
  params: FetchBarsParams,
  settings?: BuiltinConnectorInitConfigs
): Promise<BarData[]> {
  const creds = await resolveIfindCredentials(settings);
  if (!creds) {
    throw new Error(
      "iFinD credentials missing (qubit-data.ifindUsername/Password or QUBIT_IFIND_*)"
    );
  }
  markIfindConfigured(true);
  const client = await getIfindBridge(creds);
  const bars = (await client.execute("fetch_bars", {
    symbol: params.symbol,
    exchange: params.exchange || "",
    period: params.period,
    startDate: params.startDate,
    endDate: params.endDate,
  })) as BarData[];

  let sorted = [...bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const startMs = Date.parse(params.startDate);
  const endMs = Date.parse(params.endDate);
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    sorted = sorted.filter((b) => b.timestamp >= startIso && b.timestamp <= endIso);
  }
  return sorted;
}
