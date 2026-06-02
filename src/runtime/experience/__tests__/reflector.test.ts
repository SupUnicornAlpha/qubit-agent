/**
 * Reflector Pipe 单测 — Memory V2 P1
 *
 * 用 InMemoryStore + InMemoryReflectionRunRepo + stub LLM + stub time，
 * 覆盖 4 个分支：
 *   - failed + 新签名 → 真跑反思
 *   - failed + 24h 内已反思 → skipped_dedup
 *   - failed + 超日预算 → skipped_budget
 *   - completed + random > sampleRate → sampled_out
 * 以及 LLM 解析失败重试 + 失败终态。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getExperienceBus, setExperienceBusForTesting } from "../experience-bus";
import { InMemoryExperienceStore, setExperienceStoreForTesting } from "../experience-store";
import {
  type LlmCallFn,
  type ReflectorHandle,
  type ReflectorLoader,
  type ReflectorWorkflowContext,
  buildReflectionPrompt,
  computeFailureSignature,
  parseReflectionJson,
  startReflectorPipe,
} from "../pipes/reflector";
import { InMemoryReflectionRunRepo } from "../reflection-run-repo";

class FakeLoader implements ReflectorLoader {
  ctxs = new Map<string, ReflectorWorkflowContext>();
  async loadContext(id: string) {
    return this.ctxs.get(id) ?? null;
  }
}

function llmReturning(text: string, tokens = 800): LlmCallFn {
  return async () => ({ text, tokensUsed: tokens });
}

const VALID_LLM_OUTPUT = `Some explanation...

\`\`\`json
{
  "lessons": [
    {
      "subKind": "failure_mode",
      "summary": "factor.discoveryRun 在 universe<20 时常 timeout",
      "body": "应在调用前 assert universe.size >=20 否则切换为 fast mode",
      "tags": ["tool:factor.discoveryRun", "error:timeout"]
    }
  ]
}
\`\`\`
`;

let store: InMemoryExperienceStore;
let bus: ReturnType<typeof getExperienceBus>;
let loader: FakeLoader;
let repo: InMemoryReflectionRunRepo;
let reflector: ReflectorHandle;
let fixedNow: Date;

function buildCtx(over: Partial<ReflectorWorkflowContext> = {}): ReflectorWorkflowContext {
  return {
    workflowRunId: "wf-1",
    projectId: "proj-A",
    status: "failed",
    mode: "research",
    goal: "research momentum effect",
    failureHint: {
      role: "research",
      toolName: "factor.discoveryRun",
      errorClass: "TimeoutError",
    },
    definitionId: "def-research",
    episodicIds: [],
    recentStepsText: "step1\nstep2",
    ...over,
  };
}

beforeEach(() => {
  store = new InMemoryExperienceStore();
  setExperienceStoreForTesting(store);
  setExperienceBusForTesting(null);
  bus = getExperienceBus();
  loader = new FakeLoader();
  repo = new InMemoryReflectionRunRepo();
  fixedNow = new Date("2026-06-02T12:00:00.000Z");
});

afterEach(() => {
  reflector?.detach();
  bus.clearAllForTesting();
  setExperienceStoreForTesting(null);
  setExperienceBusForTesting(null);
});

describe("Reflector — failed 工作流必反思", () => {
  test("第一次失败 → 走真跑、写 reflective + reflection_run.completed", async () => {
    loader.ctxs.set("wf-1", buildCtx());
    reflector = startReflectorPipe({
      store,
      bus,
      loader,
      llm: llmReturning(VALID_LLM_OUTPUT),
      reflectionRepo: repo,
      now: () => fixedNow,
    });
    const res = await reflector.reflectOnce("wf-1");
    expect(res.status).toBe("completed");
    expect(res.producedIds.length).toBe(1);

    // reflective 必须 agent_private + definitionId=def-research
    const reflective = await store.query({ kind: "reflective" });
    expect(reflective.length).toBe(1);
    expect(reflective[0]?.visibility).toBe("agent_private");
    expect(reflective[0]?.definitionId).toBe("def-research");
    expect(reflective[0]?.subKind).toBe("failure_mode");
    expect(reflective[0]?.tagsJson.some((t) => t.startsWith("signature:"))).toBe(true);
  });

  test("24h 内同签名重复失败 → skipped_dedup", async () => {
    loader.ctxs.set("wf-1", buildCtx());
    loader.ctxs.set("wf-2", buildCtx({ workflowRunId: "wf-2" }));
    reflector = startReflectorPipe({
      store,
      bus,
      loader,
      llm: llmReturning(VALID_LLM_OUTPUT),
      reflectionRepo: repo,
      now: () => fixedNow,
    });
    const r1 = await reflector.reflectOnce("wf-1");
    expect(r1.status).toBe("completed");
    const r2 = await reflector.reflectOnce("wf-2");
    expect(r2.status).toBe("skipped_dedup");
    // 还是只有 1 条 reflective
    expect((await store.query({ kind: "reflective" })).length).toBe(1);
  });

  test("超日预算 → skipped_budget", async () => {
    loader.ctxs.set("wf-1", buildCtx());
    loader.ctxs.set(
      "wf-2",
      buildCtx({
        workflowRunId: "wf-2",
        failureHint: {
          role: "research",
          toolName: "different_tool",
          errorClass: "OtherError",
        },
      })
    );
    reflector = startReflectorPipe({
      store,
      bus,
      loader,
      llm: llmReturning(VALID_LLM_OUTPUT, 1200), // 单次 1200 token
      reflectionRepo: repo,
      now: () => fixedNow,
      // 预算 2500：第一次预扣减式检查 0+1500<=2500 → 跑 → 消耗 1200；
      // 第二次 1200+1500=2700>2500 → skipped_budget
      dailyBudgetTokens: 2500,
    });
    const r1 = await reflector.reflectOnce("wf-1");
    expect(r1.status).toBe("completed");
    const r2 = await reflector.reflectOnce("wf-2");
    expect(r2.status).toBe("skipped_budget");
  });
});

describe("Reflector — completed 走抽样", () => {
  test("random > sampleRate → sampled_out 不调 LLM", async () => {
    let llmCalled = 0;
    loader.ctxs.set("wf-c", buildCtx({ status: "completed" }));
    reflector = startReflectorPipe({
      store,
      bus,
      loader,
      llm: async () => {
        llmCalled += 1;
        return { text: VALID_LLM_OUTPUT, tokensUsed: 100 };
      },
      reflectionRepo: repo,
      now: () => fixedNow,
      sampleCompletedRate: 0.1,
      random: () => 0.9, // > 0.1
    });
    const res = await reflector.reflectOnce("wf-c");
    expect(res.status).toBe("sampled_out");
    expect(llmCalled).toBe(0);
  });

  test("random <= sampleRate → 真跑", async () => {
    loader.ctxs.set("wf-c2", buildCtx({ status: "completed" }));
    reflector = startReflectorPipe({
      store,
      bus,
      loader,
      llm: llmReturning(VALID_LLM_OUTPUT),
      reflectionRepo: repo,
      now: () => fixedNow,
      sampleCompletedRate: 0.5,
      random: () => 0.3,
    });
    const res = await reflector.reflectOnce("wf-c2");
    expect(res.status).toBe("completed");
    expect(res.producedIds.length).toBe(1);
    const reflective = await store.query({ kind: "reflective" });
    expect(reflective[0]?.qualityScore).toBeCloseTo(0.5, 5); // completed 起始 0.5
  });
});

describe("Reflector — LLM 输出解析", () => {
  test("第一次不可解析 → 重试 1 次成功", async () => {
    let calls = 0;
    const llm: LlmCallFn = async () => {
      calls += 1;
      if (calls === 1) return { text: "garbage no json here", tokensUsed: 200 };
      return { text: VALID_LLM_OUTPUT, tokensUsed: 800 };
    };
    loader.ctxs.set("wf-1", buildCtx());
    reflector = startReflectorPipe({
      store,
      bus,
      loader,
      llm,
      reflectionRepo: repo,
      now: () => fixedNow,
    });
    const res = await reflector.reflectOnce("wf-1");
    expect(res.status).toBe("completed");
    expect(calls).toBe(2);
  });

  test("两次都不可解析 → failed", async () => {
    loader.ctxs.set("wf-1", buildCtx());
    reflector = startReflectorPipe({
      store,
      bus,
      loader,
      llm: llmReturning("not json", 100),
      reflectionRepo: repo,
      now: () => fixedNow,
    });
    const res = await reflector.reflectOnce("wf-1");
    expect(res.status).toBe("failed");
    expect(res.producedIds.length).toBe(0);
  });

  test("LLM 抛错 → failed 终态", async () => {
    loader.ctxs.set("wf-1", buildCtx());
    reflector = startReflectorPipe({
      store,
      bus,
      loader,
      llm: async () => {
        throw new Error("network down");
      },
      reflectionRepo: repo,
      now: () => fixedNow,
    });
    const res = await reflector.reflectOnce("wf-1");
    expect(res.status).toBe("failed");
  });
});

describe("Reflector — Bus 接入", () => {
  test("workflow_terminal failed 事件触发反思", async () => {
    loader.ctxs.set("wf-x", buildCtx({ workflowRunId: "wf-x" }));
    reflector = startReflectorPipe({
      store,
      bus,
      loader,
      llm: llmReturning(VALID_LLM_OUTPUT),
      reflectionRepo: repo,
      now: () => fixedNow,
    });
    bus.emit({
      type: "workflow_terminal",
      workflowRunId: "wf-x",
      projectId: "proj-A",
      status: "failed",
    });
    await bus.awaitIdle();
    expect((await store.query({ kind: "reflective" })).length).toBe(1);
  });
});

describe("Reflector — 纯函数", () => {
  test("computeFailureSignature 同输入同输出", () => {
    const s1 = computeFailureSignature(buildCtx());
    const s2 = computeFailureSignature(buildCtx());
    expect(s1).toBe(s2);
    expect(s1.length).toBe(16);
  });

  test("parseReflectionJson 接受 fenced ```json", () => {
    const r = parseReflectionJson(VALID_LLM_OUTPUT);
    expect(r.length).toBe(1);
    expect(r[0]?.subKind).toBe("failure_mode");
    expect(r[0]?.tags).toContain("tool:factor.discoveryRun");
  });

  test("parseReflectionJson 空 lessons 数组也合法 → 返回 []", () => {
    const r = parseReflectionJson('```json\n{"lessons": []}\n```');
    expect(r).toEqual([]);
  });

  test("buildReflectionPrompt 含 failureHint 描述", () => {
    const p = buildReflectionPrompt(buildCtx());
    expect(p.user).toContain("factor.discoveryRun");
    expect(p.user).toContain("TimeoutError");
    expect(p.system).toContain("反思");
  });
});
