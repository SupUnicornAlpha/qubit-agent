/**
 * Runtime DB handle for policy/loop facts — production name (not "ForTesting").
 * Still the same underlying bun:sqlite connection initialized by getDb().
 */

import type { Database } from "bun:sqlite";
import { getDb, getSqliteForTesting } from "../../../db/sqlite/client";

export async function ensureRuntimeSqlite(): Promise<Database> {
  await getDb();
  return getSqliteForTesting();
}

export function getRuntimeSqlite(): Database {
  return getSqliteForTesting();
}
