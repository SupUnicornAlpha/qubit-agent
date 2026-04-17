import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb } from "./client";

export async function runMigrations(): Promise<void> {
  const db = await getDb();
  await migrate(db, {
    migrationsFolder: "./src/db/sqlite/migrations",
  });
  console.log("[DB] SQLite migrations applied.");
}

if (import.meta.main) {
  await runMigrations();
}
