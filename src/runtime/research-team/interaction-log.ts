import { randomUUID } from "node:crypto";
import { getDb, getSqliteForTesting } from "../../db/sqlite/client";
import { researchTeamInteraction } from "../../db/sqlite/schema";
import { completeWorkflowConversationAssistant } from "../conversation/conversation-projection";

export type ResearchTeamInteractionKind = "llm_message" | "tool_call" | "signal_submit";

/**
 * 持久化研究团队交互：对话边、信号提交、tool/mcp 调用（供拓扑与回放）。
 */
export async function logResearchTeamInteraction(input: {
  workflowRunId: string;
  fromRole: string;
  toRole: string;
  kind: ResearchTeamInteractionKind;
  toolKind?: string | null;
  toolName?: string | null;
  contentText: string;
  payloadJson?: Record<string, unknown>;
}): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(researchTeamInteraction).values({
      id: randomUUID(),
      workflowRunId: input.workflowRunId,
      fromRole: input.fromRole,
      toRole: input.toRole,
      kind: input.kind,
      toolKind: input.toolKind ?? null,
      toolName: input.toolName ?? null,
      contentText: input.contentText.slice(0, 8000),
      payloadJson: input.payloadJson ?? {},
    });
  } catch (err) {
    console.warn("[logResearchTeamInteraction]", err);
  }
}

/**
 * 把工作流终态答复投影到客户端读取的研究团队对话流。
 *
 * A2A TASK_RESULT 是内部协议记录；客户端右栏读取的是
 * research_team_interaction。两者不能互相替代。续跑/重试可能再次经过同一终态，
 * 因此对聊天入口按 conversationTurnId 做单轮幂等，避免重试产生重复答复，同时允许
 * 同一 workflow 的后续对话轮次各自写入右栏。没有轮次 ID 的旧入口仍保持 workflow
 * 级幂等。
 */
export async function projectWorkflowFinalAnswer(input: {
  workflowRunId: string;
  contentText: string;
  sourceTaskType?: string;
  conversationTurnId?: string;
  payloadJson?: Record<string, unknown>;
}): Promise<boolean> {
  const contentText = input.contentText.trim();
  if (!contentText) return false;
  const conversationTurnId = input.conversationTurnId?.trim() || null;

  try {
    await getDb();
    const sqlite = getSqliteForTesting();
    const existing = conversationTurnId
      ? sqlite
          .prepare(
            `SELECT 1
             FROM research_team_interaction
             WHERE workflow_run_id = ?
               AND from_role = 'orchestrator'
               AND to_role = 'user'
               AND kind = 'llm_message'
               AND json_extract(payload_json, '$.phase') = 'workflow_final_answer'
               AND json_extract(payload_json, '$.conversationTurnId') = ?
             LIMIT 1`
          )
          .get(input.workflowRunId, conversationTurnId)
      : sqlite
          .prepare(
            `SELECT 1
             FROM research_team_interaction
             WHERE workflow_run_id = ?
               AND from_role = 'orchestrator'
               AND to_role = 'user'
               AND kind = 'llm_message'
               AND json_extract(payload_json, '$.phase') = 'workflow_final_answer'
             LIMIT 1`
          )
          .get(input.workflowRunId);
    if (existing) {
      await completeWorkflowConversationAssistant({
        workflowRunId: input.workflowRunId,
        content: contentText,
      });
      return false;
    }

    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: "orchestrator",
      toRole: "user",
      kind: "llm_message",
      contentText,
      payloadJson: {
        phase: "workflow_final_answer",
        ...(input.sourceTaskType ? { sourceTaskType: input.sourceTaskType } : {}),
        ...(input.payloadJson ?? {}),
        ...(conversationTurnId ? { conversationTurnId } : {}),
      },
    });
    await completeWorkflowConversationAssistant({
      workflowRunId: input.workflowRunId,
      content: contentText,
    });
    return true;
  } catch (err) {
    console.warn("[projectWorkflowFinalAnswer]", err);
    return false;
  }
}
