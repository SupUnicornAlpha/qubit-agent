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
    await connectorRegistry.initAll(configs);
  })();
  return bootstrapPromise;
}
