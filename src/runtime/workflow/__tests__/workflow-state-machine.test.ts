/**
 * P1-A：状态机迁移矩阵测试。
 *
 * 目标：把"实际代码里历史上发生过的合法迁移"全部固化下来，确保后续收紧规则时
 * 不会误伤现网行为。
 */
import { describe, expect, it } from "bun:test";
import { _isAllowedTransitionForTest } from "../workflow-state-machine";

describe("workflow-state-machine 合法迁移矩阵", () => {
  it("pending → running 允许（首次派发）", () => {
    expect(_isAllowedTransitionForTest("pending", "running")).toBe(true);
  });

  it("running → awaiting_approval 允许（HITL pause）", () => {
    expect(_isAllowedTransitionForTest("running", "awaiting_approval")).toBe(true);
  });

  it("awaiting_approval → running 允许（HITL approve resume）", () => {
    expect(_isAllowedTransitionForTest("awaiting_approval", "running")).toBe(true);
  });

  it("awaiting_approval → failed 允许（HITL reject）", () => {
    expect(_isAllowedTransitionForTest("awaiting_approval", "failed")).toBe(true);
  });

  it("running → completed 允许", () => {
    expect(_isAllowedTransitionForTest("running", "completed")).toBe(true);
  });

  it("running → failed 允许", () => {
    expect(_isAllowedTransitionForTest("running", "failed")).toBe(true);
  });

  it("running → cancelled 允许（用户取消）", () => {
    expect(_isAllowedTransitionForTest("running", "cancelled")).toBe(true);
  });

  it("pending → pending 允许（reuse 同 session 工作流，幂等）", () => {
    expect(_isAllowedTransitionForTest("pending", "pending")).toBe(true);
  });

  it("completed → pending 允许（reuse 已完成 chat workflow 时改回 pending）", () => {
    expect(_isAllowedTransitionForTest("completed", "pending")).toBe(true);
  });

  it("failed → pending 允许（compensation-queue 重试入队）", () => {
    expect(_isAllowedTransitionForTest("failed", "pending")).toBe(true);
  });

  it("cancelled → pending 允许（用户重新发起同 session 任务时复用）", () => {
    expect(_isAllowedTransitionForTest("cancelled", "pending")).toBe(true);
  });

  it("running → running 允许（restoreRunningWorkflows 把 stale running 标 running 幂等）", () => {
    expect(_isAllowedTransitionForTest("running", "running")).toBe(true);
  });

  it("cancelled → cancelled 允许（重复 cancel 幂等）", () => {
    expect(_isAllowedTransitionForTest("cancelled", "cancelled")).toBe(true);
  });

  it("trader-workflow：completed → cancelled 允许（用户/系统取消 dup 工作流）", () => {
    expect(_isAllowedTransitionForTest("completed", "cancelled")).toBe(true);
  });

  it("completed → running 不允许（终态后不应回到 running）", () => {
    expect(_isAllowedTransitionForTest("completed", "running")).toBe(false);
  });

  it("completed → awaiting_approval 不允许", () => {
    expect(_isAllowedTransitionForTest("completed", "awaiting_approval")).toBe(false);
  });

  it("cancelled → running 不允许（cancelled 后不应再 resume）", () => {
    expect(_isAllowedTransitionForTest("cancelled", "running")).toBe(false);
  });

  it("pending → completed 不允许（必须先 running）", () => {
    expect(_isAllowedTransitionForTest("pending", "completed")).toBe(false);
  });

  it("pending → failed 允许（restoreRunningWorkflows 处理 stale pending）", () => {
    expect(_isAllowedTransitionForTest("pending", "failed")).toBe(true);
  });
});
