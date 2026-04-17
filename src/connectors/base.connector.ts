import type {
  Connector,
  ConnectorConfig,
  ConnectorMeta,
  HealthCheckResult,
} from "../types/connector";

/**
 * Abstract base class for all TypeScript-native connectors.
 *
 * Concrete connectors extend this class and implement:
 *   - `onInit(config)` — setup (auth, connection pool, etc.)
 *   - `onHealthcheck()` — probe the upstream service
 *   - `onExecute(operation, payload)` — dispatch by operation string
 *   - `onShutdown()` — graceful teardown
 */
export abstract class BaseConnector implements Connector {
  abstract readonly meta: ConnectorMeta;

  protected config: ConnectorConfig = {};
  protected initialized = false;

  async init(config: ConnectorConfig): Promise<void> {
    this.config = config;
    await this.onInit(config);
    this.initialized = true;
  }

  async healthcheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const result = await this.onHealthcheck();
      return {
        ...result,
        latencyMs: Date.now() - start,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - start,
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async execute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    if (!this.initialized) {
      throw new Error(
        `Connector "${this.meta.name}" is not initialized. Call init() first.`
      );
    }
    return this.onExecute<TOutput>(operation, payload);
  }

  async shutdown(): Promise<void> {
    await this.onShutdown();
    this.initialized = false;
  }

  protected abstract onInit(config: ConnectorConfig): Promise<void>;
  protected abstract onHealthcheck(): Promise<Omit<HealthCheckResult, "latencyMs" | "checkedAt">>;
  protected abstract onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput>;
  protected abstract onShutdown(): Promise<void>;
}

/**
 * Bridge for Python sub-process connectors (JSON-RPC over stdio).
 * Full implementation lives in connectors/python-bridge.ts.
 */
export abstract class PythonConnectorBridge extends BaseConnector {
  protected abstract readonly scriptPath: string;
  protected abstract readonly connectorName: string;
}

/**
 * Bridge for HTTP-based remote connectors.
 */
export abstract class HttpConnectorBridge extends BaseConnector {
  protected abstract readonly baseUrl: string;
}
