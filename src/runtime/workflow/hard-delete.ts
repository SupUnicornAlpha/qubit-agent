/**
 * workflow_run / chat_session 硬删除。
 *
 * 大量表通过外键反向引用 workflow_run.id 与 chat_session.id（FK 默认 ON），
 * 这里在事务中开启 `PRAGMA defer_foreign_keys = ON`，
 * 把所有衍生数据先删掉再删主体，事务提交时再统一校验外键，从而避免被中间状态打断。
 *
 * 注意：所有 DELETE 都通过 bun:sqlite 的 prepare/run，方便统一拿到 `changes` 计数。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { chatMessage, chatSession, scheduledJob, workflowRun } from "../../db/sqlite/schema";

export interface HardDeleteWorkflowResult {
  workflowRunId: string;
  tablesAffected: number;
  details: Record<string, number>;
}

export interface HardDeleteSessionResult {
  sessionId: string;
  workflowRunIds: string[];
  details: Record<string, number>;
}

interface RawSqlite {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: unknown[]) => { changes: number } };
}

function getRawSqlite(db: Awaited<ReturnType<typeof getDb>>): RawSqlite {
  return (db as unknown as { $client: RawSqlite }).$client;
}

/** 直接以 workflow_run_id 关联的衍生表（DELETE 后无需再保留任何引用） */
const WORKFLOW_DIRECT_TABLES = [
  "a2a_message",
  "acp_call",
  "agent_step",
  "mcp_call_log",
  "agent_instance",
  "analyst_signal",
  "chat_message_workflow_link",
  "debate_session",
  "intent_order",
  "order_intent",
  "research_team_interaction",
  "risk_veto_log",
  "screener_run",
  "session_memory",
  "signal_fusion_result",
  "trader_context_message",
  "workflow_compensation_task",
  "workflow_quality_snapshot",
] as const;

/** 反向引用列上仅置空（保留审计与统计），DELETE 时一并执行 */
const WORKFLOW_SET_NULL_TABLES = [
  "audit_log",
  "eval_case_result",
  "indicator_strategy_script",
  "scheduled_job_run",
] as const;

/**
 * 硬删除单个 workflow_run，连带清理所有引用它的衍生数据（agent_*、a2a/acp、screener、order/intent、quality、langgraph_checkpoint 等）。
 */
export async function hardDeleteWorkflowRun(
  workflowRunId: string
): Promise<HardDeleteWorkflowResult> {
  const db = await getDb();
  const existing = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
  if (!existing[0]) {
    return { workflowRunId, tablesAffected: 0, details: {} };
  }

  const details: Record<string, number> = {};
  const sqlite = getRawSqlite(db);

  sqlite.exec("BEGIN");
  try {
    sqlite.exec("PRAGMA defer_foreign_keys = ON");

    // 1) 通过 agent_step / agent_instance 间接关联的子表（先以 IN 子查询删，避免遗漏）。
    const toolCallDel = sqlite
      .prepare(
        "DELETE FROM tool_call_log WHERE agent_step_id IN (SELECT id FROM agent_step WHERE workflow_run_id = ?)"
      )
      .run(workflowRunId);
    details.tool_call_log = toolCallDel.changes;

    const sandboxDel = sqlite
      .prepare(
        "DELETE FROM sandbox_violation_log WHERE agent_instance_id IN (SELECT id FROM agent_instance WHERE workflow_run_id = ?)"
      )
      .run(workflowRunId);
    details.sandbox_violation_log = sandboxDel.changes;

    // 2) 直接以 workflow_run_id 引用的表（defer_foreign_keys 下顺序不强制要求）。
    for (const table of WORKFLOW_DIRECT_TABLES) {
      const r = sqlite.prepare(`DELETE FROM ${table} WHERE workflow_run_id = ?`).run(workflowRunId);
      details[table] = r.changes;
    }

    // 3) 仅置空 workflow_run_id 的反向引用（保留历史）。
    for (const table of WORKFLOW_SET_NULL_TABLES) {
      const r = sqlite
        .prepare(`UPDATE ${table} SET workflow_run_id = NULL WHERE workflow_run_id = ?`)
        .run(workflowRunId);
      details[`${table}_set_null`] = r.changes;
    }

    // 4) LangGraph checkpoint（thread_id 一般 == workflow_run.id；显式清理释放空间）。
    const lgWrite = sqlite
      .prepare("DELETE FROM langgraph_checkpoint_write WHERE thread_id = ?")
      .run(workflowRunId);
    details.langgraph_checkpoint_write = lgWrite.changes;
    const lgCheckpoint = sqlite
      .prepare("DELETE FROM langgraph_checkpoint WHERE thread_id = ?")
      .run(workflowRunId);
    details.langgraph_checkpoint = lgCheckpoint.changes;

    // 5) 最后删 workflow_run 本身。
    const wfDel = sqlite.prepare("DELETE FROM workflow_run WHERE id = ?").run(workflowRunId);
    details.workflow_run = wfDel.changes;

    sqlite.exec("COMMIT");
  } catch (err) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }

  const tablesAffected = Object.values(details).filter((n) => n > 0).length;
  return { workflowRunId, tablesAffected, details };
}

