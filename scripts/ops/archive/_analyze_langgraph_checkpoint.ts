import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB_PATH = join(
  process.env.HOME!,
  "Library/Application Support/app.qubit.agent/db/core.sqlite",
);

const db = new Database(DB_PATH, { readonly: true });

console.log("=== langgraph_checkpoint schema ===");
for (const c of db.query("PRAGMA table_info(langgraph_checkpoint)").all() as any[]) {
  console.log(`  ${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PK" : ""}`);
}

console.log("\n=== langgraph_checkpoint_write schema ===");
for (const c of db.query("PRAGMA table_info(langgraph_checkpoint_write)").all() as any[]) {
  console.log(`  ${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PK" : ""}`);
}

console.log("\n=== distinct thread_id 统计 ===");
const distinctThreads = db.query("SELECT COUNT(DISTINCT thread_id) AS c FROM langgraph_checkpoint").get() as any;
console.log(`distinct thread_id in checkpoint: ${distinctThreads.c}`);

console.log("\n=== 当前保留的 10 个 workflow id ===");
const keepWf = db
  .query("SELECT id FROM workflow_run ORDER BY created_at DESC")
  .all()
  .map((r: any) => r.id) as string[];
console.log(keepWf);

// thread_id 通常等于 workflow_run_id 或包含它
console.log("\n=== 检查 thread_id 是否匹配 workflow id ===");
const sample = db
  .query("SELECT thread_id, COUNT(*) AS cnt FROM langgraph_checkpoint GROUP BY thread_id ORDER BY cnt DESC LIMIT 10")
  .all() as any[];
for (const r of sample) {
  const matchesWf = keepWf.includes(r.thread_id) ? "  *KEEP*" : "";
  console.log(`  ${r.thread_id}\t${r.cnt}${matchesWf}`);
}

console.log("\n=== 与 workflow_run.id 的交集统计 ===");
const placeholders = keepWf.map(() => "?").join(",");
const matchedCkptRows = (db
  .query(`SELECT COUNT(*) AS c FROM langgraph_checkpoint WHERE thread_id IN (${placeholders})`)
  .get(...keepWf) as any).c;
const matchedThreads = (db
  .query(`SELECT COUNT(DISTINCT thread_id) AS c FROM langgraph_checkpoint WHERE thread_id IN (${placeholders})`)
  .get(...keepWf) as any).c;
const totalCkptRows = (db.query("SELECT COUNT(*) AS c FROM langgraph_checkpoint").get() as any).c;
console.log(`checkpoint rows belonging to KEEP workflows: ${matchedCkptRows}/${totalCkptRows} (${(matchedCkptRows/totalCkptRows*100).toFixed(1)}%)`);
console.log(`distinct thread_id matching workflow id:    ${matchedThreads}/${keepWf.length}`);
