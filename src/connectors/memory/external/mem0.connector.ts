import type {
  ConnectorConfig,
  HealthCheckResult,
  MemoryFilters,
  MemoryMetadata,
  MemoryRecord,
} from "../../../types/connector";
import type { ConnectorMeta } from "../../../types/connector";
import { BaseMemoryConnector } from "../memory.connector";

/**
 * Mem0Connector — optional external memory connector backed by Mem0.
 *
 * V1 implementation plan:
 *   - Priority: use mem0-ts TypeScript SDK (Bun-native import)
 *   - Fallback: Python subprocess bridge if mem0-ts is unavailable
 *
 * Configuration (via memory_backend_config.config_ref):
 *   {
 *     "provider": "openai" | "ollama",
 *     "model": "...",
 *     "vectorStore": "qdrant" | "chroma",
 *     "vectorStoreUrl": "http://localhost:6333"
 *   }
 *
 * @see https://github.com/mem0ai/mem0
 */
export class Mem0Connector extends BaseMemoryConnector {
  readonly meta: ConnectorMeta = {
    name: "mem0",
    version: "1.0.0",
    connectorType: "memory",
    capabilities: [
      "hybrid_search",       // semantic + BM25 + entity matching
      "entity_linking",      // lightweight entity-aware memory
      "cross_agent_memory",  // shared memory across agents
    ],
    assetClasses: [],
    latencyProfile: "neartime",
    description: "Mem0 external memory connector — optional, with auto-fallback to native.",
  };

  // mem0-ts client instance (dynamically imported at runtime)
  private client: unknown = null;

  protected async onInit(config: ConnectorConfig): Promise<void> {
    try {
      // Dynamic import to avoid hard dependency at build time
      const mem0 = await import("mem0ai" as string);
      this.client = new (mem0 as { Memory: new (cfg: ConnectorConfig) => unknown }).Memory(config);
    } catch {
      throw new Error(
        "Mem0Connector: mem0ai package not found. Install it with: bun add mem0ai"
      );
    }
  }

  protected async onHealthcheck(): Promise<
    Omit<HealthCheckResult, "latencyMs" | "checkedAt">
  > {
    if (!this.client) {
      return { status: "unhealthy", message: "Mem0 client not initialized" };
    }
    return { status: "healthy" };
  }

  protected async onShutdown(): Promise<void> {
    this.client = null;
  }

  async add(content: string, metadata: MemoryMetadata): Promise<MemoryRecord> {
    const client = this._requireClient();
    const result = await (client as { add: (msgs: unknown[], opts: unknown) => Promise<{ id: string }[]> }).add(
      [{ role: "user", content }],
      {
        user_id: metadata.projectId ?? "default",
        metadata: {
          layer: metadata.layer,
          asofTime: metadata.asofTime,
          ...metadata,
        },
      }
    );

    const id = result[0]?.id ?? crypto.randomUUID();
    const now = new Date().toISOString();

    return { id, content, metadata, createdAt: now, updatedAt: now };
  }

  async search(
    query: string,
    filters: MemoryFilters,
    topK: number
  ): Promise<MemoryRecord[]> {
    const client = this._requireClient();
    const results = await (client as {
      search: (q: string, opts: unknown) => Promise<Array<{ id: string; memory: string; score: number; metadata: unknown }>>
    }).search(query, {
      user_id: filters.projectId ?? "default",
      limit: topK,
    });

    return results.map((r) => ({
      id: r.id,
      content: r.memory,
      metadata: {
        ...(r.metadata as object),
        layer: filters.layer ?? "longterm",
        asofTime: new Date().toISOString(),
      } as MemoryMetadata,
      score: r.score,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const client = this._requireClient();
    try {
      const result = await (client as {
        get: (id: string) => Promise<{ id: string; memory: string; metadata: unknown } | null>
      }).get(id);
      if (!result) return null;

      return {
        id: result.id,
        content: result.memory,
        metadata: (result.metadata ?? { layer: "longterm", asofTime: new Date().toISOString() }) as MemoryMetadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    const client = this._requireClient();
    await (client as { delete: (id: string) => Promise<void> }).delete(id);
  }

  async list(filters: MemoryFilters): Promise<MemoryRecord[]> {
    const client = this._requireClient();
    const results = await (client as {
      getAll: (opts: unknown) => Promise<Array<{ id: string; memory: string; metadata: unknown }>>
    }).getAll({
      user_id: filters.projectId ?? "default",
    });

    return results.map((r) => ({
      id: r.id,
      content: r.memory,
      metadata: (r.metadata ?? { layer: "longterm", asofTime: new Date().toISOString() }) as MemoryMetadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  private _requireClient(): NonNullable<typeof this.client> {
    if (!this.client) {
      throw new Error("Mem0Connector is not initialized. Call init() first.");
    }
    return this.client;
  }
}

export const mem0Connector = new Mem0Connector();
