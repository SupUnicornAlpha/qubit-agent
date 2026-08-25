import { describe, expect, test } from "bun:test";
import {
  type WorkflowExecutionSummary,
  reconcileCoreAnswerWithExecutionSummary,
} from "../reconcile-core-answer";

const completed: WorkflowExecutionSummary = {
  completedBacktestIds: ["41939ae1-88bf-479e-9909-90c780b9b96d"],
  factorEvaluationCount: 1,
  strategyCompositionCount: 1,
};

describe("reconcileCoreAnswerWithExecutionSummary", () => {
  test("puts a durable-artifact correction ahead of a stale no-closure report", () => {
    const result = reconcileCoreAnswerWithExecutionSummary(
      "## 步骤 3 — 回测验证 ❌ 无法闭环\n\n验证未发生，全部 [数据缺口]。",
      completed
    );

    expect(result).toStartWith("> **系统执行记录补正**：本轮已成功完成 1 次回测（`41939ae1`）");
    expect(result).toContain("因子评估 1 条；策略组合 1 个");
    expect(result).toContain("下方“无法闭环 / 验证未发生 / 数据缺口”等描述");
  });

  test("does not alter reports with no completed backtest artifact", () => {
    const text = "## 步骤 3 — 回测验证 ❌ 无法闭环";
    expect(
      reconcileCoreAnswerWithExecutionSummary(text, {
        ...completed,
        completedBacktestIds: [],
      })
    ).toBe(text);
  });

  test("does not add noise to an already current report", () => {
    const text = "回测已完成，请查看绩效产物。";
    expect(reconcileCoreAnswerWithExecutionSummary(text, completed)).toBe(text);
  });
});
