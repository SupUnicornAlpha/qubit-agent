import { randomUUID } from "node:crypto";
import { getDb } from "../../db/sqlite/client";
import { researchTeamInteraction } from "../../db/sqlite/schema";

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
