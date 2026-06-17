import { eq, inArray, or } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  a2aMessage,
  agentCheckpointSnapshot,
  agentDefinition,
  agentDefinitionDraft,
  agentDefinitionRelease,
  agentInstance,
  agentProfile,
  agentRuntimeMetric,
  agentStep,
  analystAccuracyLog,
  analystSignal,
  auditLog,
  backtestRun,
  executionReport,
  intentOrder,
  mcpCallLog,
  researchExperiment,
  riskDecision,
  riskVetoLog,
  sandboxViolationLog,
  simulationRun,
  toolCallLog,
} from "../../db/sqlite/schema";
import { BUILTIN_AGENT_DEFINITION_IDS, BUILTIN_AGENT_ROLES } from "../seed-agent-definitions-data";

export function isBuiltinAgentDefinitionId(id: string): boolean {
  return BUILTIN_AGENT_DEFINITION_IDS.has(id);
}

export async function deleteAgentInstancesForDefinition(
  db: DbClient,
  definitionId: string
): Promise<void> {
  const instances = await db
    .select({ id: agentInstance.id })
    .from(agentInstance)
    .where(eq(agentInstance.definitionId, definitionId));
  const instanceIds = instances.map((i) => i.id);
  if (instanceIds.length === 0) return;

  const steps = await db
    .select({ id: agentStep.id })
    .from(agentStep)
    .where(inArray(agentStep.agentInstanceId, instanceIds));
  const stepIds = steps.map((s) => s.id);

  if (stepIds.length > 0) {
    await db.delete(toolCallLog).where(inArray(toolCallLog.agentStepId, stepIds));
    await db.delete(mcpCallLog).where(inArray(mcpCallLog.agentStepId, stepIds));
  }
  await db.delete(agentStep).where(inArray(agentStep.agentInstanceId, instanceIds));
  await db
    .delete(sandboxViolationLog)
    .where(inArray(sandboxViolationLog.agentInstanceId, instanceIds));
  await db.delete(analystSignal).where(inArray(analystSignal.agentInstanceId, instanceIds));

  /**
   * 修复 2026-06-17 冷启动崩溃（SQLITE_CONSTRAINT_FOREIGNKEY）：agent_instance 还有一批
   * `ON DELETE NO ACTION` 子表，若不先清就 `delete(agentInstance)` 会 FK 失败。实测触发点是
   * 退役的 def-researcher-bull/bear（辩论实例）残留的 `a2a_message` 行——seedAgentDefinitions →
   * purgeRetiredBuiltinDefinitions 在每次启动（含 bun --watch 热重载）跑，一崩整个后端起不来。
   *
   * 这里把 instance 名下所有 NO ACTION 子表按 FK 安全顺序（子先于父）清掉。
   * 故意不动 `strategy`（owner_instance_id）—— 那是用户资产，退役/自定义 agent 几乎不会持有；
   * 万一真有，宁可让 FK 报错暴露问题，也不静默删策略。
   */
  await db.delete(executionReport).where(inArray(executionReport.executorInstanceId, instanceIds));
  await db.delete(intentOrder).where(inArray(intentOrder.createdByInstanceId, instanceIds));
  await db.delete(riskVetoLog).where(inArray(riskVetoLog.riskInstanceId, instanceIds));
  await db.delete(riskDecision).where(inArray(riskDecision.agentInstanceId, instanceIds));
  await db.delete(backtestRun).where(inArray(backtestRun.agentInstanceId, instanceIds));
  await db.delete(simulationRun).where(inArray(simulationRun.agentInstanceId, instanceIds));
  await db
    .delete(researchExperiment)
    .where(inArray(researchExperiment.agentInstanceId, instanceIds));
  await db.delete(auditLog).where(inArray(auditLog.agentInstanceId, instanceIds));
  await db
    .delete(agentCheckpointSnapshot)
    .where(inArray(agentCheckpointSnapshot.agentInstanceId, instanceIds));
  await db
    .delete(a2aMessage)
    .where(
      or(
        inArray(a2aMessage.senderInstanceId, instanceIds),
        inArray(a2aMessage.receiverInstanceId, instanceIds)
      )
    );

  await db.delete(agentInstance).where(eq(agentInstance.definitionId, definitionId));
}

/** 删除自定义 Agent 定义及其 profile / draft / release 等；内置 `def-*` 不可删。 */
export async function deleteAgentDefinitionById(
  db: DbClient,
  definitionId: string
): Promise<{ deleted: boolean; reason?: string }> {
  if (isBuiltinAgentDefinitionId(definitionId)) {
    return { deleted: false, reason: "built-in agent definitions cannot be deleted" };
  }

  const defRows = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!defRows[0]) return { deleted: false, reason: "not found" };

  const running = await db
    .select({ status: agentInstance.status })
    .from(agentInstance)
    .where(eq(agentInstance.definitionId, definitionId));
  if (running.some((s) => s.status === "running")) {
    return { deleted: false, reason: "agent has a running instance; stop the workflow first" };
  }

  await deleteAgentInstancesForDefinition(db, definitionId);
  await db
    .delete(agentDefinitionRelease)
    .where(eq(agentDefinitionRelease.definitionId, definitionId));
  await db.delete(agentDefinitionDraft).where(eq(agentDefinitionDraft.definitionId, definitionId));
  await db.delete(analystAccuracyLog).where(eq(analystAccuracyLog.definitionId, definitionId));
  await db.delete(agentRuntimeMetric).where(eq(agentRuntimeMetric.definitionId, definitionId));
  await db.delete(agentProfile).where(eq(agentProfile.definitionId, definitionId));
  await db.delete(agentDefinition).where(eq(agentDefinition.id, definitionId));
  return { deleted: true };
}

/**
 * 移除与内置 `def-*` 同 role 的重复自定义定义（如「自定义 · orchestrator」）。
 * 保留所有内置行；无内置的 role 不动。
 */
export async function cleanupRedundantAgentDefinitions(db: DbClient): Promise<number> {
  const rows = await db
    .select({ id: agentDefinition.id, role: agentDefinition.role })
    .from(agentDefinition);
  let removed = 0;
  for (const row of rows) {
    if (BUILTIN_AGENT_DEFINITION_IDS.has(row.id)) continue;
    if (!BUILTIN_AGENT_ROLES.has(row.role)) continue;
    const result = await deleteAgentDefinitionById(db, row.id);
    if (result.deleted) removed++;
  }
  return removed;
}
