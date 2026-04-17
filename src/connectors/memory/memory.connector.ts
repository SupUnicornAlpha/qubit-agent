import type {
  Connector,
  MemoryConnector,
  MemoryFilters,
  MemoryMetadata,
  MemoryRecord,
} from "../../types/connector";
import { BaseConnector } from "../base.connector";

/**
 * Abstract base for all MemoryConnector implementations.
 *
 * Concrete implementations:
 *   - NativeMemoryConnector (always-on, SQLite + LanceDB)
 *   - Mem0Connector (optional external, mem0-ts SDK)
 *   - GraphRAGConnector (V2 roadmap)
 */
export abstract class BaseMemoryConnector
  extends BaseConnector
  implements MemoryConnector
{
  abstract add(content: string, metadata: MemoryMetadata): Promise<MemoryRecord>;
  abstract search(
    query: string,
    filters: MemoryFilters,
    topK: number
  ): Promise<MemoryRecord[]>;
  abstract get(id: string): Promise<MemoryRecord | null>;
  abstract delete(id: string): Promise<void>;
  abstract list(filters: MemoryFilters): Promise<MemoryRecord[]>;

  protected async onExecute<TOutput>(
    operation: string,
    payload: unknown
  ): Promise<TOutput> {
    const p = payload as Record<string, unknown>;
    switch (operation) {
      case "add":
        return this.add(
          p["content"] as string,
          p["metadata"] as MemoryMetadata
        ) as unknown as TOutput;
      case "search":
        return this.search(
          p["query"] as string,
          (p["filters"] ?? {}) as MemoryFilters,
          (p["topK"] as number) ?? 10
        ) as unknown as TOutput;
      case "get":
        return this.get(p["id"] as string) as unknown as TOutput;
      case "delete":
        await this.delete(p["id"] as string);
        return undefined as TOutput;
      case "list":
        return this.list((p["filters"] ?? {}) as MemoryFilters) as unknown as TOutput;
      default:
        throw new Error(`MemoryConnector: unknown operation "${operation}"`);
    }
  }
}
