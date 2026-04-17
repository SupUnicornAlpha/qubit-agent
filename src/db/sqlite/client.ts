import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import * as schema from "./schema";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

let _db: DbClient | null = null;

function getDbPath(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  return `${home}/.quant-agent/db/core.sqlite`;
}

export async function getDb(): Promise<DbClient> {
  if (_db) return _db;

  const dbPath = getDbPath();
  await mkdir(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);

  // Enable WAL mode for concurrent reads
  sqlite.exec("PRAGMA journal_mode=WAL;");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  sqlite.exec("PRAGMA synchronous=NORMAL;");

  _db = drizzle(sqlite, { schema });
  return _db;
}

export function closeDb(): void {
  _db = null;
}