/**
 * 硬删除 chat_session：
 *   - 连带删除该会话下的所有 workflow_run（复用 hardDeleteWorkflowRun）。
 *   - 删除会话内消息、消息↔工作流的链接、IDE 策略脚本（FK 已配置 cascade，这里显式调用以便统计）。
 *   - 删除该会话上的 scheduled_job（含运行记录）。
 */
export async function hardDeleteChatSession(sessionId: string): Promise<HardDeleteSessionResult> {
  const db = await getDb();
  const exists = await db.select().from(chatSession).where(eq(chatSession.id, sessionId)).limit(1);
  if (!exists[0]) {
    return { sessionId, workflowRunIds: [], details: {} };
  }

  const details: Record<string, number> = {};

  // 1) 先把所有从属 workflow_run 硬删除（含 langgraph_checkpoint、agent_* 等）。
  const wfRows = await db
    .select({ id: workflowRun.id })
    .from(workflowRun)
    .where(eq(workflowRun.sessionId, sessionId));
  const wfIds = wfRows.map((r) => r.id);
  for (const wfId of wfIds) {
    const sub = await hardDeleteWorkflowRun(wfId);
    for (const [k, v] of Object.entries(sub.details)) {
      details[k] = (details[k] ?? 0) + v;
    }
  }

  const sqlite = getRawSqlite(db);
  sqlite.exec("BEGIN");
  try {
    sqlite.exec("PRAGMA defer_foreign_keys = ON");

    // 2) 删除该会话下的 scheduled_job（含 runs）。
    const jobs = await db
      .select({ id: scheduledJob.id })
      .from(scheduledJob)
      .where(eq(scheduledJob.sessionId, sessionId));
    let runsDeleted = 0;
    for (const job of jobs) {
      const r = sqlite.prepare("DELETE FROM scheduled_job_run WHERE job_id = ?").run(job.id);
      runsDeleted += r.changes;
    }
    details.scheduled_job_run = (details.scheduled_job_run ?? 0) + runsDeleted;
    const jobDel = sqlite.prepare("DELETE FROM scheduled_job WHERE session_id = ?").run(sessionId);
    details.scheduled_job = jobDel.changes;

    // 3) 删除该会话下的 indicator_strategy_script（FK 已 cascade，但显式以便统计）。
    const idsDel = sqlite
      .prepare("DELETE FROM indicator_strategy_script WHERE session_id = ?")
      .run(sessionId);
    details.indicator_strategy_script = idsDel.changes;

    // 4) 删除消息↔工作流链接以及聊天消息（chat_message 对 session FK，无 cascade）。
    const msgRows = await db
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(eq(chatMessage.sessionId, sessionId));
    if (msgRows.length > 0) {
      const placeholders = msgRows.map(() => "?").join(",");
      const linkDel = sqlite
        .prepare(
          `DELETE FROM chat_message_workflow_link WHERE chat_message_id IN (${placeholders})`
        )
        .run(...msgRows.map((r) => r.id));
      details.chat_message_workflow_link =
        (details.chat_message_workflow_link ?? 0) + linkDel.changes;
    }
    const msgDel = sqlite.prepare("DELETE FROM chat_message WHERE session_id = ?").run(sessionId);
    details.chat_message = msgDel.changes;

    // 5) 最后删 chat_session 本身。
    const sessDel = sqlite.prepare("DELETE FROM chat_session WHERE id = ?").run(sessionId);
    details.chat_session = sessDel.changes;

    sqlite.exec("COMMIT");
  } catch (err) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }

  return { sessionId, workflowRunIds: wfIds, details };
}
