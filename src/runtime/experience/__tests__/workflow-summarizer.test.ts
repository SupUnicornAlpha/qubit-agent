/**
 * Wave-1（2026-06-10）：workflow-summarizer pipe 单元测试。
 *
 * 用 InMemory store/bus + stub LLM + stub loader，覆盖：
 *   - prompt 构造（语言、字段）
 *   - JSON 解析（fenced / 裸 / 无 goal_recap 失败）
 *   - daily budget 预扣减
 *   - completed 才处理，failed 跳过
 *   - sampleRate 决定是否跑
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  InMemoryExperienceStore,
  getExperienceBus,
  setExperienceBusForTesting,
} from "..";
import {
  _resetSummarizerBudgetForTesting,
  buildSummaryPrompt,
  parseSummaryJson,
  startWorkflowSummarizerPipe,
  type SummarizerLoader,
  type SummarizerLlmCallFn,
  type SummarizerWorkflowContext,
} from "../pipes/workflow-summarizer";

/**
 * 我们不 export `InProcessExperienceBus`；用 `setExperienceBusForTesting(null)` 重置 +
 * `getExperienceBus()` 拿全新单例，简化测试。
 */

function makeCtx(overrides: Partial<SummarizerWorkflowContext> = {}): SummarizerWorkflowContext {
  return {
    workflowRunId: "wf-test-1",
    projectId: "proj-1",
    goal: "找出 3 个高 IC 的因子并组成 strategy",
    mode: "research",
    startedAt: "2026-06-10T10:00:00Z",
    endedAt: "2026-06-10T10:30:00Z",
    recentStepsText:
      "### step 1 · research\nreason: 拉取 momentum_20d 因子\nfinal_answer: IC=0.045 IR=0.65\n",
    rolesInvolved: ["research", "backtest"],
    stepCount: 12,
    ...overrides,
  };
}

const SAMPLE_LLM_RESPONSE = `这里是分析：
\`\`\`json
{
  "goal_recap": "在 60 天回看期里 + universe = 沪深 300 上做了因子筛选",
  "key_findings": ["momentum_20d IC=0.045 IR=0.65", "value_pe 反向 IC=0.038"],
  "artifacts": ["factor:momentum_20d", "factor:value_pe", "strategy:long_short_v1"],
  "lessons": ["先看 turnover 再决定 ensemble", "走 walk-forward 验证更稳健"],
  "followups": ["在中证 500 上重跑", "加入 risk-concentration-var-checklist 风控"]
}
\`\`\`
end.`;

describe("buildSummaryPrompt", () => {
  test("system + user 含 mode / goal / 步数 / schema hint", () => {
    const ctx = makeCtx();
    const { system, user } = buildSummaryPrompt(ctx);
    expect(system).toContain("量化研究 PM 助理");
    expect(user).toContain("mode: research");
    expect(user).toContain(ctx.goal);
    expect(user).toContain("goal_recap");
    expect(user).toContain("key_findings");
  });

  test("recentStepsText 被截到 6000 字以内", () => {
    const big = "x".repeat(20000);
    const ctx = makeCtx({ recentStepsText: big });
    const { user } = buildSummaryPrompt(ctx);
    expect(user.includes(big)).toBe(false);
    /** 至少包含起点 */
    expect(user).toContain("x".repeat(100));
  });
});

describe("parseSummaryJson", () => {
  test("fenced json block 正确解析全部字段", () => {
    const p = parseSummaryJson(SAMPLE_LLM_RESPONSE);
    expect(p).not.toBeNull();
    expect(p!.goalRecap).toContain("沪深 300");
    expect(p!.keyFindings).toHaveLength(2);
    expect(p!.artifacts.length).toBeGreaterThan(0);
    expect(p!.lessons.length).toBeGreaterThan(0);
    expect(p!.followups.length).toBeGreaterThan(0);
  });

  test("裸 json（无 fence）也能解析", () => {
    const raw = `{"goal_recap":"x","key_findings":["a"],"artifacts":[],"lessons":[],"followups":[]}`;
    const p = parseSummaryJson(raw);
    expect(p?.goalRecap).toBe("x");
    expect(p?.keyFindings).toEqual(["a"]);
  });

  test("缺 goal_recap → null（强字段约束）", () => {
    const raw = `\`\`\`json
{"key_findings":["x"]}
\`\`\``;
    const p = parseSummaryJson(raw);
    expect(p).toBeNull();
  });

  test("非 json 文本 → null（不抛错）", () => {
    const p = parseSummaryJson("纯自然语言总结，没有结构化输出");
    expect(p).toBeNull();
  });

  test("非数组字段被解释为空数组（容错）", () => {
    const raw = `{"goal_recap":"x","key_findings":"not_array","artifacts":null,"lessons":["ok"],"followups":[]}`;
    const p = parseSummaryJson(raw);
    expect(p?.goalRecap).toBe("x");
    expect(p?.keyFindings).toEqual([]);
    expect(p?.artifacts).toEqual([]);
    expect(p?.lessons).toEqual(["ok"]);
  });
});

