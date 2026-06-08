import { Database } from "bun:sqlite";
import { existsSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const DBDIR = `${process.env.HOME}/Library/Application Support/app.qubit.agent/db`;
const DB_PATH = join(DBDIR, "core.sqlite");

if (!existsSync(DB_PATH)) {
  console.error("DB not found:", DB_PATH);
  process.exit(1);
}

const before = statSync(DB_PATH).size;
console.log(`DB size before: ${(before / 1024 / 1024 / 1024).toFixed(2)} GB`);

const db = new Database(DB_PATH);
db.exec("PRAGMA foreign_keys=OFF;");
db.exec("PRAGMA journal_mode=WAL;");

const STD_TABLES = [
  "a2a_message",
  "agent_checkpoint_snapshot",
  "agent_instance",
  "agent_pnl_attribution",
  "agent_skill_run",
  "agent_step",
  "analyst_research_job",
  "analyst_signal",
  "audit_log",
  "chat_message_workflow_link",
  "connector_call_log",
  "debate_session",
  "discovery_job",
  "eval_case_result",
  "exec_call_log",
  "experience_op_log",
  "indicator_strategy_script",
  "intent_order",
  "llm_call_log",
  "mcp_call_log",
  "order_intent",
  "research_team_interaction",
  "risk_veto_log",
  "sandbox_violation_log",
  "scheduled_job_run",
  "screener_run",
  "session_memory",
  "signal_fusion_result",
  "skill_recall_log",
  "tool_call_log",
  "tool_gap_log",
  "trader_context_message",
  "workflow_compensation_task",
  "workflow_hitl_request",
  "workflow_quality_snapshot",
];

const totalWf = (db.query("SELECT COUNT(*) AS c FROM workflow_run").get() as any).c;
console.log(`workflow_run total: ${totalWf}`);

if (totalWf <= 10) {
  console.log("Already <= 10 workflows; nothing to purge.");
  process.exit(0);
}

db.exec("BEGIN TRANSACTION;");

try {
  db.exec(`CREATE TEMP TABLE keep_wf AS
           SELECT id FROM workflow_run ORDER BY created_at DESC LIMIT 10;`);
  const keepCount = (db.query("SELECT COUNT(*) AS c FROM keep_wf").get() as any).c;
  console.log(`keeping: ${keepCount} workflows`);

  for (const t of STD_TABLES) {
    const before = (db.query(`SELECT COUNT(*) AS c FROM ${t}`).get() as any).c;
    const res = db.run(
      `DELETE FROM ${t}
       WHERE workflow_run_id IS NOT NULL
         AND workflow_run_id NOT IN (SELECT id FROM keep_wf);`,
    );
    const after = (db.query(`SELECT COUNT(*) AS c FROM ${t}`).get() as any).c;
    console.log(`  ${t.padEnd(35)}: ${before} -> ${after} (deleted ${res.changes})`);
  }

  // 特殊关联表
  for (const [tbl, where] of [
    ["experience", `scope='workflow' AND scope_id NOT IN (SELECT id FROM keep_wf)`],
    ["reflection_run", `subject_run_id IS NOT NULL AND subject_run_id NOT IN (SELECT id FROM keep_wf)`],
    ["alert_event", `scope_type='workflow' AND scope_id NOT IN (SELECT id FROM keep_wf)`],
  ] as const) {
    try {
      const before = (db.query(`SELECT COUNT(*) AS c FROM ${tbl}`).get() as any).c;
      const res = db.run(`DELETE FROM ${tbl} WHERE ${where};`);
      const after = (db.query(`SELECT COUNT(*) AS c FROM ${tbl}`).get() as any).c;
      console.log(`  ${tbl.padEnd(35)}: ${before} -> ${after} (deleted ${res.changes})`);
    } catch (e: any) {
      console.warn(`  ${tbl}: ${e.message}`);
    }
  }

  // 最后清 workflow_run 本身
  const wfBefore = (db.query("SELECT COUNT(*) AS c FROM workflow_run").get() as any).c;
  const res = db.run("DELETE FROM workflow_run WHERE id NOT IN (SELECT id FROM keep_wf);");
  const wfAfter = (db.query("SELECT COUNT(*) AS c FROM workflow_run").get() as any).c;
  console.log(`  workflow_run                       : ${wfBefore} -> ${wfAfter} (deleted ${res.changes})`);

  db.exec("COMMIT;");
  console.log("\ncommitted.");
} catch (e: any) {
  db.exec("ROLLBACK;");
  console.error("rolled back due to error:", e.message);
  process.exit(2);
}

console.log("\nrunning VACUUM (may take a while)...");
const t0 = Date.now();
db.exec("VACUUM;");
console.log(`VACUUM done in ${Date.now() - t0} ms`);

db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
db.close();

const after = statSync(DB_PATH).size;
console.log(`\nDB size after:  ${(after / 1024 / 1024 / 1024).toFixed(2)} GB  (freed ${((before - after) / 1024 / 1024 / 1024).toFixed(2)} GB)`);
