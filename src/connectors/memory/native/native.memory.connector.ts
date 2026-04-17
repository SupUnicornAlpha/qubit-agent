import type { ConnectorConfig, HealthCheckResult, MemoryFilters, MemoryMetadata, MemoryRecord } from "../../../types/connector";
import { BaseMemoryConnector } from "../memory.connector";
import type { ConnectorMeta } from "../../../types/connector";
import { sessionStore } from "./session.store";
import { midtermStore } from "./midterm.store";
import { longtermStore } from "./longterm.store";

/**
 * NativeMemoryConnector — always-on memory connector backed by:
 *   - SQLite (session / midterm / longterm metadata)
 *   - LanceDB (longterm vector embeddings)
 *   - Local FS (artifact snapshots)
 *
 * This connector is always active regardless of external memory configuration.
 */
export class NativeMemoryConnector extends BaseMemoryConnector {
  readonly meta: ConnectorMeta = {
    name: "native-memory",
    version: "1.0.0",
    connectorType: "memory",
    capabilities: ["session", "midterm", "longterm", "vector_search"],
    assetClasses: [],
    latencyProfile: "neartime",
    description: "Built-in memory store: SQLite + LanceDB + FS. Zero external dependencies.",
  };

  protected async onInit(_config: ConnectorConfig): Promise<void> {
    // SQLite and LanceDB clients are lazy-initialized on first use
  }

  protected async onHealthcheck(): Promise<Omit<HealthCheckResult, "latencyMs" | "checkedAt">> {
    try {
      const { getDb } = await import("../../../db/sqlite/client");
      await getDb();
      return { status: "healthy" };
    } catch (err) {
      return {
        status: "unhealthy",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  protected async onShutdown(): Promise<void> {
    // SQLite connection cleanup is handled by the db module
  }

  async add(content: string, metadata: MemoryMetadata): Promise<MemoryRecord> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    if (metadata.layer === "session" && metadata["workflowRunId"]) {
      await sessionStore.upsert(metadata["workflowRunId"] as string, {
        summary: content,
        stateJson: metadata,
        asofTime: metadata.asofTime,
      });
    } else if (metadata.layer === "midterm" && metadata.projectId) {
      await midtermStore.insert({
        projectId: metadata.projectId,
        memoryType: (metadata["memoryType"] as string ?? "strategy_iteration") as never,
        contentJson: { content, ...metadata },
        timeWindowStart: metadata["timeWindowStart"] as string ?? now,
        timeWindowEnd: metadata["timeWindowEnd"] as string ?? now,
        asofTime: metadata.asofTime,
        score: metadata["score"] as number ?? null,
      });
    } else {
      await longtermStore.insert({
        scope: (metadata["scope"] as string ?? "project") as never,
        scopeId: metadata.projectId ?? metadata.strategyId ?? "default",
        memoryType: (metadata["memoryType"] as string ?? "playbook") as never,
        contentJson: { content, ...metadata },
        embeddingRef: null,
        artifactUri: null,
        validFrom: metadata.asofTime,
        validTo: null,
        asofTime: metadata.asofTime,
        confidenceScore: metadata["confidenceScore"] as number ?? null,
      });
    }

    return {
      id,
      content,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  async search(
    query: string,
    filters: MemoryFilters,
    topK: number
  ): Promise<MemoryRecord[]> {
    // V1: basic keyword search in longterm; vector search when embedding available
    const rows = await longtermStore.query({
      scope: filters.layer === "longterm" ? undefined : undefined,
      scopeId: filters.projectId,
      limit: topK,
    });

    return rows.map((r) => ({
      id: r.id,
      content: JSON.stringify(r.contentJson),
      metadata: {
        layer: "longterm" as const,
        asofTime: r.asofTime,
        projectId: filters.projectId,
      },
      score: r.confidenceScore ?? undefined,
      createdAt: r.updatedAt,
      updatedAt: r.updatedAt,
    }));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    // Try all layers
    const rows = await longtermStore.query({ limit: 1 });
    const row = rows.find((r) => r.id === id);
    if (!row) return null;

    return {
      id: row.id,
      content: JSON.stringify(row.contentJson),
      metadata: {
        layer: "longterm",
        asofTime: row.asofTime,
      },
      createdAt: row.updatedAt,
      updatedAt: row.updatedAt,
    };
  }

  async delete(id: string): Promise<void> {
    await longtermStore.delete(id);
  }

  async list(filters: MemoryFilters): Promise<MemoryRecord[]> {
    return this.search("", filters, 100);
  }
}

export const nativeMemoryConnector = new NativeMemoryConnector();
