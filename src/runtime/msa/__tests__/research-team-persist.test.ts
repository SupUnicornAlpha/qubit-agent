/**
 * P0-1: 统一短路 helper `runTeamResearchAndPersist` 行为快照。
 *
 * 旧实现 graph-factory.ts 与 role-handlers.ts 各抄一遍 → 字段对不齐时引发
 * "approve → 又弹一次 HITL" 死循环（2026-05-25 故障）。
 *
 * 本测试用 deps injection（不需要 mock.module、不需要真 DB）验证三条 outcome
 * 分支下：workflow_run.status / SSE final / pauseJob / failJob / onTerminal
 * 都按既定顺序被调用，确保两条 caller（GraphRunner / A2A handler）
 * 只要调 helper 就能保持完全一致的对外副作用。
 *
 * Import 链说明：research-team-execute → hitl-service → graph-factory，
 * 而 graph-factory.ts 顶层有 `void registerBuiltinConnectors()` 会触发 migrations。
 * 即使 helper 本身从不调真 DB，import 时也得把数据目录指到 tmp，否则
 * fire-and-forget 的 migration 会试图写到产线 DB 抛 SQLITE_READONLY。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-research-team-persist-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, afterEach, beforeEach, describe, expect, mock, test } = await import("bun:test");
const { HitlAwaitingApprovalError } = await import("../../workflow/hitl-service");
const { runTeamResearchAndPersist } = await import("../research-team-execute");
type StepStreamEvent = import("../../langgraph/state").StepStreamEvent;
type ParsedResearchTeamExecute = import("../research-team-execute").ParsedResearchTeamExecute;
type RunTeamResearchPersistDeps = import("../research-team-execute").RunTeamResearchPersistDeps;
type AnalystTeamResult = import("../analyst-team").AnalystTeamResult;

function makeParsed(overrides: Partial<ParsedResearchTeamExecute> = {}): ParsedResearchTeamExecute {
  /** 用条件式赋值避免显式 `undefined`，否则 `exactOptionalPropertyTypes:true` 下会报错 */
  return {
    jobId: "job-1",
    ticker: "AAPL",
    scope: null,
    agentGroupId: null,
    ...overrides,
  };
}

function makeMockDeps(): {
  deps: RunTeamResearchPersistDeps;
  setStatusCalls: Array<[string, string]>;
  publishedEvents: StepStreamEvent[];
  terminalCalls: Array<[string, "completed" | "failed"]>;
  pauseJobCalls: Array<{ jobId: string; requestId: string; title: string }>;
  failJobCalls: Array<{ jobId: string; err: unknown }>;
  setExecuteResult: (result: () => Promise<AnalystTeamResult>) => void;
} {
  const setStatusCalls: Array<[string, string]> = [];
  const publishedEvents: StepStreamEvent[] = [];
  const terminalCalls: Array<[string, "completed" | "failed"]> = [];
  const pauseJobCalls: Array<{ jobId: string; requestId: string; title: string }> = [];
  const failJobCalls: Array<{ jobId: string; err: unknown }> = [];

  let executeImpl: () => Promise<AnalystTeamResult> = async () => {
    throw new Error("executeImpl not set");
  };

  /**
   * 直接列出所有 deps 字段（exactOptionalPropertyTypes:true 下不能给 `T?` 字段
   * 显式赋一个可能为 undefined 的值，所以下面 mock 函数都返回精确签名）。
   */
  const deps: RunTeamResearchPersistDeps = {
    execute: mock(() => executeImpl()),
    setWorkflowStatus: async (workflowRunId, status) => {
      setStatusCalls.push([workflowRunId, status]);
    },
    publishEvent: (evt) => publishedEvents.push(evt),
    onTerminal: (workflowId, status) => {
      terminalCalls.push([workflowId, status]);
    },
    pauseJob: (jobId, input) => {
      pauseJobCalls.push({ jobId, requestId: input.requestId, title: input.title });
    },
    failJob: (jobId, err) => {
      failJobCalls.push({ jobId, err });
    },
    verifyArtifacts: async () => ({ ok: true }),
  };

  return {
    deps,
    setStatusCalls,
    publishedEvents,
    terminalCalls,
    pauseJobCalls,
    failJobCalls,
    setExecuteResult: (fn) => {
      executeImpl = fn;
    },
  };
}

