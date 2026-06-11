import { and, eq, ne } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentInstance } from "../../db/sqlite/schema";
import { deleteCheckpointSnapshotsForWorkflow } from "../langgraph/agent-checkpoint-snapshot";

/**
 * 同会话新一轮用户追问：清自研 checkpoint snapshot，避免旧 observation 污染新 goal。
 * 仅用于 workflow_start（非 workflow_resume）。
 *
 * ⚠️ 这步不能漏：snapshot 现在是 resume 的唯一权威，若不清，新追问 resume 时会
 * 误把上一轮的 observations/finalResponse 还原回来，串台。
 */
export async function clearWorkflowCheckpointForNewTurn(workflowId: string): Promise<void> {
  await deleteCheckpointSnapshotsForWorkflow(workflowId);
  const db = await getDb();
  await db
    .update(agentInstance)
    .set({ status: "stopped", endedAt: new Date().toISOString() })
    .where(and(eq(agentInstance.workflowRunId, workflowId), ne(agentInstance.status, "stopped")));
}
