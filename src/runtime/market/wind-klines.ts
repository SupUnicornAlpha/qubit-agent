import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { PythonConnectorBridgeImpl } from "../../connectors/python-bridge";
import { config } from "../../config";
import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";
import { getPythonConnectorsDir, resolvePythonBin } from "../app-paths";

export interface WindSessionStatus {
  connected: boolean;
  userId: string | null;
  lastLoginAt: string | null;
  message: string;
  hasCredentials: boolean;
}

export interface WindInitConfig {
  username?: string;
  password?: string;
  autoLogin?: boolean;
  startWaitSec?: number;
}

let bridge: PythonConnectorBridgeImpl | null = null;
let bridgeInit: Promise<PythonConnectorBridgeImpl> | null = null;
let bridgeConfigKey = "";

function pythonConnectorsDir(): string {
  return getPythonConnectorsDir();
}

function connectorRunnerPath(): string {
  return join(pythonConnectorsDir(), "connector_runner.py");
}

export function windConfigFromSettings(
  settings: BuiltinConnectorInitConfigs
): WindInitConfig {
  const data = (settings["qubit-data"] ?? {}) as Record<string, unknown>;
  const username =
    typeof data.windUsername === "string" && data.windUsername.trim()
      ? data.windUsername.trim()
      : undefined;
  const password =
    typeof data.windPassword === "string" && data.windPassword.trim()
      ? data.windPassword.trim()
      : undefined;
  const autoLogin = data.windAutoLogin === false ? false : true;
  const startWaitSec =
    typeof data.windStartWaitSec === "number" && Number.isFinite(data.windStartWaitSec)
      ? Math.max(10, Math.min(300, Math.floor(data.windStartWaitSec)))
      : 60;
  return { username, password, autoLogin, startWaitSec };
}

function configKey(cfg: WindInitConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        u: cfg.username ?? "",
        p: cfg.password ?? "",
        a: cfg.autoLogin ?? true,
        w: cfg.startWaitSec ?? 60,
      })
    )
    .digest("hex")
    .slice(0, 16);
}

/** 配置变更或显式登出后调用，下次请求会重建 Wind 子进程。 */
export async function invalidateWindBridge(): Promise<void> {
  if (bridge) {
    try {
      await bridge.shutdown();
    } catch {
      /* ignore */
    }
  }
  bridge = null;
  bridgeInit = null;
  bridgeConfigKey = "";
}

async function getWindBridge(cfg: WindInitConfig): Promise<PythonConnectorBridgeImpl> {
  const key = configKey(cfg);
  if (bridge && bridgeConfigKey === key) return bridge;

  await invalidateWindBridge();

  bridgeInit = (async () => {
    const instance = new PythonConnectorBridgeImpl({
      scriptPath: connectorRunnerPath(),
      connectorName: "wind",
      cwd: pythonConnectorsDir(),
      pythonBin: resolvePythonBin(config.dataDir),
      meta: {
        name: "wind-python",
        version: "1.0.0",
        connectorType: "data",
        capabilities: ["fetch_bars", "session_status", "session_login", "session_reconnect"],
        assetClasses: ["stock"],
        latencyProfile: "batch",
        description: "WindPy subprocess bridge (requires Wind Terminal)",
      },
    });
    await instance.init({
      username: cfg.username,
      password: cfg.password,
      autoLogin: cfg.autoLogin,
      startWaitSec: cfg.startWaitSec,
    });
    bridge = instance;
    bridgeConfigKey = key;
    return instance;
  })();

  try {
    return await bridgeInit;
  } catch (e) {
    bridgeInit = null;
    throw e;
  }
}

/** 探测 Wind Python 环境是否可用（不抛错）。 */
export async function probeWindAvailable(cfg: WindInitConfig): Promise<boolean> {
  try {
    const b = await getWindBridge(cfg);
    const hc = await b.healthcheck();
    return hc.status === "healthy";
  } catch {
    return false;
  }
}

export function hasWindConfigured(settings: BuiltinConnectorInitConfigs): boolean {
  const cfg = windConfigFromSettings(settings);
  /** 有账号或显式选了 wind 数据源时认为用户意图使用 Wind（终端已登录也可无账号） */
  return Boolean(cfg.username) || settings["qubit-data"]?.klinesDataSource === "wind";
}

export async function fetchWindBars(
  params: FetchBarsParams,
  settings: BuiltinConnectorInitConfigs
): Promise<BarData[]> {
  const cfg = windConfigFromSettings(settings);
  const client = await getWindBridge(cfg);
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

export async function getWindSessionStatus(
  settings: BuiltinConnectorInitConfigs
): Promise<WindSessionStatus> {
  const cfg = windConfigFromSettings(settings);
  const client = await getWindBridge(cfg);
  return (await client.execute("session_status", {})) as WindSessionStatus;
}

export async function loginWindSession(
  settings: BuiltinConnectorInitConfigs,
  input?: { username?: string; password?: string; startWaitSec?: number }
): Promise<WindSessionStatus> {
  const cfg = windConfigFromSettings(settings);
  const client = await getWindBridge(cfg);
  const result = (await client.execute("session_login", {
    username: input?.username ?? cfg.username,
    password: input?.password ?? cfg.password,
    startWaitSec: input?.startWaitSec ?? cfg.startWaitSec,
  })) as WindSessionStatus;
  bridgeConfigKey = configKey({
    ...cfg,
    username: input?.username ?? cfg.username,
    password: input?.password ?? cfg.password,
  });
  return result;
}

export async function reconnectWindSession(
  settings: BuiltinConnectorInitConfigs
): Promise<WindSessionStatus> {
  const cfg = windConfigFromSettings(settings);
  const client = await getWindBridge(cfg);
  return (await client.execute("session_reconnect", {})) as WindSessionStatus;
}
