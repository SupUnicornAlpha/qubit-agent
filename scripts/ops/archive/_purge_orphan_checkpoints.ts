import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = join(
  process.env.HOME!,
  "Library/Application Support/app.qubit.agent/db/core.sqlite",
);

if (!existsSync(DB_PATH)) {
  console.error("DB not found");
  process.exit(1);
}

const before = statSync(DB_PATH).size;
console.log(`DB before: ${(before / 1024 / 1024 / 1024).toFixed(2)} GB`);

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA foreign_keys=OFF;");

const keepWf = db
  .query("SELECT id FROM workflow_run")
  .all()
  .map((r: any) => r.id) as string[];
console.log(`keep workflows: ${keepWf.length}`);

db.exec("BEGIN TRANSACTION;");
try {
  db.exec(`CREATE TEMP TABLE keep_wf(id TEXT PRIMARY KEY);`);
  const ins = db.prepare("INSERT INTO keep_wf(id) VALUES (?)");
  for (const id of keepWf) ins.run(id);

  // thread_id 取前 36 字符 = UUID 长度
  // 若 substring 不在 keep_wf 中，就是孤儿
  for (const t of ["langgraph_checkpoint", "langgraph_checkpoint_write"] as const) {
    const before = (db.query(`SELECT COUNT(*) AS c FROM ${t}`).get() as any).c;
    const res = db.run(
      `DELETE FROM ${t}
       WHERE substr(thread_id, 1, 36) NOT IN (SELECT id FROM keep_wf);`,
    );
    const after = (db.query(`SELECT COUNT(*) AS c FROM ${t}`).get() as any).c;
    console.log(`  ${t.padEnd(30)}: ${before} -> ${after} (deleted ${res.changes})`);
  }

  db.exec("COMMIT;");
} catch (e: any) {
  db.exec("ROLLBACK;");
  console.error("rolled back:", e.message);
  process.exit(2);
}

console.log("\nVACUUM ...");
const t0 = Date.now();
db.exec("VACUUM;");
console.log(`VACUUM done in ${Date.now() - t0} ms`);
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
db.close();

const after = statSync(DB_PATH).size;
console.log(`DB after:  ${(after / 1024 / 1024 / 1024).toFixed(2)} GB  (freed ${((before - after) / 1024 / 1024 / 1024).toFixed(2)} GB)`);
