import { describe, expect, test } from "bun:test";
import type { TaskAssignPayload } from "../../../types/a2a";
import { ownsWorkflowTerminalState } from "../a2a-react-task";

function payload(taskType: string): TaskAssignPayload {
  return {
    taskId: "task-1",
    taskType,
    assignedRole: "analyst_technical",
    params: {},
  };
}

describe("A2A workflow terminal ownership", () => {
  test("topology child cannot overwrite the orchestrator workflow status", () => {
    expect(ownsWorkflowTerminalState(payload("topology_dispatch"))).toBe(false);
  });

  test("standalone workflow tasks retain terminal ownership", () => {
    expect(ownsWorkflowTerminalState(payload("manual_research"))).toBe(true);
  });
});
