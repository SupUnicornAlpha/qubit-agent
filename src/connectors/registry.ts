import type { AcpRequest } from "../types/acp";
import type { Connector } from "../types/connector";

/**
 * ConnectorRegistry — central registry for all active connector instances.
 *
 * Connectors are registered at startup and dispatched by the ACP caller.
 */
class ConnectorRegistry {
  private static _instance: ConnectorRegistry | null = null;
  private connectors = new Map<string, Connector>();

  static getInstance(): ConnectorRegistry {
    if (!ConnectorRegistry._instance) {
      ConnectorRegistry._instance = new ConnectorRegistry();
    }
    return ConnectorRegistry._instance;
  }

  register(name: string, connector: Connector): void {
    this.connectors.set(name, connector);
  }

  get(name: string): Connector | undefined {
    return this.connectors.get(name);
  }

  getAll(): Map<string, Connector> {
    return this.connectors;
  }

  async initAll(configs: Record<string, Record<string, unknown>>): Promise<void> {
    for (const [name, connector] of this.connectors) {
      const config = configs[name] ?? {};
      await connector.init(config);
      console.log(`[Registry] Connector "${name}" initialized.`);
    }
  }

  async shutdownAll(): Promise<void> {
    for (const [name, connector] of this.connectors) {
      await connector.shutdown();
      console.log(`[Registry] Connector "${name}" shut down.`);
    }
  }
}

export const connectorRegistry = ConnectorRegistry.getInstance();

/**
 * Dispatch an ACP call to the appropriate connector.
 * Called by AcpCaller._dispatch().
 */
export async function dispatchAcpCall(request: AcpRequest): Promise<unknown> {
  if (request.targetKind !== "connector") {
    throw new Error(
      `dispatchAcpCall: unsupported targetKind "${request.targetKind}" — only "connector" is handled here.`
    );
  }

  const connector = connectorRegistry.get(request.targetName);
  if (!connector) {
    throw new Error(
      `dispatchAcpCall: connector "${request.targetName}" is not registered.`
    );
  }

  const payload = request.payload as { operation: string; params: unknown };
  return connector.execute(payload.operation, payload.params);
}
