import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getBundledMigrationsDir } from "../../runtime/app-paths";
import { getDb } from "./client";

/** 开发：源码旁 migrations；安装包：`$QUBIT_APP_ROOT/db/migrations` */
function migrationsDir(): string {
  const bundled = getBundledMigrationsDir();
  if (existsSync(bundled)) return bundled;
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
