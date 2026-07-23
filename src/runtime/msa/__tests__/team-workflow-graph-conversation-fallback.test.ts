import { describe, expect, test } from "bun:test";
import {
  type TeamGraphInteractionRow,
  mergeConversationProjectionFallbacks,
} from "../team-workflow-graph";

const existing: TeamGraphInteractionRow = {
  id: "interaction-1",
  workflowRunId: "wf-1",
  fromRole: "orchestrator",
  toRole: "user",
  kind: "llm_message",
  toolKind: null,
  toolName: null,
  contentText: "第一轮结论",
  payloadJson: { phase: "workflow_final_answer" },
  createdAt: "2026-07-23T14:01:00.000Z",
};

describe("mergeConversationProjectionFallbacks", () => {
  test("补入历史缺失的后续轮次，并按 assistant 更新时间排序", () => {
    const rows = mergeConversationProjectionFallbacks(
      [existing],
      [
        {
          id: "assistant-1",
          role: "assistant",
          sender: "orchestrator",
          content: "第一轮结论",
          status: "completed",
          createdAt: "2026-07-23T14:00:00.000Z",
          updatedAt: "2026-07-23T14:01:00.000Z",
        },
        {
          id: "assistant-2",
          role: "assistant",
          sender: "orchestrator",
          content: "第二轮最终结论",
          status: "completed",
          createdAt: "2026-07-23T14:02:00.000Z",
          updatedAt: "2026-07-23T14:05:00.000Z",
        },
      ],
      "wf-1"
    );

    expect(rows.map((row) => row.contentText)).toEqual(["第一轮结论", "第二轮最终结论"]);
    expect(rows[1]?.createdAt).toBe("2026-07-23T14:05:00.000Z");
    expect(rows[1]?.payloadJson).toEqual({
      phase: "workflow_final_answer",
      conversationTurnId: "assistant-2",
      projectionSource: "chat_message_fallback",
    });
  });

  test("忽略仍在运行、空内容或非 Orchestrator 的消息", () => {
    const rows = mergeConversationProjectionFallbacks(
      [],
      [
        {
          id: "running",
          role: "assistant",
          sender: "orchestrator",
          content: "尚未完成",
          status: "running",
          createdAt: "2026-07-23T14:00:00.000Z",
          updatedAt: "2026-07-23T14:00:00.000Z",
        },
        {
          id: "agent",
          role: "assistant",
          sender: "agent",
          content: "子 Agent 输出",
          status: "completed",
          createdAt: "2026-07-23T14:00:00.000Z",
          updatedAt: "2026-07-23T14:00:00.000Z",
        },
      ],
      "wf-1"
    );

    expect(rows).toEqual([]);
  });
});
