import { describe, expect, test } from "bun:test";
import type { A2AMessageEnvelope } from "../../../types/a2a";
import { parseTaskAssignPayload } from "../role-handlers";

function taskAssign(payload: unknown): A2AMessageEnvelope {
  return {
    messageId: "message-1",
    workflowId: "workflow-1",
    traceId: "trace-1",
    senderAgent: "orchestrator-1",
    receiverAgent: "analyst-technical-1",
    messageType: "TASK_ASSIGN",
    payload,
    priority: 50,
    createdAt: "2026-08-31T00:00:00.000Z",
  };
}

describe("parseTaskAssignPayload", () => {
  test("passes the decoded TASK_ASSIGN payload to the handler", () => {
    const payload = {
      taskId: "task-1",
      taskType: "topology_dispatch",
      assignedRole: "analyst_technical",
      params: { goal: "分析 AAPL" },
    };

    expect(parseTaskAssignPayload(taskAssign(payload))).toEqual(payload);
  });

  test("rejects a malformed or non-task message before execution", () => {
    expect(() =>
      parseTaskAssignPayload(
        taskAssign({
          taskId: "task-1",
          assignedRole: "analyst_technical",
          params: {},
        })
      )
    ).toThrow();

    expect(() =>
      parseTaskAssignPayload({
        ...taskAssign({}),
        messageType: "TASK_RESULT",
      })
    ).toThrow(/expected TASK_ASSIGN/);
  });
});
