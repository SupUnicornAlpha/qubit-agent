import type { MemoryFilters, MemoryMetadata, MemoryRecord } from "../../types/connector";
import type { MemoryWriteMode } from "../../types/entities";
import { nativeMemoryConnector } from "./native/native.memory.connector";
import type { BaseMemoryConnector } from "./memory.connector";

export interface MemoryRouterConfig {
  writeMode: MemoryWriteMode;
  fallbackToNative: boolean;
  externalConnector?: BaseMemoryConnector;
}

/**
 * MemoryRouter — routes memory read/write operations between
 * the Native store and the optional External connector.
 *
 * Write routing rules:
 *   dual_write    → write to both Native + External (External failure is non-blocking)
 *   external_only → write to External only; fallback to Native if External fails and fallbackToNative=true
 *   native_only   → write to Native only; External is ignored
 *
 * Search routing rules:
 *   - External available → prefer External (richer semantic search)
 *   - External unavailable or native_only → Native (LanceDB + SQLite)
 */
export class MemoryRouter {
  private config: MemoryRouterConfig;

  constructor(config: MemoryRouterConfig) {
    this.config = config;
  }

  async add(content: string, metadata: MemoryMetadata): Promise<MemoryRecord> {
    const { writeMode, fallbackToNative, externalConnector } = this.config;

    if (writeMode === "native_only" || !externalConnector) {
      return nativeMemoryConnector.add(content, metadata);
    }

    if (writeMode === "dual_write") {
      const nativeWrite = nativeMemoryConnector.add(content, metadata);
      const externalWrite = externalConnector.add(content, metadata).catch((err) => {
        console.warn("[MemoryRouter] External write failed (non-blocking):", err);
        return null;
      });
      const [nativeResult] = await Promise.all([nativeWrite, externalWrite]);
      return nativeResult;
    }

    // external_only
    try {
      return await externalConnector.add(content, metadata);
    } catch (err) {
      if (fallbackToNative) {
        console.warn("[MemoryRouter] External write failed, falling back to native:", err);
        return nativeMemoryConnector.add(content, metadata);
      }
      throw err;
    }
  }

  async search(
    query: string,
    filters: MemoryFilters,
    topK: number
  ): Promise<MemoryRecord[]> {
    const { writeMode, externalConnector } = this.config;

    if (writeMode !== "native_only" && externalConnector) {
      try {
        return await externalConnector.search(query, filters, topK);
      } catch (err) {
        console.warn("[MemoryRouter] External search failed, falling back to native:", err);
      }
    }

    return nativeMemoryConnector.search(query, filters, topK);
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const { writeMode, externalConnector } = this.config;

    if (writeMode !== "native_only" && externalConnector) {
      try {
        const result = await externalConnector.get(id);
        if (result) return result;
      } catch {
        // fall through to native
      }
    }

    return nativeMemoryConnector.get(id);
  }

  async delete(id: string): Promise<void> {
    const { writeMode, externalConnector } = this.config;

    await nativeMemoryConnector.delete(id);

    if (writeMode !== "native_only" && externalConnector) {
      await externalConnector.delete(id).catch((err) => {
        console.warn("[MemoryRouter] External delete failed:", err);
      });
    }
  }

  async list(filters: MemoryFilters): Promise<MemoryRecord[]> {
    return nativeMemoryConnector.list(filters);
  }

  updateConfig(config: Partial<MemoryRouterConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export function createMemoryRouter(config: MemoryRouterConfig): MemoryRouter {
  return new MemoryRouter(config);
}
