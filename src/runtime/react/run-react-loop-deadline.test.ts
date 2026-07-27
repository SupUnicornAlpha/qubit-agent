import { describe, expect, test } from "bun:test";
import type { TaskAssignPayload } from "../../types/a2a";
import { isTaskDeadlineExpired } from "./run-react-loop";

function payload(deadline?: string): TaskAssignPayload {
  return {
    taskId: "task-1",
    taskType: "topology_dispatch",
    assignedRole: "market_data",
    params: {},
    ...(deadline ? { deadline } : {}),
  };
}

describe("topology task deadline", () => {
  test("has no deadline by default", () => {
    expect(isTaskDeadlineExpired(payload(), 1_000)).toBe(false);
  });

  test("expires at the declared deadline", () => {
    const deadline = new Date(10_000).toISOString();
    expect(isTaskDeadlineExpired(payload(deadline), 9_999)).toBe(false);
    expect(isTaskDeadlineExpired(payload(deadline), 10_000)).toBe(true);
  });

  test("ignores malformed deadlines", () => {
    expect(isTaskDeadlineExpired(payload("not-a-date"), 10_000)).toBe(false);
  });
});
