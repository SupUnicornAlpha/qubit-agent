/**
 * P1 回归：runPostFusionPipeline 末端写 research_team_interaction 时，
 * fromRole 必须是当前 slot.role，toRole 必须是 "msa"。
 *
 * 历史 bug（WF a65848b7 复盘）：
 *   - 旧实现 `fromRole: prevRole ?? "orchestrator", toRole: slot.role`
 *   - 结果 DB 里出现 "from=research / to=backtest" 但 content 实际是 backtest 的
 *     输出，前端拓扑画布把 backtest 的论述错误归到 research，且
 *     buildWorkflowPriorOutputsContext 按 from_role 过滤拿不到正确角色产出。
 *   - 正确语义：当前 slot 跑完一轮就把成果汇报给 msa（后续 fuse / report 阶段）。
 *
 * 同时也确认每个 slot 入场前写的"上游 handoff 提示"短消息 fromRole=prevRole 不变。
 *
 * 不依赖真 DB：用 mock.module 替换 interaction-log。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-post-fusion-interaction-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, describe, expect, mock, test } = await import("bun:test");

type InteractionCall = {
  fromRole: string;
  toRole: string;
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
      /** 条件 spread 避免显式 undefined，遵守 exactOptionalPropertyTypes */
      ...(input.payloadJson ? { payloadJson: input.payloadJson } : {}),
    });
  },
}));

/**
 * 同时 mock 掉 runNativeBacktestForTicker / persistStrategyScript / 内部 DB 查询，
 * 让 runPostFusionPipeline 走的是纯内存路径。
 */
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

const { runPostFusionPipeline } = await import("../analyst-team-pipeline");

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runPostFusionPipeline interaction fromRole/toRole", () => {
  test("每个 slot 跑完后写 fromRole=slot.role / toRole=msa", async () => {
    interactionCalls.length = 0;

    const auxSlots = [
      { role: "research" as const, slotKey: "research" },
      { role: "backtest" as const, slotKey: "backtest" },
      { role: "risk" as const, slotKey: "risk" },
    ];

    const runAuxLlmCalls: Array<{ role: string; context: string }> = [];

    await runPostFusionPipeline({
      workflowRunId: "wf-test",
      ticker: "NVDA",
      fusionReport: "## fusion 报告",
      fusedSignal: "buy",
      fusedConfidence: 0.7,
      orchestratorDecision: {
        signal: "buy",
        confidence: 0.7,
        reasoning: "test",
        proceedToStrategy: true,
        shouldDebate: false,
      },
      relationEdges: [],
      // biome-ignore lint/suspicious/noExplicitAny: 测试用空 slot 结构（实际只用 role 字段）
      auxSlots: auxSlots as any,
      runAuxLlm: async (slot, context) => {
        runAuxLlmCalls.push({ role: slot.role, context });
        return `## ${slot.role} 的输出 body`;
      },
    });

    /** 校验：每个 slot 跑完都写了一条 post_fusion 总结 */
    const postFusionCalls = interactionCalls.filter(
      (c) => c.payloadJson?.["phase"] === "post_fusion"
    );
    expect(postFusionCalls.length).toBe(3);
    for (const call of postFusionCalls) {
      const role = (call.payloadJson as { role: string }).role;
      expect(call.fromRole).toBe(role);
      expect(call.toRole).toBe("msa");
      expect(call.contentText).toContain(`${role} 的输出 body`);
    }

    /** 校验：slot 入场前的 handoff 提示 fromRole=prevRole（research → backtest 这种） */
    const handoffCalls = interactionCalls.filter(
      (c) => c.payloadJson?.["phase"] === "post_fusion_handoff"
    );
    /** 第一个 slot（research）没有 prevRole（首轮是 orchestrator）；2/3 才有 */
    expect(handoffCalls.length).toBeGreaterThanOrEqual(2);
    const r2b = handoffCalls.find(
      (c) => c.fromRole === "research" && c.toRole === "backtest"
    );
    const b2r = handoffCalls.find(
      (c) => c.fromRole === "backtest" && c.toRole === "risk"
    );
    expect(r2b).toBeTruthy();
    expect(b2r).toBeTruthy();
  });
});
