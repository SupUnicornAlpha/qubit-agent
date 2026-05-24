import { and, eq, ne } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentInstance } from "../../db/sqlite/schema";
import { getCheckpointSaver } from "../langgraph/sqlite-checkpoint-saver";

/**
 * 同会话新一轮用户追问：清 LangGraph checkpoint，避免旧 observation 污染新 goal。
 * 仅用于 workflow_start（非 workflow_resume）。
 */
export async function clearWorkflowCheckpointForNewTurn(workflowId: string): Promise<void> {
  await getCheckpointSaver().deleteThread(workflowId);
  const db = await getDb();
  await db
    .update(agentInstance)
    .set({ status: "stopped", endedAt: new Date().toISOString() })
    .where(and(eq(agentInstance.workflowRunId, workflowId), ne(agentInstance.status, "stopped")));
}
