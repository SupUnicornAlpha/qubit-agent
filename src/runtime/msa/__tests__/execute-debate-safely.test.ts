/**
 * F-P0-02 回归（2026-06）：executeDebateSafely helper 锁定行为契约——
 * 当 runDebateSession 抛错时，**不能**把异常向上冒泡到 runAnalystTeam，
 * 必须 (a) console.warn 留痕 (b) 写一条 phase=debate_failed interaction
 * (c) 返回 undefined 让下游 risk 走 fusedConfidence-only fallback。
 *
 * Bug 复现：2026-06 评估批次实测，shouldDebate=true 的 workflow 在 LLM
 * 失败时整个 workflow 标 failed，但前端能看到 phase=debate_decision 的
 * 互动事件——其实代码进了 if 分支，只是 runDebateSession throw 后没人
 * 接住。
 *
 * 注：本测试导入 analyst-team.ts 会触发 db client 初始化，必须先把
 * QUBIT_DATA_DIR 指到 tmpdir。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-debate-safe-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { describe, expect, test } = await import("bun:test");
const { executeDebateSafely } = await import("../analyst-team");

const baseInput = {
  workflowRunId: "wf-debate-test",
  ticker: "NVDA",
  fusedSignal: "buy" as const,
  fusedConfidence: 0.5,
  analystSummary: "fund: buy 70%, tech: hold 55%",
  maxRounds: 2,
};

describe("executeDebateSafely · 成功路径", () => {
  test("runDebateSession 成功返回 → 透传字段到 debate 结构", async () => {
    const fakeRun = async () => ({
      debateSessionId: "ses-123",
      consensusScore: 0.82,
      finalStance: "bull" as const,
      verdict: "agree_bull" as const,
      reasoning: "bull 论据更强",
    });
    const logCalls: Array<Record<string, unknown>> = [];
    const fakeLog = async (input: Record<string, unknown>) => {
      logCalls.push(input);
    };

    const out = await executeDebateSafely({
      ...baseInput,
      run: fakeRun as never,
      logFailure: fakeLog as never,
    });

    expect(out).toEqual({
      sessionId: "ses-123",
      consensusScore: 0.82,
      finalStance: "bull",
      verdict: "agree_bull",
      reasoning: "bull 论据更强",
    });
    expect(logCalls).toEqual([]);
  });
});

describe("executeDebateSafely · 失败兜底（F-P0-02 关键回归）", () => {
  test("runDebateSession throw Error → 返回 undefined（不向上冒泡）", async () => {
    const fakeRun = async () => {
      throw new Error("deepseek 429 too many requests");
    };
    const fakeLog = async () => {};

    const out = await executeDebateSafely({
      ...baseInput,
      run: fakeRun as never,
      logFailure: fakeLog as never,
    });

    expect(out).toBeUndefined();
  });

  test("失败时写 phase=debate_failed interaction 留痕", async () => {
    const fakeRun = async () => {
      throw new Error("deepseek 429 too many requests");
    };
    const logCalls: Array<Record<string, unknown>> = [];
    const fakeLog = async (input: Record<string, unknown>) => {
      logCalls.push(input);
    };

    await executeDebateSafely({
      ...baseInput,
      run: fakeRun as never,
      logFailure: fakeLog as never,
    });

    expect(logCalls.length).toBe(1);
    const call = logCalls[0]!;
    expect(call.workflowRunId).toBe("wf-debate-test");
    expect(call.fromRole).toBe("orchestrator");
    expect(call.toRole).toBe("__team__");
    expect(call.kind).toBe("llm_message");
    expect(String(call.contentText)).toContain("辩论会话执行失败");
    expect(String(call.contentText)).toContain("deepseek 429");

    const payload = call.payloadJson as Record<string, unknown>;
    expect(payload.phase).toBe("debate_failed");
    expect(payload.ticker).toBe("NVDA");
    expect(payload.fusedSignal).toBe("buy");
    expect(payload.fusedConfidence).toBe(0.5);
    expect(String(payload.errorMessage)).toContain("deepseek 429");
  });

  test("throw 非 Error 类型（如 string）→ 仍走兜底，msg 转字符串", async () => {
    const fakeRun = async () => {
      throw "raw string error";
    };
    const logCalls: Array<Record<string, unknown>> = [];
    const fakeLog = async (input: Record<string, unknown>) => {
      logCalls.push(input);
    };

    const out = await executeDebateSafely({
      ...baseInput,
      run: fakeRun as never,
      logFailure: fakeLog as never,
    });

    expect(out).toBeUndefined();
    expect(logCalls.length).toBe(1);
    expect(String(logCalls[0]!.contentText)).toContain("raw string error");
  });

  test("LLM timeout 模拟（runDebateSession 抛 'timeout'）→ 兜底", async () => {
    const fakeRun = async () => {
      throw new Error("LLM call timeout after 30s");
    };
    const fakeLog = async () => {};

    const out = await executeDebateSafely({
      ...baseInput,
      run: fakeRun as never,
      logFailure: fakeLog as never,
    });

    expect(out).toBeUndefined();
  });

  test("超长 error message → 截断到 800 字符的 contentText / 1200 字符的 payload.errorMessage", async () => {
    const longMsg = "x".repeat(5000);
    const fakeRun = async () => {
      throw new Error(longMsg);
    };
    const logCalls: Array<Record<string, unknown>> = [];
    const fakeLog = async (input: Record<string, unknown>) => {
      logCalls.push(input);
    };

    await executeDebateSafely({
      ...baseInput,
      run: fakeRun as never,
      logFailure: fakeLog as never,
    });

    const call = logCalls[0]!;
    // contentText 含 "失败：" 前缀，纯 msg 部分被截到 800
    expect(String(call.contentText).length).toBeLessThan(1000);
    const payload = call.payloadJson as Record<string, unknown>;
    expect(String(payload.errorMessage).length).toBeLessThanOrEqual(1200);
  });
});
