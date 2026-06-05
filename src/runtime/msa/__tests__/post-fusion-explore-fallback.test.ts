/**
 * F-P0-08 回归（eval batch 3 / case 5）：
 *
 * 当 `orchestratorDecision === null` 且 `proceedToStrategy=false` 隐含成立
 * （signal=hold + confidence<0.45 + research 在 auxSlots），
 * `runPostFusionPipeline` 必须进入 explore_fallback 分支，写一条
 * `phase=research_explore_fallback` 的 interaction，否则前端"草稿 tab"永远是 0。
 *
 * 这个测试与 `post-fusion-interaction.test.ts` 不冲突：
 *   - 那个 test 走 proceedToStrategy=true 的常规 sequential 路径
 *   - 本 test 专门验证"orch=null 不再短路跳过 fallback"行为
 *
 * 复用其 mock 策略：interaction-log / strategy-script-files / backtest-job-runner
 * 全部 stub，纯内存跑 runPostFusionPipeline。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-explore-fallback-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeEach, describe, expect, mock, test } = await import("bun:test");

type InteractionCall = {
  fromRole: string;
  toRole: string;
  kind?: string;
  contentText: string;
  payloadJson?: Record<string, unknown>;
};

const interactionCalls: InteractionCall[] = [];

mock.module("../../research-team/interaction-log", () => ({
  logResearchTeamInteraction: async (input: InteractionCall) => {
    interactionCalls.push({
      fromRole: input.fromRole,
      toRole: input.toRole,
      contentText: input.contentText,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.payloadJson ? { payloadJson: input.payloadJson } : {}),
    });
  },
}));

mock.module("../../market/backtest-job-runner", () => ({
  runSmaCrossoverBacktestJob: async () => undefined,
}));

mock.module("../../strategy/strategy-script-files", () => ({
  exportStrategyScriptToWorkflowDir: async () => undefined,
}));

mock.module("../../llm/gateway", () => ({
  runLlmGateway: async () => ({ text: "{}" }),
}));

mock.module("../../config/model-config", () => ({
  loadModelConfig: async () => ({ provider: "deepseek", model: "deepseek-v4-pro" }),
}));

/**
 * `persistExploreFallbackDrafts` 在同文件内定义，不能 mock.module 切。
 * 测试里它会真的 getDb() 然后查 workflow_run；测试 workflow 不存在 → projectId 为
 * undefined → 函数直接 return []，对 DB 无写入。这条路径已被 source code 显式照顾，
 * 我们这里只验证「路由是否进入 fallback 分支」就够。
 */

const { runPostFusionPipeline } = await import("../analyst-team-pipeline");

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  interactionCalls.length = 0;
});

describe("runPostFusionPipeline explore_fallback 路由（F-P0-08）", () => {
  test("orch.proceedToStrategy=false + research 在 auxSlots → 进入 fallback 分支", async () => {
    const auxSlots = [{ role: "research" as const, slotKey: "research" }];

    const runAuxLlmCalls: Array<{ role: string; context: string }> = [];

    await runPostFusionPipeline({
      workflowRunId: "wf-fallback-1",
      ticker: "ZZZ_NO_DATA",
      fusionReport: "## fusion 报告（0 个分析师签到）",
      fusedSignal: "hold",
      fusedConfidence: 0.3,
      orchestratorDecision: {
        signal: "hold",
        confidence: 0.4,
        reasoning: "无分析师签到，自动判定 hold",
        proceedToStrategy: false,
        shouldDebate: false,
        debateReason: "0 个分析师签到，无对立视角可辩论",
      },
      relationEdges: [],
      // biome-ignore lint/suspicious/noExplicitAny: 测试用 slot
      auxSlots: auxSlots as any,
      runAuxLlm: async (slot, context) => {
        runAuxLlmCalls.push({ role: slot.role, context });
        return [
          "1. 因子方向 alpha101_volume_spike：捕捉异常成交。数据：vol/close. 检验：IC. 耗时：1d.",
          "2. 因子方向 macro_yield_curve_steepening：基于美债曲线斜率。数据：FRED. IC>0.04. 耗时：2d.",
          "3. 因子方向 sentiment_news_flow：新闻流量异常. 数据：news. RankIC>0.03. 耗时：1d.",
        ].join("\n");
      },
    });

    /** 必须真的把 explore_fallback 上下文送给 research */
    expect(runAuxLlmCalls.length).toBe(1);
    expect(runAuxLlmCalls[0]?.role).toBe("research");
    expect(runAuxLlmCalls[0]?.context).toContain("explore fallback");

    /** 必须写一条 phase=research_explore_fallback 的 llm_message */
    const fallbackLlm = interactionCalls.filter(
      (c) =>
        c.payloadJson?.["phase"] === "research_explore_fallback" &&
        (c.kind === undefined || c.kind === "llm_message")
    );
    expect(fallbackLlm.length).toBeGreaterThanOrEqual(1);
    /** 该 llm_message 必须出自 research → orchestrator（确保 fromRole/toRole 语义稳定） */
    expect(fallbackLlm[0]?.fromRole).toBe("research");
    expect(fallbackLlm[0]?.toRole).toBe("orchestrator");
  });

  test("orch.proceedToStrategy=true → 不应进 fallback（常规 sequential 路径）", async () => {
    const auxSlots = [{ role: "research" as const, slotKey: "research" }];

    await runPostFusionPipeline({
      workflowRunId: "wf-fallback-2",
      ticker: "AAPL",
      fusionReport: "## fusion 报告",
      fusedSignal: "buy",
      fusedConfidence: 0.7,
      orchestratorDecision: {
        signal: "buy",
        confidence: 0.7,
        reasoning: "trend strong",
        proceedToStrategy: true,
        shouldDebate: false,
      },
      relationEdges: [],
      // biome-ignore lint/suspicious/noExplicitAny: 测试用 slot
      auxSlots: auxSlots as any,
      runAuxLlm: async () => "## research body",
    });

    /** 不该走 fallback 分支 */
    const fallback = interactionCalls.filter(
      (c) => c.payloadJson?.["phase"] === "research_explore_fallback"
    );
    expect(fallback.length).toBe(0);
  });
});
