/**
 * P1-A 闭环单测：
 *
 *   research slot 写出 ```python on_bar(ctx, bar)``` → persistStrategyScript
 *   → runNativeBacktestForTicker 从 indicator_strategy_script 拿 signal_code
 *   → **真实调 runPythonStrategyBacktest**，而不是跑硬编码 SMA。
 *
 * 之前（P0 之前）：strategyCode 永远是 ""，runPythonStrategyBacktest 从不被调。
 *
 * 测试矩阵：
 *   1. signal_code 非空 + python runner 成功 → 摘要含"LLM Python 策略真实执行"
 *   2. signal_code 太短（<20）→ 返回 null（上层会 fallback 到 SMA；不在此测）
 *   3. bars 太薄（<30）→ 返回 null（同上）
 *   4. python runner 抛错 → 直接抛给上层（上层 catch 后转 fallback）
 *
 * 隔离策略：用 tmp QUBIT_DATA_DIR + 真 sqlite + 真 migrations；只 mock
 * python runner / klines-query 这两个不依赖 DB 的纯外部调用，避免污染
 * 同 process 其它测试（曾因 mock getDb 把 closeDb / dialect 等也覆盖掉，
 * 导致 analyst-research-jobs.test.ts 跑 migrate 直接 undefined.dialect）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const tmpDir = join(tmpdir(), `qubit-llm-python-backtest-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, beforeEach, describe, expect, mock, test } = await import(
  "bun:test"
);

/**
 * mock klines-query：只覆盖 queryBarsRange；其它 export（timeframeToPeriod /
 * timeframeWindowMs / computeDateRangeForLimit / queryKlines）保持透传，
 * 否则 import 期就 "Export named ... not found"。
 */
let stubBarsCount = 100;
const klinesActual = await import("../../market/klines-query");
mock.module("../../market/klines-query", () => ({
  ...klinesActual,
  queryBarsRange: async () => {
    return Array.from({ length: stubBarsCount }, (_, i) => ({
      symbol: "TEST",
      exchange: "US",
      open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1000,
      timestamp: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    }));
  },
}));

/** mock python runner：可控成功/失败 */
let pythonShouldThrow: Error | null = null;
let pythonCallCount = 0;
const pythonCallInputs: Array<{ strategyCode: string; barsLen: number }> = [];
let pythonStderr = "";
mock.module("../../market/python-strategy-backtest-runner", () => ({
  runPythonStrategyBacktest: async (input: { strategyCode: string; bars: unknown[] }) => {
    pythonCallCount += 1;
    pythonCallInputs.push({ strategyCode: input.strategyCode, barsLen: input.bars.length });
    if (pythonShouldThrow) throw pythonShouldThrow;
    return {
      equityCurve: [{ time: "2026-01-01", equity: 100_000 }],
      trades: [{ time: "2026-01-02", side: "buy" as const, qty: 10, price: 101, fee: 1.01 }],
      metrics: {
        totalReturnPct: 12.34,
        maxDrawdownPct: 4.56,
        sharpeApprox: 1.78,
        tradeCount: 1,
        bars: input.bars.length,
        lastPosition: 0,
      },
      stderrText: pythonStderr,
    };
  },
}));

const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../../db/sqlite/client");
const { runLlmPythonStrategyForTicker } = await import("../analyst-team-pipeline");
const { chatSession, workflowRun, indicatorStrategyScript, workspace, project } = await import(
  "../../../db/sqlite/schema"
);

const WORKSPACE_ID = "ws-p1a";
const PROJECT_ID = "prj-p1a";
const SESSION_ID = "sess-p1a";
const WORKFLOW_ID = "wf-p1a";
const SCRIPT_ID = `sid-${randomUUID()}`;

