import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb } from "./client";

/** Resolve migrations next to this file so `bun run dev` works from any cwd. */
function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "migrations");
}

export async function runMigrations(): Promise<void> {
  const db = await getDb();
  await migrate(db, {
    migrationsFolder: migrationsDir(),
  });
  console.log("[DB] SQLite migrations applied.");
}

if (import.meta.main) {
  await runMigrations();
}
