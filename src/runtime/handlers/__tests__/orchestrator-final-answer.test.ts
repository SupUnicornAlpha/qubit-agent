import { describe, expect, test } from "bun:test";
import { extractWorkflowFinalAnswer } from "../orchestrator-handler";

describe("extractWorkflowFinalAnswer", () => {
  test("按 answerText > summary > reasonText > observation.reasonText 优先级抽取", () => {
    expect(
      extractWorkflowFinalAnswer({
        answerText: " final answer ",
        summary: "summary",
        reasonText: "reason",
        observation: { reasonText: "observation" },
      })
    ).toBe("final answer");
    expect(extractWorkflowFinalAnswer({ summary: "summary" })).toBe("summary");
    expect(extractWorkflowFinalAnswer({ observation: { reasonText: "observation" } })).toBe(
      "observation"
    );
    expect(
      extractWorkflowFinalAnswer({ status: "terminated", answerText: "数据不可用，任务失败" })
    ).toBe("数据不可用，任务失败");
  });

  test("拒绝空值和工具占位文本", () => {
    expect(extractWorkflowFinalAnswer(null)).toBe("");
    expect(extractWorkflowFinalAnswer({ summary: "no tool requested" })).toBe("");
  });
});
