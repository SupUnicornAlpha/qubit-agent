import { eq, inArray } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentDefinitionDraft,
  agentDefinitionRelease,
  agentInstance,
  agentProfile,
  agentRuntimeMetric,
  agentStep,
  analystAccuracyLog,
  analystSignal,
  mcpCallLog,
  sandboxViolationLog,
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