describe("startWorkflowSummarizerPipe", () => {
  let store: InMemoryExperienceStore;
  let loader: SummarizerLoader;
  let llmCalls: number;
  let llmStub: SummarizerLlmCallFn;

  beforeEach(() => {
    _resetSummarizerBudgetForTesting();
    /** 强制重建 default bus */
    setExperienceBusForTesting(null);
    store = new InMemoryExperienceStore();
    llmCalls = 0;
    llmStub = async (_p) => {
      llmCalls += 1;
      return { text: SAMPLE_LLM_RESPONSE, tokensUsed: 500 };
    };
    loader = {
      async loadContext(id) {
        if (id === "missing") return null;
        return makeCtx({ workflowRunId: id });
      },
    };
  });

  afterEach(() => {
    setExperienceBusForTesting(null);
  });

  test("completed workflow → 写一条 semantic / workflow_summary", async () => {
    const bus = getExperienceBus();
    const handle = startWorkflowSummarizerPipe({ store, bus, loader, llm: llmStub });
    const expId = await handle.summarizeOnce("wf-1");
    expect(expId).not.toBeNull();
    const exp = await store.findById(expId!);
    expect(exp?.kind).toBe("semantic");
    expect(exp?.subKind).toBe("workflow_summary");
    expect(exp?.scope).toBe("project");
    expect(exp?.scopeId).toBe("proj-1");
    expect(exp?.visibility).toBe("workspace_shared");
    expect(exp?.tagsJson).toContain("workflow_summary");
    handle.detach();
  });

  test("failed workflow → 不处理（不调 LLM、不写 store）", async () => {
    const bus = getExperienceBus();
    const handle = startWorkflowSummarizerPipe({ store, bus, loader, llm: llmStub });
    bus.emit({
      type: "workflow_terminal",
      workflowRunId: "wf-failed",
      projectId: "proj-1",
      status: "failed",
    });
    await bus.awaitIdle();
    expect(llmCalls).toBe(0);
    handle.detach();
  });

  test("loader 返回 null → 跳过，不抛错", async () => {
    const bus = getExperienceBus();
    const handle = startWorkflowSummarizerPipe({ store, bus, loader, llm: llmStub });
    const res = await handle.summarizeOnce("missing");
    expect(res).toBeNull();
    handle.detach();
  });

  test("sampleRate=0 → 全部 skip", async () => {
    const bus = getExperienceBus();
    const handle = startWorkflowSummarizerPipe({
      store,
      bus,
      loader,
      llm: llmStub,
      sampleRate: 0,
      random: () => 0.5,
    });
    const res = await handle.summarizeOnce("wf-1");
    expect(res).toBeNull();
    expect(llmCalls).toBe(0);
    handle.detach();
  });

  test("daily budget 超额 → skip + 不调 LLM", async () => {
    const bus = getExperienceBus();
    /**
     * 第 1 次写一条耗 5000 token 的；预算 6000 → 第 2 次预估 1200 + 5000 = 6200 > 6000 → 跳过
     */
    let toks = 5000;
    const stub: SummarizerLlmCallFn = async () => ({ text: SAMPLE_LLM_RESPONSE, tokensUsed: toks });
    const handle = startWorkflowSummarizerPipe({
      store,
      bus,
      loader,
      llm: stub,
      dailyBudgetTokens: 6000,
    });
    const first = await handle.summarizeOnce("wf-1");
    expect(first).not.toBeNull();
    toks = 100;
    const second = await handle.summarizeOnce("wf-2");
    expect(second).toBeNull();
    handle.detach();
  });

  test("LLM 输出无法解析 → 不写 store + 不抛错", async () => {
    const bus = getExperienceBus();
    const stub: SummarizerLlmCallFn = async () => ({ text: "garbage no json", tokensUsed: 200 });
    const handle = startWorkflowSummarizerPipe({ store, bus, loader, llm: stub });
    const res = await handle.summarizeOnce("wf-1");
    expect(res).toBeNull();
    handle.detach();
  });

  test("bus.emit('workflow_terminal', status=completed) 触发处理", async () => {
    const bus = getExperienceBus();
    const handle = startWorkflowSummarizerPipe({ store, bus, loader, llm: llmStub });
    bus.emit({
      type: "workflow_terminal",
      workflowRunId: "wf-via-bus",
      projectId: "proj-1",
      status: "completed",
    });
    await bus.awaitIdle();
    expect(llmCalls).toBeGreaterThan(0);
    handle.detach();
  });
});
