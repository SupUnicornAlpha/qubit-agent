import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB_PATH = join(
  process.env.HOME!,
  "Library/Application Support/app.qubit.agent/db/core.sqlite",
);
const db = new Database(DB_PATH, { readonly: true });

console.log("====== 5 大能力的现状评估（基于保留的 10 个 workflow + 全库定义） ======\n");

console.log("==== 1. 行情研究 (research / explore) ====");
const wfRows = db
  .query(`SELECT id, mode, status, substr(goal,1,80) AS goal, created_at
          FROM workflow_run ORDER BY created_at DESC`)
  .all() as any[];
for (const r of wfRows) {
  const ckpt = (db.query(`SELECT COUNT(DISTINCT thread_id) AS c FROM langgraph_checkpoint WHERE thread_id LIKE ?`).get(`${r.id}%`) as any).c;
  const sig = (db.query(`SELECT COUNT(*) AS c FROM analyst_signal WHERE workflow_run_id=?`).get(r.id) as any).c;
  const fusion = (db.query(`SELECT COUNT(*) AS c FROM signal_fusion_result WHERE workflow_run_id=?`).get(r.id) as any).c;
  const tc = (db.query(`SELECT COUNT(*) AS c FROM tool_call_log WHERE workflow_run_id=?`).get(r.id) as any).c;
  console.log(`  ${r.id.slice(0, 8)}  ${r.status.padEnd(10)} ${r.mode.padEnd(10)} signals=${sig} fusion=${fusion} tools=${tc} ckpt-threads=${ckpt}  ${r.goal}`);
}

console.log("\n==== 2. 股票推荐 (analyst_signal + signal_fusion) ====");
const sigRows = db
  .query(`SELECT analyst_role, signal, COUNT(*) AS c, AVG(confidence) AS avgconf
          FROM analyst_signal GROUP BY analyst_role, signal`)
  .all() as any[];
for (const r of sigRows) {
  console.log(`  ${r.analyst_role.padEnd(25)} ${r.signal.padEnd(10)} x${r.c}  avg_conf=${r.avgconf?.toFixed(2)}`);
}
const totalFusion = (db.query("SELECT COUNT(*) AS c FROM signal_fusion_result").get() as any).c;
const fusionRows = db
  .query("SELECT fused_signal, COUNT(*) AS c, AVG(fused_confidence) AS conf, SUM(debate_triggered) AS debates FROM signal_fusion_result GROUP BY fused_signal")
  .all() as any[];
console.log(`  signal_fusion_result total=${totalFusion}`);
for (const r of fusionRows) {
  console.log(`    fusion ${r.fused_signal}: x${r.c}  avg_conf=${r.conf?.toFixed(2)} debates=${r.debates}`);
}

console.log("\n==== 3. 因子生成 (factor_definition) ====");
const factorTotal = (db.query("SELECT COUNT(*) AS c FROM factor_definition").get() as any).c;
const factorByCat = db
  .query("SELECT category, COUNT(*) AS c FROM factor_definition GROUP BY category ORDER BY c DESC LIMIT 10")
  .all() as any[];
console.log(`  factor_definition total=${factorTotal}`);
for (const r of factorByCat) console.log(`    ${r.category}: ${r.c}`);

console.log("\n  最近 5 个 factor:");
const recent5Factors = db
  .query(`SELECT name, category, expr, lang, universe, horizon, status, created_at FROM factor_definition ORDER BY created_at DESC LIMIT 5`)
  .all() as any[];
for (const f of recent5Factors) {
  console.log(`    ${f.created_at.slice(0,16)} [${f.status}] ${f.category.padEnd(12)} ${f.name}  uni=${f.universe} horizon=${f.horizon}d lang=${f.lang}`);
  console.log(`      expr: ${(f.expr ?? "").slice(0, 100)}`);
}

