export { getDb, closeDb } from "./sqlite/client";
export { getDuckDb, closeDuckDb, queryAnalytics } from "./duckdb/client";
export { getLanceDb, closeLanceDb, openOrCreateTable, vectorSearch, LANCE_TABLES } from "./lancedb/client";
export type { LanceTableName, LongtermMemoryVector, FactorEmbeddingVector } from "./lancedb/client";