describe("runTeamResearchAndPersist", () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  beforeEach(() => {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = () => {};
    console.error = () => {};
  });
  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("completed: 写 workflow_run=completed + onTerminal + SSE final(completed)", async () => {
    const m = makeMockDeps();
    const teamResult: AnalystTeamResult = {
      fusionId: "fusion-x",
      fusedSignal: "long",
      fusedConfidence: 0.78,
    } as unknown as AnalystTeamResult;
    m.setExecuteResult(async () => teamResult);

    const outcome = await runTeamResearchAndPersist(
      {
        workflowRunId: "wf-1",
        runId: "run-1",
        traceId: "tr-1",
        parsed: makeParsed(),
        hitlApproval: null,
      },
      m.deps,
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.teamResult.fusionId).toBe("fusion-x");
    }
    /**
     * 2026-05-26: helper 现在在进入 execute 前会先把 status 写成 running，
     * 修掉 "research_team graph 短路时 sidebar 一直显示 pending" 的回归。
     * 详见 research-team-execute.ts 里 setStatus(workflowRunId, "running") 的注释。
     */
    expect(m.setStatusCalls).toEqual([
      ["wf-1", "running"],
      ["wf-1", "completed"],
    ]);
    expect(m.terminalCalls).toEqual([["wf-1", "completed"]]);
    expect(m.pauseJobCalls.length).toBe(0);
    expect(m.failJobCalls.length).toBe(0);
    expect(m.publishedEvents.length).toBe(1);
    const evt = m.publishedEvents[0]!;
    expect(evt.type).toBe("final");
    expect(evt.payload["status"]).toBe("completed");
    expect(evt.payload["fusionId"]).toBe("fusion-x");
  });

  test("awaiting_approval: pauseJob 缓存 resumePayload + workflow_run=awaiting_approval + SSE final(awaiting_approval)", async () => {
    const m = makeMockDeps();
    m.setExecuteResult(async () => {
      throw new HitlAwaitingApprovalError("hitl-req-9", "wf-2", "团队规划待审批：AAPL");
    });

    const parsed = makeParsed({ jobId: "job-9", ticker: "AAPL" });
    const outcome = await runTeamResearchAndPersist(
      {
        workflowRunId: "wf-2",
        runId: "run-2",
        traceId: "tr-2",
        parsed,
        hitlApproval: null,
      },
      m.deps,
    );

    expect(outcome.kind).toBe("awaiting_approval");
    if (outcome.kind === "awaiting_approval") {
      expect(outcome.requestId).toBe("hitl-req-9");
      expect(outcome.title).toContain("AAPL");
    }
    expect(m.setStatusCalls).toEqual([
      ["wf-2", "running"],
      ["wf-2", "awaiting_approval"],
    ]);
    /** awaiting_approval 不算 terminal，绝不能调 onWorkflowTerminal */
    expect(m.terminalCalls.length).toBe(0);
    expect(m.pauseJobCalls.length).toBe(1);
    expect(m.pauseJobCalls[0]).toEqual({
      jobId: "job-9",
      requestId: "hitl-req-9",
      title: "团队规划待审批：AAPL",
    });
    expect(m.failJobCalls.length).toBe(0);
    expect(m.publishedEvents.length).toBe(1);
    const evt = m.publishedEvents[0]!;
    expect(evt.type).toBe("final");
    expect(evt.payload["status"]).toBe("awaiting_approval");
    expect(evt.payload["hitlRequestId"]).toBe("hitl-req-9");
  });

  test("failed: failJob + workflow_run=failed + onTerminal(failed) + 不发 SSE final", async () => {
    const m = makeMockDeps();
    m.setExecuteResult(async () => {
      throw new Error("boom: provider 429");
    });

    const outcome = await runTeamResearchAndPersist(
      {
        workflowRunId: "wf-3",
        runId: "run-3",
        traceId: "tr-3",
        parsed: makeParsed({ jobId: "job-3" }),
        hitlApproval: null,
      },
      m.deps,
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error.message).toContain("boom: provider 429");
    }
    expect(m.setStatusCalls).toEqual([
      ["wf-3", "running"],
      ["wf-3", "failed"],
    ]);
    expect(m.terminalCalls).toEqual([["wf-3", "failed"]]);
    expect(m.pauseJobCalls.length).toBe(0);
    expect(m.failJobCalls.length).toBe(1);
    expect(m.failJobCalls[0]?.jobId).toBe("job-3");
    /**
     * helper 在 failed 分支不发 SSE final（caller 自己决定是否要发 error 事件，
     * 例如 GraphRunner 的 publishError）。这条约束很重要——重复发 final 会让前端
     * 渲染两条"任务结束"卡片。
     */
    expect(m.publishedEvents.length).toBe(0);
  });

  test("artifact gate: 产物缺失时不得把团队结果标 completed", async () => {
    const m = makeMockDeps();
    m.setExecuteResult(async () =>
      ({ fusionId: "fusion-gap", fusedSignal: "hold", fusedConfidence: 0.1 }) as AnalystTeamResult
    );
    m.deps.verifyArtifacts = async () => ({
      ok: false,
      detail: "factor_evaluation >= 1（当前 0）",
    });

    const outcome = await runTeamResearchAndPersist(
      {
        workflowRunId: "wf-gap",
        runId: "run-gap",
        traceId: "tr-gap",
        parsed: makeParsed({ jobId: "job-gap" }),
        hitlApproval: null,
      },
      m.deps,
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error.message).toContain("research_artifact_gate_failed");
    }
    expect(m.setStatusCalls).toEqual([
      ["wf-gap", "running"],
      ["wf-gap", "failed"],
    ]);
    expect(m.terminalCalls).toEqual([["wf-gap", "failed"]]);
    expect(m.publishedEvents).toHaveLength(0);
  });

  test("HitlAwaitingApprovalError 不会被当成 generic error → 不会调 failJob 或 onTerminal", async () => {
    const m = makeMockDeps();
    m.setExecuteResult(async () => {
      throw new HitlAwaitingApprovalError("req-x", "wf-x", "审批");
    });

    await runTeamResearchAndPersist(
      {
        workflowRunId: "wf-x",
        runId: "run-x",
        traceId: "tr-x",
        parsed: makeParsed(),
        hitlApproval: null,
      },
      m.deps,
    );

    expect(m.failJobCalls.length).toBe(0);
    expect(m.terminalCalls.length).toBe(0);
  });
});