console.log("\n==== 4. 策略生成 (strategy_composition + strategy_version) ====");
const sc = (db.query("SELECT COUNT(*) AS c FROM strategy_composition").get() as any).c;
console.log(`  strategy_composition total=${sc}`);
try {
  const sv = (db.query("SELECT COUNT(*) AS c FROM strategy_version").get() as any).c;
  console.log(`  strategy_version total=${sv}`);
  const recent5Strats = db
    .query("SELECT strategy_id, version_tag, logic_hash, created_at FROM strategy_version ORDER BY created_at DESC LIMIT 5")
    .all() as any[];
  for (const s of recent5Strats) console.log(`    ${s.created_at?.slice(0,16)} ${s.strategy_id}@${s.version_tag}  logic=${(s.logic_hash ?? "").slice(0, 10)}`);
} catch (e: any) {
  console.log("  (no strategy_version table)");
}
const bt = (db.query("SELECT COUNT(*) AS c FROM backtest_run").get() as any).c;
const btJob = (db.query("SELECT COUNT(*) AS c FROM backtest_job").get() as any).c;
console.log(`  backtest_run=${bt}  backtest_job=${btJob}`);

console.log("\n==== 5. 实时交易 (intent_order / order_intent / exec_call_log) ====");
for (const t of ["intent_order", "order_intent", "exec_call_log", "trader_context_message", "risk_veto_log"]) {
  try {
    const c = (db.query(`SELECT COUNT(*) AS c FROM ${t}`).get() as any).c;
    console.log(`  ${t.padEnd(25)} count=${c}`);
  } catch (e: any) {
    console.log(`  ${t}: ${e.message}`);
  }
}

console.log("\n==== 6. agent_definition 概览 ====");
const ads = db.query("SELECT id, name, version, length(tools_json) AS tools_len, length(skills_json) AS skills_len FROM agent_definition ORDER BY id").all() as any[];
for (const a of ads) console.log(`  ${a.id.padEnd(40)} v${a.version} tools=${a.tools_len}B skills=${a.skills_len}B`);

console.log("\n==== 7. agent_skill 概览 ====");
const skills = db.query("SELECT name, category, source, state, use_count, success_count, fail_count FROM agent_skill ORDER BY use_count DESC, name LIMIT 20").all() as any[];
for (const s of skills) console.log(`  ${s.name.padEnd(40)} ${s.category.padEnd(12)} ${s.source.padEnd(15)} ${s.state.padEnd(8)} use=${s.use_count} ok=${s.success_count} err=${s.fail_count}`);
const totalSkills = (db.query("SELECT COUNT(*) AS c FROM agent_skill").get() as any).c;
console.log(`  agent_skill total=${totalSkills}`);

console.log("\n==== 8. tool_call_log 工具成功率（10 wf 内）====");
const toolStats = db
  .query(`SELECT tool_name, status, COUNT(*) AS c FROM tool_call_log GROUP BY tool_name, status ORDER BY tool_name, status`)
  .all() as any[];
const byTool: Record<string, { ok: number; err: number }> = {};
for (const r of toolStats) {
  byTool[r.tool_name] ??= { ok: 0, err: 0 };
  if (r.status === "success") byTool[r.tool_name]!.ok = r.c;
  else byTool[r.tool_name]!.err = r.c;
}
const entries = Object.entries(byTool).sort((a,b)=> (b[1].ok+b[1].err)-(a[1].ok+a[1].err));
for (const [tool, st] of entries) {
  const total = st.ok + st.err;
  const rate = total ? (st.ok / total * 100).toFixed(0) : "0";
  console.log(`  ${tool.padEnd(35)} total=${total.toString().padStart(3)} ok=${st.ok.toString().padStart(3)} err=${st.err.toString().padStart(3)} (${rate}%)`);
}

console.log("\n==== 9. agent_skill_run（skill 实际被调用情况）====");
const skillRuns = db.query("SELECT COUNT(*) AS c FROM agent_skill_run").get() as any;
console.log(`  agent_skill_run total=${skillRuns.c}`);
const skillByOutcome = db.query("SELECT outcome, COUNT(*) AS c FROM agent_skill_run GROUP BY outcome").all() as any[];
for (const r of skillByOutcome) console.log(`    outcome=${r.outcome}: ${r.c}`);
const skillByName = db.query(`
  SELECT s.name, COUNT(*) AS c
  FROM agent_skill_run r LEFT JOIN agent_skill s ON s.id = r.skill_id
  GROUP BY s.name`).all() as any[];
for (const r of skillByName) console.log(`    skill ${r.name ?? "(unknown)"}: ${r.c}`);
