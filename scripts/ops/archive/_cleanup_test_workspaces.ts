/**
 * 一次性清理：清除测试残留的 workspace / project 及其全部衍生数据。
 *
 * 背景（2026-06 WS 治理）：~190 个测试历史上把 workspace/project 直写进真实生产库
 * （~/.quant-agent），攒出 139 个 workspace（137 个 owner=test/tester/t）、604 个 project
 * （其中 Default Workspace 下 468 个全是 fixture 残留）。本脚本一次性清干净，只留：
 *   - A2A Pool ws（owner=system）及其全部数据
 *   - Default Workspace ws（owner=local-user）本体（不删 ws 行）
 *   - 规范默认 project 00000000-0000-4000-8000-localproj0001（若已存在则保留）
 *
 * 安全：
 *   - 运行前调用方已备份 core.sqlite（.bak-before-ws-cleanup-*）。
 *   - 全程单事务 + PRAGMA foreign_keys=OFF，完成后 PRAGMA foreign_key_check 复核无悬挂引用才 COMMIT。
 *   - 显式打开 ~/.quant-agent 真实库，不依赖 config。
 *   - 删除顺序严格 子表→父表，覆盖经 project_id / workflow_run_id 关联的完整 FK 树
 *     （含 strategy→strategy_version→backtest_run/order_intent/... 三四级链）。
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const A2A_WS = "00000000-0000-4000-8000-a2a000000003";
const USER_WS = "00000000-0000-4000-8000-localuser0001";
const CANON_PROJ = "00000000-0000-4000-8000-localproj0001";

const DB_PATH = join(homedir(), ".quant-agent", "db", "core.sqlite");
if (!existsSync(DB_PATH)) {
  console.error("DB not found:", DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA foreign_keys=OFF;");

const testWs = (db.query(`SELECT id FROM workspace WHERE owner IN ('test','tester','t')`).all() as any[]).map((r) => r.id as string);
const wsList = testWs.map((id) => `'${id}'`).join(",") || "''";
const projRows = db.query(
  `SELECT id FROM project WHERE workspace_id IN (${wsList})
   UNION
   SELECT id FROM project WHERE workspace_id='${USER_WS}' AND id != '${CANON_PROJ}'`
).all() as any[];
const projIds = projRows.map((r) => r.id as string);
const P = projIds.map((id) => `'${id}'`).join(",") || "''";

const wfIds = (db.query(`SELECT id FROM workflow_run WHERE project_id IN (${P})`).all() as any[]).map((r) => r.id as string);
const W = wfIds.map((id) => `'${id}'`).join(",") || "''";

console.log(`to delete: workspace=${testWs.length}, project=${projIds.length}, workflow_run=${wfIds.length}`);

db.exec("BEGIN");
try {
  let total = 0;
  const del = (label: string, sql: string) => {
    try {
      const r = db.run(sql);
      if (r.changes > 0) console.log(`  ${label.padEnd(42)} deleted ${r.changes}`);
      total += r.changes;
    } catch (e: any) {
      console.warn(`  ${label}: ${e.message}`);
    }
  };

  // strategy_runtime 子树（→ indicator_strategy_script CASCADE；自身有 5 个 CASCADE 子表）。
  // 给定一个会选出 indicator_strategy_script.id 的子查询，先清 runtime 子表 → runtime 本身。
  const purgeStrategyRuntime = (scriptIdSubquery: string, tag: string) => {
    const rt = `(SELECT id FROM strategy_runtime WHERE strategy_script_id IN (${scriptIdSubquery}))`;
    for (const c of ["strategy_runtime_log", "strategy_position_snapshot", "strategy_signal_dedup", "strategy_pnl_snapshot"]) {
      del(`${c} (${tag})`, `DELETE FROM ${c} WHERE strategy_runtime_id IN ${rt}`);
    }
    del(`agent_pnl_attribution (${tag})`, `UPDATE agent_pnl_attribution SET strategy_runtime_id=NULL WHERE strategy_runtime_id IN ${rt}`);
    del(`strategy_runtime (${tag})`, `DELETE FROM strategy_runtime WHERE strategy_script_id IN (${scriptIdSubquery})`);
  };

  // ============ A) workflow_run 关联子树（子→父） ============
  if (wfIds.length > 0) {
    // 三级：fill ← broker_order ← order_intent(wf)
    del("fill", `DELETE FROM fill WHERE broker_order_id IN (SELECT id FROM broker_order WHERE order_intent_id IN (SELECT id FROM order_intent WHERE workflow_run_id IN (${W})))`);
    // 二级：经 order_intent / intent_order / debate_session / screener_run / agent_step / agent_instance
    for (const [t, col, via] of [
      ["broker_order", "order_intent_id", "order_intent"],
      ["execution_task", "order_intent_id", "order_intent"],
      ["risk_decision", "order_intent_id", "order_intent"],
      ["risk_hit_log", "order_intent_id", "order_intent"],
      ["risk_review_ticket", "order_intent_id", "order_intent"],
      ["broker_order_event", "intent_order_id", "intent_order"],
      ["execution_confirm_ticket", "intent_order_id", "intent_order"],
      ["execution_report", "intent_order_id", "intent_order"],
      ["intent_deviation", "intent_order_id", "intent_order"],
      ["debate_turn", "debate_session_id", "debate_session"],
      ["debate_verdict", "debate_session_id", "debate_session"],
      ["screener_candidate", "screener_run_id", "screener_run"],
      ["tool_call_log", "agent_step_id", "agent_step"],
      ["sandbox_violation_log", "agent_instance_id", "agent_instance"],
    ] as const) {
      del(t, `DELETE FROM ${t} WHERE ${col} IN (SELECT id FROM ${via} WHERE workflow_run_id IN (${W}))`);
    }
    // 直接 workflow_run_id 关联
    for (const t of [
      "a2a_message", "agent_checkpoint_snapshot", "exec_call_log", "agent_step", "mcp_call_log",
      "llm_call_log", "skill_recall_log", "agent_instance", "analyst_signal", "analyst_research_job",
      "chat_message_workflow_link", "debate_session", "intent_order", "order_intent",
      "research_team_interaction", "risk_veto_log", "screener_run", "session_memory",
      "signal_fusion_result", "trader_context_message", "workflow_compensation_task",
      "workflow_quality_snapshot", "workflow_hitl_request", "scheduled_job_run",
    ]) {
      del(t, `DELETE FROM ${t} WHERE workflow_run_id IN (${W})`);
    }
    // set-null（保留审计/统计行，断开引用）
    for (const t of ["audit_log", "eval_case_result", "indicator_strategy_script", "agent_skill_run"]) {
      del(`${t} (set null wf)`, `UPDATE ${t} SET workflow_run_id=NULL WHERE workflow_run_id IN (${W})`);
    }
    del("workflow_run", `DELETE FROM workflow_run WHERE id IN (${W})`);
  }

  // ============ B) project 关联子树（子→父，全部按 project_id IN P 收口） ============
  if (projIds.length > 0) {
    // strategy 链：strategy_genome ← (backtest_run | gene_generation | strategy_version); strategy_composition ← strategy_version; backtest/order/sim/exp ← strategy_version
    del("strategy_genome (via project)", `DELETE FROM strategy_genome WHERE project_id IN (${P})`);
    del("strategy_gene (via project)", `DELETE FROM strategy_gene WHERE project_id IN (${P})`);
    del("gene_generation (via project)", `DELETE FROM gene_generation WHERE project_id IN (${P})`);
    del("strategy_composition", `DELETE FROM strategy_composition WHERE strategy_version_id IN (SELECT sv.id FROM strategy_version sv JOIN strategy s ON sv.strategy_id=s.id WHERE s.project_id IN (${P}))`);
    del("backtest_run", `DELETE FROM backtest_run WHERE strategy_version_id IN (SELECT sv.id FROM strategy_version sv JOIN strategy s ON sv.strategy_id=s.id WHERE s.project_id IN (${P}))`);
    del("simulation_run", `DELETE FROM simulation_run WHERE strategy_version_id IN (SELECT sv.id FROM strategy_version sv JOIN strategy s ON sv.strategy_id=s.id WHERE s.project_id IN (${P}))`);
    del("research_experiment", `DELETE FROM research_experiment WHERE strategy_version_id IN (SELECT sv.id FROM strategy_version sv JOIN strategy s ON sv.strategy_id=s.id WHERE s.project_id IN (${P}))`);
    del("strategy_version", `DELETE FROM strategy_version WHERE strategy_id IN (SELECT id FROM strategy WHERE project_id IN (${P}))`);
    del("strategy", `DELETE FROM strategy WHERE project_id IN (${P})`);

    // factor 链
    del("factor_evaluation", `DELETE FROM factor_evaluation WHERE factor_id IN (SELECT id FROM factor_definition WHERE project_id IN (${P}))`);
    del("factor_definition", `DELETE FROM factor_definition WHERE project_id IN (${P})`);

    // risk_rule 链
    del("risk_decision (via rule)", `DELETE FROM risk_decision WHERE risk_rule_id IN (SELECT id FROM risk_rule WHERE project_id IN (${P}))`);
    del("risk_hit_log (via rule)", `DELETE FROM risk_hit_log WHERE risk_rule_id IN (SELECT id FROM risk_rule WHERE project_id IN (${P}))`);
    del("risk_rule", `DELETE FROM risk_rule WHERE project_id IN (${P})`);

    // rule_definition 链
    del("rule_evaluation_log", `DELETE FROM rule_evaluation_log WHERE rule_id IN (SELECT id FROM rule_definition WHERE project_id IN (${P}))`);
    del("rule_definition", `DELETE FROM rule_definition WHERE project_id IN (${P})`);

    // agent_skill 链
    del("agent_skill_run (via skill)", `DELETE FROM agent_skill_run WHERE skill_id IN (SELECT id FROM agent_skill WHERE project_id IN (${P}))`);
    del("skill_recall_log (via skill)", `DELETE FROM skill_recall_log WHERE skill_id IN (SELECT id FROM agent_skill WHERE project_id IN (${P}))`);
    del("agent_skill", `DELETE FROM agent_skill WHERE project_id IN (${P})`);

    // memory_backend_config 链（workspace-scoped 但其子表先清）
    del("memory_sync_log", `DELETE FROM memory_sync_log WHERE memory_backend_config_id IN (SELECT id FROM memory_backend_config WHERE workspace_id IN (${wsList}))`);

    // scheduled_job 链
    del("scheduled_job_run (via job)", `DELETE FROM scheduled_job_run WHERE job_id IN (SELECT id FROM scheduled_job WHERE project_id IN (${P}))`);
    del("scheduled_job", `DELETE FROM scheduled_job WHERE project_id IN (${P})`);

    // chat_session 链
    purgeStrategyRuntime(`SELECT id FROM indicator_strategy_script WHERE session_id IN (SELECT id FROM chat_session WHERE project_id IN (${P}))`, "proj sess");
    del("indicator_strategy_script (via sess)", `DELETE FROM indicator_strategy_script WHERE session_id IN (SELECT id FROM chat_session WHERE project_id IN (${P}))`);
    del("chat_message (via sess)", `DELETE FROM chat_message WHERE session_id IN (SELECT id FROM chat_session WHERE project_id IN (${P}))`);
    del("chat_session", `DELETE FROM chat_session WHERE project_id IN (${P})`);

    // 其余直接 project_id 关联的表
    for (const t of [
      "dataset_snapshot", "mcp_server_config", "midterm_memory", "communication_channel",
      "mcp_tool_binding", "mcp_catalog_install", "skill_market_install", "discovery_job",
      "skill_curator_run", "skill_evolution_run", "skill_promotion_run", "tool_gap_log",
      "tool_gap_run", "auto_install_proposal", "auto_installer_run",
    ]) {
      del(t, `DELETE FROM ${t} WHERE project_id IN (${P})`);
    }

    del("project", `DELETE FROM project WHERE id IN (${P})`);
  }

  // ============ C) workspace 关联（project 已清；剩 workspace 直接子表） ============
  if (testWs.length > 0) {
    del("memory_backend_config", `DELETE FROM memory_backend_config WHERE workspace_id IN (${wsList})`);
    del("communication_channel (ws)", `DELETE FROM communication_channel WHERE workspace_id IN (${wsList})`);
    // ws-scoped chat_session 的子表（indicator_strategy_script / chat_message）必须先清，再删 session。
    purgeStrategyRuntime(`SELECT id FROM indicator_strategy_script WHERE session_id IN (SELECT id FROM chat_session WHERE workspace_id IN (${wsList}))`, "ws sess");
    del("indicator_strategy_script (ws sess)", `DELETE FROM indicator_strategy_script WHERE session_id IN (SELECT id FROM chat_session WHERE workspace_id IN (${wsList}))`);
    del("chat_message (ws sess)", `DELETE FROM chat_message WHERE session_id IN (SELECT id FROM chat_session WHERE workspace_id IN (${wsList}))`);
    del("chat_session (ws)", `DELETE FROM chat_session WHERE workspace_id IN (${wsList})`);
    del("scheduled_job (ws)", `DELETE FROM scheduled_job WHERE workspace_id IN (${wsList})`);
    del("mcp_catalog_install (ws)", `DELETE FROM mcp_catalog_install WHERE workspace_id IN (${wsList})`);
    del("agent_group_member", `DELETE FROM agent_group_member WHERE group_id IN (SELECT id FROM agent_group WHERE workspace_id IN (${wsList}))`);
    del("agent_group", `DELETE FROM agent_group WHERE workspace_id IN (${wsList})`);
    del("workspace", `DELETE FROM workspace WHERE id IN (${wsList})`);
  }

  // 复核 FK 完整性
  const fkErrors = db.query("PRAGMA foreign_key_check").all() as any[];
  if (fkErrors.length > 0) {
    console.error(`FK check FAILED (${fkErrors.length} dangling):`, JSON.stringify(fkErrors.slice(0, 30)));
    throw new Error("foreign_key_check failed");
  }

  db.exec("COMMIT");
  console.log(`\ncommitted. total rows affected: ${total}`);
} catch (e: any) {
  db.exec("ROLLBACK");
  console.error("ROLLBACK:", e.message);
  db.close();
  process.exit(2);
}

db.exec("PRAGMA foreign_keys=ON;");
db.exec("VACUUM;");
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

console.log("\n=== AFTER ===");
console.log("workspace:", (db.query("SELECT COUNT(*) n FROM workspace").get() as any).n);
console.log("project:", (db.query("SELECT COUNT(*) n FROM project").get() as any).n);
console.log("workflow_run:", (db.query("SELECT COUNT(*) n FROM workflow_run").get() as any).n);
for (const r of db.query("SELECT id,name,owner FROM workspace ORDER BY owner").all() as any[])
  console.log("  ws:", r.id, "|", r.name, "|", r.owner);
db.close();
