/**
 * One-shot: hard-delete all chat sessions (+ their workflows/messages).
 * Does NOT delete project-scoped factor_definition / strategy catalogs.
 *
 *   QUBIT_DATA_DIR=... bun scripts/_cleanup_all_sessions.ts
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getDb } from "../src/db/sqlite/client";
import { chatSession } from "../src/db/sqlite/schema";
import {
  hardDeleteChatSession,
  hardDeleteWorkflowRun,
} from "../src/runtime/workflow/hard-delete";

const dataDir = process.env.QUBIT_DATA_DIR;
if (!dataDir) {
  console.error("QUBIT_DATA_DIR is required");
  process.exit(1);
}
const dbPath = join(dataDir, "db", "core.sqlite");

function counts(label: string) {
  const raw = new Database(dbPath, { readonly: true });
  const q = (sql: string) => (raw.query(sql).get() as { c: number }).c;
  const out = {
    label,
    sessions: q("SELECT COUNT(*) AS c FROM chat_session"),
    messages: q("SELECT COUNT(*) AS c FROM chat_message"),
    workflows: q("SELECT COUNT(*) AS c FROM workflow_run"),
    factors: q("SELECT COUNT(*) AS c FROM factor_definition"),
    strategies: q("SELECT COUNT(*) AS c FROM strategy"),
    scripts: q("SELECT COUNT(*) AS c FROM indicator_strategy_script"),
  };
  raw.close();
  return out;
}

console.log(JSON.stringify(counts("before"), null, 2));

const db = await getDb();
const rows = await db.select({ id: chatSession.id }).from(chatSession);
console.log(`deleting ${rows.length} sessions...`);

let ok = 0;
const errors: Array<{ id: string; err: string }> = [];
for (const row of rows) {
  try {
    const r = await hardDeleteChatSession(row.id);
    ok += 1;
    console.log(`ok session ${row.id.slice(0, 8)} wfs=${r.workflowRunIds.length}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push({ id: row.id, err: msg });
    console.error(`FAIL ${row.id}: ${msg}`);
  }
}

const raw = new Database(dbPath);
const orphanWfs = raw
  .query(
    `SELECT id FROM workflow_run
     WHERE session_id IS NULL
        OR session_id NOT IN (SELECT id FROM chat_session)`
  )
  .all() as Array<{ id: string }>;
raw.close();

if (orphanWfs.length > 0) {
  console.log(`also hard-deleting ${orphanWfs.length} orphan workflows...`);
  for (const w of orphanWfs) {
    try {
      await hardDeleteWorkflowRun(w.id);
      console.log(`ok wf ${w.id.slice(0, 8)}`);
    } catch (e) {
      console.error(`FAIL wf ${w.id}:`, e instanceof Error ? e.message : e);
    }
  }
}

console.log(JSON.stringify({ deletedSessions: ok, errors }, null, 2));
console.log(JSON.stringify(counts("after"), null, 2));
