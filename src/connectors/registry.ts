import { recordConnectorCall } from "../runtime/monitor/connector-call-log";
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
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName !== connector.meta.name) {
      throw new Error(
        `Connector registration name mismatch: "${name}" !== "${connector.meta.name}".`
      );
    }
    const existing = this.connectors.get(normalizedName);
    if (existing && existing !== connector) {
      throw new Error(`Connector "${normalizedName}" is already registered.`);
    }
    this.connectors.set(normalizedName, connector);
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
      const startedAt = Date.now();
      try {
        await connector.init(config);
        void recordConnectorCall({
          connectorName: name,
          operation: "init",
          request: { configKeys: Object.keys(config) },
          response: { initialized: true },
          latencyMs: Date.now() - startedAt,
          status: "success",
        }).catch((error) => {
          console.warn(`[connector-monitor] failed to record init: ${String(error)}`);
        });
        console.log(`[Registry] Connector "${name}" initialized.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void recordConnectorCall({
          connectorName: name,
          operation: "init",
          request: { configKeys: Object.keys(config) },
          latencyMs: Date.now() - startedAt,
          status: "error",
          errorMessage: message,
        }).catch((recordError) => {
          console.warn(`[connector-monitor] failed to record init error: ${String(recordError)}`);
        });
        throw error;
      }
    }
  }

  async shutdownAll(): Promise<void> {
    for (const [name, connector] of this.connectors) {
      const startedAt = Date.now();
      try {
        await connector.shutdown();
        void recordConnectorCall({
          connectorName: name,
          operation: "shutdown",
          response: { shutdown: true },
          latencyMs: Date.now() - startedAt,
          status: "success",
        }).catch((error) => {
          console.warn(`[connector-monitor] failed to record shutdown: ${String(error)}`);
        });
        console.log(`[Registry] Connector "${name}" shut down.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void recordConnectorCall({
          connectorName: name,
          operation: "shutdown",
          latencyMs: Date.now() - startedAt,
          status: "error",
          errorMessage: message,
        }).catch((recordError) => {
          console.warn(
            `[connector-monitor] failed to record shutdown error: ${String(recordError)}`
          );
        });
        throw error;
      }
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
    throw new Error(`dispatchAcpCall: connector "${request.targetName}" is not registered.`);
  }

  const payload = request.payload as { operation: string; params: unknown };
  const startedAt = Date.now();
  try {
    const result = await connector.execute(payload.operation, payload.params);
    void recordConnectorCall({
      connectorName: request.targetName,
      operation: "execute",
      traceId: request.traceId,
      workflowRunId: request.workflowId,
      request: { operation: payload.operation, params: payload.params },
      response: result,
      latencyMs: Date.now() - startedAt,
      status: "success",
    }).catch((error) => {
      console.warn(`[connector-monitor] failed to record success: ${String(error)}`);
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || /\btimeout\b|\btimed?\s*out\b/i.test(message));
    void recordConnectorCall({
      connectorName: request.targetName,
      operation: "execute",
      traceId: request.traceId,
      workflowRunId: request.workflowId,
      request: { operation: payload.operation, params: payload.params },
      latencyMs: Date.now() - startedAt,
      status: isTimeout ? "timeout" : "error",
      errorMessage: message,
    }).catch((recordError) => {
      console.warn(`[connector-monitor] failed to record error: ${String(recordError)}`);
    });
    throw error;
  }
}
