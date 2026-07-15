import { connectorRegistry } from "./registry";
import { QubitNativeBacktestConnector } from "./backtest/native-backtest.connector";
import { QubitNativeDataConnector } from "./data/native-data.connector";
import { QubitNativeNewsConnector } from "./data/native-news.connector";
import { QubitBrokerConnector } from "./execution/qubit-broker.connector";
import { QubitNativeResearchConnector } from "./research/native-research.connector";
import { QubitNativeRiskConnector } from "./risk/native-risk.connector";
import { QubitNativeSimConnector } from "./simulation/native-sim.connector";
import { runMigrations } from "../db/sqlite/migrate";
import {
  loadBuiltinConnectorSettings,
  type BuiltinConnectorInitConfigs,
} from "../runtime/config/builtin-connector-settings";
import { seedEnvRegistry } from "../runtime/environment/seed-env-registry";
import { bootstrapProviders } from "../runtime/provider/bootstrap";
import { bootstrapResearchScenarios } from "../runtime/research-scenario/bootstrap";
import { bootstrapMarketDataSources } from "../runtime/market/market-data-source-control";

export type { BuiltinConnectorInitConfigs };

let bootstrapPromise: Promise<void> | null = null;

/**
 * Applies saved SQLite settings to registered builtin connectors (same shape as initAll).
 */
export async function reloadBuiltinConnectorsFromSettings(): Promise<BuiltinConnectorInitConfigs> {
  const configs = await loadBuiltinConnectorSettings();
  await connectorRegistry.initAll(configs);
  return configs;
}

/**
 * Registers built-in connectors used by agent definitions (e.g. qubit-data, qubit-news).
 * Loads init payloads from SQLite (`builtin_connector_settings`), or use `initConfigs` to override (tests).
 * Safe to call from both `src/index.ts` and `src/server.ts` (idempotent).
 */
export function registerBuiltinConnectors(initConfigs?: BuiltinConnectorInitConfigs): Promise<void> {
  bootstrapPromise ??= (async () => {
    await runMigrations();
    // M1: Provider 抽象层与研究场景注册中心；先于 connector init，
    // 这样后续 connector / runtime 都可直接走 providerResolver。
    await bootstrapProviders();
    await bootstrapResearchScenarios();
    // EnvironmentManager P1：把代码里的"系统期望清单"upsert 到 env_registry，
    // 用户编辑过的字段（status / user_version_spec）会被保留。
    // 失败仅 warn —— seed 不可用不应阻塞 connector init。
    try {
      await seedEnvRegistry();
    } catch (e) {
      console.warn(`[Bootstrap] seedEnvRegistry skipped: ${(e as Error).message}`);
    }

    const data = new QubitNativeDataConnector();
    const news = new QubitNativeNewsConnector();
    connectorRegistry.register("qubit-data", data);
    connectorRegistry.register("qubit-news", news);
    connectorRegistry.register("qubit-backtest", new QubitNativeBacktestConnector());
    connectorRegistry.register("qubit-research", new QubitNativeResearchConnector());
    connectorRegistry.register("qubit-sim", new QubitNativeSimConnector());
    connectorRegistry.register("qubit-risk", new QubitNativeRiskConnector());
    connectorRegistry.register("qubit-broker", new QubitBrokerConnector());
    const configs = initConfigs ?? (await loadBuiltinConnectorSettings());
    await bootstrapMarketDataSources(configs);
    await connectorRegistry.initAll(configs);
  })();
  return bootstrapPromise;
}
