import * as lancedb from "@lancedb/lancedb";
import { mkdir } from "node:fs/promises";
import type { Schema } from "apache-arrow";

let _db: lancedb.Connection | null = null;

function getDbPath(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  return `${home}/.quant-agent/db/memory.lance`;
}

export async function getLanceDb(): Promise<lancedb.Connection> {
  if (_db) return _db;

  const dbPath = getDbPath();
  await mkdir(dbPath, { recursive: true });

  _db = await lancedb.connect(dbPath);
  return _db;
}

// ─── Table names ─────────────────────────────────────────────────────────────

export const LANCE_TABLES = {
  LONGTERM_MEMORY: "longterm_memory_vectors",
  FACTOR_EMBEDDINGS: "factor_embeddings",
  STRATEGY_EMBEDDINGS: "strategy_embeddings",
  REGIME_EMBEDDINGS: "regime_embeddings",
} as const;

export type LanceTableName = (typeof LANCE_TABLES)[keyof typeof LANCE_TABLES];

// ─── Vector record shapes ─────────────────────────────────────────────────────

export interface LongtermMemoryVector {
  id: string;
  longtermMemoryId: string;
  vector: number[];
  text: string;
  memoryType: string;
  scope: string;
  scopeId: string;
  asofTime: string;
  createdAt: string;
}

export interface FactorEmbeddingVector {
  id: string;
  factorDefinitionId: string;
  vector: number[];
  name: string;
  category: string;
  description: string;
  createdAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Open or create a LanceDB table.
 * If the table doesn't exist yet, it's created lazily on first insert.
 */
export async function openOrCreateTable(
  tableName: LanceTableName,
  sampleRecord?: Record<string, unknown>
): Promise<lancedb.Table> {
  const db = await getLanceDb();
  const tableNames = await db.tableNames();

  if (tableNames.includes(tableName)) {
    return db.openTable(tableName);
  }

  if (!sampleRecord) {
    throw new Error(
      `Table "${tableName}" does not exist and no sample record was provided to create it.`
    );
  }

  return db.createTable(tableName, [sampleRecord]);
}

/**
 * Vector similarity search wrapper.
 */
export async function vectorSearch(
  tableName: LanceTableName,
  queryVector: number[],
  limit = 10,
  filter?: string
): Promise<Record<string, unknown>[]> {
  const db = await getLanceDb();
  const tableNames = await db.tableNames();
  if (!tableNames.includes(tableName)) return [];

  const table = await db.openTable(tableName);
  let query = table.vectorSearch(queryVector).limit(limit);
  if (filter) {
    query = query.where(filter);
  }
  return query.toArray();
}

export async function closeLanceDb(): Promise<void> {
  _db = null;
}
