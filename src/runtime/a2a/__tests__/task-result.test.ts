import { describe, expect, test } from "bun:test";
import { TaskResultPayloadSchema } from "../../../types/a2a";
import { buildTaskResult } from "../task-result";

describe("A2A TaskResult v2", () => {
  test("builds a complete successful terminal receipt", () => {
    const result = buildTaskResult("task-1", "analyst_technical", {
      result: { answer: "ok" },
      durationMs: 12.8,
    });
    expect(TaskResultPayloadSchema.parse(result)).toMatchObject({
      taskId: "task-1",
      status: "completed",
      success: true,
      durationMs: 12,
    });
  });

  test("requires a structured code and message for V2 non-success receipts", () => {
    expect(() =>
      TaskResultPayloadSchema.parse({
        taskId: "task-1",
        success: false,
        status: "timeout",
        result: null,
        durationMs: 1,
      })
    ).toThrow("failed TASK_RESULT requires errorCode and errorMessage");
    expect(
      TaskResultPayloadSchema.parse(
        buildTaskResult("task-1", "market_data", {
          status: "timeout",
          errorCode: "a2a_gather_timeout",
          errorMessage: "child did not reply before deadline",
          durationMs: 50,
        })
      )
    ).toMatchObject({ status: "timeout", success: false, errorCode: "a2a_gather_timeout" });
  });

  test("continues to parse a persisted V1 receipt", () => {
    expect(
      TaskResultPayloadSchema.parse({
        taskId: "legacy-task",
        success: false,
        result: null,
        durationMs: 0,
      })
    ).toMatchObject({ taskId: "legacy-task", success: false });
  });
});