/** 把 stubSignalCode 直接 UPDATE 到 sqlite 里 */
async function setStubSignalCode(code: string): Promise<void> {
  const db = await getDb();
  const { eq } = await import("drizzle-orm");
  await db
    .update(indicatorStrategyScript)
    .set({ signalCode: code })
    .where(eq(indicatorStrategyScript.id, SCRIPT_ID));
}

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  await db.insert(workspace).values({ id: WORKSPACE_ID, name: "P1A WS", owner: "test" });
  await db.insert(project).values({
    id: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    name: "P1A Project",
    marketScope: "US",
  });
  await db.insert(chatSession).values({
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    title: "P1-A test",
  });
  await db.insert(workflowRun).values({
    id: WORKFLOW_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    goal: "P1-A test",
    mode: "research",
  });
  await db.insert(indicatorStrategyScript).values({
    id: SCRIPT_ID,
    sessionId: SESSION_ID,
    workflowRunId: WORKFLOW_ID,
    name: "P1-A test script",
    ideCode: "",
    signalCode: "",
    aiPromptSnapshot: "",
    chartSnapshotJson: "{}",
    purpose: "research",
  });
});

afterAll(() => {
  /**
   * 先关 db 连接再删文件——否则同进程后续测试拿到陈旧 singleton 会得到
   * `SQLiteError: disk I/O error`（文件被 rm 但 fd 还活着）。
   */
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  pythonShouldThrow = null;
  pythonCallCount = 0;
  pythonCallInputs.length = 0;
  pythonStderr = "";
});

const baseInput = {
  workflowRunId: WORKFLOW_ID,
  strategyScriptId: SCRIPT_ID,
  ticker: "AAPL",
  exchange: "US",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  initialCapital: 100_000,
  commission: 0.001,
  marketLine: "市场推断：US/US（confidence=inferred）",
};

describe("runLlmPythonStrategyForTicker — P1-A 闭环", () => {
  test("signal_code 非空 + bars 足够 → 真实调 python runner，摘要含真跑标识", async () => {
    await setStubSignalCode("def on_bar(ctx, bar):\n    pass\n# 30+ chars to pass length filter");
    stubBarsCount = 60;
    const out = await runLlmPythonStrategyForTicker(baseInput);
    expect(out).not.toBeNull();
    expect(out).toContain("LLM Python 策略真实执行");
    expect(out).toContain(`策略脚本 id：${SCRIPT_ID}`);
    expect(out).toContain("总收益：12.34%");
    expect(out).toContain("Sharpe（近似）：1.78");
    expect(out).toContain("交易次数：1");
    expect(out).toContain(baseInput.marketLine);
    expect(pythonCallCount).toBe(1);
    expect(pythonCallInputs[0]?.strategyCode).toContain("on_bar(ctx, bar)");
    expect(pythonCallInputs[0]?.barsLen).toBe(60);
  });

  test("signal_code 太短（<20）→ 返回 null（不调 python runner，留给上层 SMA fallback）", async () => {
    await setStubSignalCode("x = 1");
    stubBarsCount = 60;
    const out = await runLlmPythonStrategyForTicker(baseInput);
    expect(out).toBeNull();
    expect(pythonCallCount).toBe(0);
  });

  test("DB 查不到脚本 → 返回 null", async () => {
    /** 用一个不存在的 id 触发空查询 */
    const out = await runLlmPythonStrategyForTicker({
      ...baseInput,
      strategyScriptId: `nonexistent-${randomUUID()}`,
    });
    expect(out).toBeNull();
    expect(pythonCallCount).toBe(0);
  });

  test("bars 太薄（<30）→ 返回 null（数据不足不为难 python runner）", async () => {
    await setStubSignalCode("def on_bar(ctx, bar):\n    pass\n# enough length");
    stubBarsCount = 10;
    const out = await runLlmPythonStrategyForTicker(baseInput);
    expect(out).toBeNull();
    expect(pythonCallCount).toBe(0);
  });

  test("python runner 抛错 → 抛给上层（上层 catch → SMA fallback）", async () => {
    await setStubSignalCode("def on_bar(ctx, bar):\n    raise ValueError('boom')\n# length");
    stubBarsCount = 60;
    pythonShouldThrow = new Error("python exited 1: ValueError: boom");
    await expect(runLlmPythonStrategyForTicker(baseInput)).rejects.toThrow(/python exited 1/);
  });

  test("python stderr 透传到摘要（截断 400 字符）", async () => {
    await setStubSignalCode("def on_bar(ctx, bar):\n    pass\n# enough length");
    stubBarsCount = 60;
    pythonStderr = "DeprecationWarning: foo";
    const out = await runLlmPythonStrategyForTicker(baseInput);
    expect(out).toContain("Python stderr/print");
    expect(out).toContain("DeprecationWarning");
  });
});
