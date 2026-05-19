import { eq, inArray } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentDefinitionDraft,
  agentDefinitionRelease,
  agentGroupMember,
  agentProfile,
  agentRuntimeMetric,
  analystAccuracyLog,
} from "../../db/sqlite/schema";
import { RETIRED_BUILTIN_DEFINITION_IDS } from "../seed-agent-definitions-data";
import { deleteAgentInstancesForDefinition } from "./delete-agent-definition";

/**
 * 物理删除已退役的内置 Agent 行（及编组成员、profile 等），避免 UI 仍显示「已禁用」条目。
 */
export async function purgeRetiredBuiltinDefinitions(db: DbClient): Promise<number> {
  const ids = [...RETIRED_BUILTIN_DEFINITION_IDS];
  if (ids.length === 0) return 0;

  await db.delete(agentGroupMember).where(inArray(agentGroupMember.definitionId, ids));

  let removed = 0;
  for (const definitionId of ids) {
    const defRows = await db
      .select({ id: agentDefinition.id })
      .from(agentDefinition)
      .where(eq(agentDefinition.id, definitionId))
      .limit(1);
    if (!defRows[0]) continue;

    await deleteAgentInstancesForDefinition(db, definitionId);
    await db
      .delete(agentDefinitionRelease)
      .where(eq(agentDefinitionRelease.definitionId, definitionId));
    await db.delete(agentDefinitionDraft).where(eq(agentDefinitionDraft.definitionId, definitionId));
    await db.delete(analystAccuracyLog).where(eq(analystAccuracyLog.definitionId, definitionId));
    await db.delete(agentRuntimeMetric).where(eq(agentRuntimeMetric.definitionId, definitionId));
    await db.delete(agentProfile).where(eq(agentProfile.definitionId, definitionId));
    await db.delete(agentDefinition).where(eq(agentDefinition.id, definitionId));
    removed++;
  }
  return removed;
}
