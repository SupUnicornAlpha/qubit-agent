/**
 * Writer Pipe 单测 — Memory V2 P1
 *
 * 100% 在 InMemoryStore + InProcessBus 上跑，零 DB 依赖。
 *
 * 覆盖：
 *   - step_emitted 第一条 → 新建 episodic
 *   - step_emitted 第 N 条 → append 到同一 episodic（折叠）
 *   - perceive / observe 类 step 被过滤掉，不入 episodic
 *   - episodic body 超长时按尾部截断到 EPISODIC_BODY_MAX_CP
 *   - experience_recalled → op_log + useCount++
 *   - experience_executed success/fail → op_log + successCount/failCount++
 *   - detach() 后所有 handler 失效
 *   - handler 内部抛错被吞，不影响其它 handler
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getExperienceBus, setExperienceBusForTesting } from "../experience-bus";
import { InMemoryExperienceStore, setExperienceStoreForTesting } from "../experience-store";
import {
  EPISODIC_BODY_MAX_CP,
  type WriterHandle,
  findOpenEpisodicForWorkflow,
  formatStepEntry,
  startWriterPipe,
} from "../pipes/writer";

let store: InMemoryExperienceStore;
let bus: ReturnType<typeof getExperienceBus>;
let writer: WriterHandle;

function makeStep(
  over: Partial<{
    stepIndex: number;
    phase: "perceive" | "reason" | "act" | "observe" | "external";
    actionType:
      | "tool_call"
      | "final_answer"
      | "memory_read"
      | "memory_write"
      | "a2a_send"
      | "cli_io";
    actionJson: unknown;
    observationJson: unknown | null;
  }> = {}
) {
  return {
    id: `step-${over.stepIndex ?? 1}`,
    agentInstanceId: "ai-1",
    workflowRunId: "wf-1",
    stepIndex: over.stepIndex ?? 1,
    phase: over.phase ?? ("act" as const),
    thought: null,
    actionType: over.actionType ?? ("tool_call" as const),
    actionJson: over.actionJson ?? { tool: "factor.list" },
    observationJson: over.observationJson ?? { count: 12 },
    tokenCount: null,
    latencyMs: null,
    createdAt: `2026-06-02T10:00:${String(over.stepIndex ?? 1).padStart(2, "0")}.000Z`,
  };
}

beforeEach(() => {
  store = new InMemoryExperienceStore();
  setExperienceStoreForTesting(store);
  setExperienceBusForTesting(null); // 强制重建一个干净的 Bus
  bus = getExperienceBus();
  writer = startWriterPipe({ store, bus });
});

afterEach(() => {
  writer.detach();
  bus.clearAllForTesting();
  setExperienceStoreForTesting(null);
  setExperienceBusForTesting(null);
});

describe("Writer — step_emitted 折叠", () => {
  test("第一条 step → 新建 episodic", async () => {
    bus.emit({
      type: "step_emitted",
      workflowRunId: "wf-1",
      definitionId: "def-research",
      step: makeStep({ stepIndex: 1 }),
    });
    await bus.awaitIdle();
    const found = await findOpenEpisodicForWorkflow(store, "wf-1");
    expect(found).not.toBeNull();
    expect(found?.kind).toBe("episodic");
    expect(found?.subKind).toBe("workflow_trail");
    expect(found?.contentJson.stepCount).toBe(1);
    expect(typeof found?.contentJson.body).toBe("string");
    expect(found?.contentJson.body).toContain("#1 act/tool_call");
  });

  test("第 N 条 step → append 同一行", async () => {
    for (let i = 1; i <= 3; i++) {
      bus.emit({
        type: "step_emitted",
        workflowRunId: "wf-1",
        definitionId: "def-r",
        step: makeStep({ stepIndex: i }),
      });
    }
    await bus.awaitIdle();
    const rows = await store.query({ kind: "episodic", scopeId: "wf-1" });
    expect(rows.length).toBe(1); // 折叠
    expect(rows[0]?.contentJson.stepCount).toBe(3);
    expect(rows[0]?.contentJson.body).toContain("#1");
    expect(rows[0]?.contentJson.body).toContain("#3");
  });

  test("perceive / observe 不入 episodic（防行爆炸）", async () => {
    bus.emit({
      type: "step_emitted",
      workflowRunId: "wf-x",
      definitionId: "def",
      step: makeStep({ phase: "perceive", actionType: "memory_read" }),
    });
    bus.emit({
      type: "step_emitted",
      workflowRunId: "wf-x",
      definitionId: "def",
      step: makeStep({ phase: "observe", actionType: "memory_read" }),
    });
    await bus.awaitIdle();
    const rows = await store.query({ kind: "episodic", scopeId: "wf-x" });
    expect(rows.length).toBe(0);
  });

  test("body 超长按尾部截断", async () => {
    const longArg = "x".repeat(5000);
    for (let i = 1; i <= 4; i++) {
      bus.emit({
        type: "step_emitted",
        workflowRunId: "wf-big",
        definitionId: "d",
        step: makeStep({ stepIndex: i, actionJson: { payload: longArg } }),
      });
    }
    await bus.awaitIdle();
    const rows = await store.query({ kind: "episodic", scopeId: "wf-big" });
    expect(rows[0]?.contentJson.body?.length ?? 0).toBeLessThanOrEqual(EPISODIC_BODY_MAX_CP);
  });
});

describe("Writer — experience_recalled", () => {
  test("写 op_log(op=recall) + useCount++", async () => {
    const exp = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "x" },
      validFrom: "2026-06-02T00:00:00.000Z",
    });
    bus.emit({
      type: "experience_recalled",
      experienceId: exp.id,
      workflowRunId: "wf-r",
      agentStepId: null,
      rank: 0,
      score: 0.9,
    });
    await bus.awaitIdle();
    const ops = await store.listOps(exp.id);
    expect(ops.length).toBe(1);
    expect(ops[0]?.op).toBe("recall");
    expect(ops[0]?.metadataJson.rank).toBe(0);
    const updated = await store.findById(exp.id);
    expect(updated?.useCount).toBe(1);
  });
});

describe("Writer — experience_executed", () => {
  test("outcome=success → successCount++", async () => {
    const exp = await store.insert({
      kind: "procedural",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "skill" },
      validFrom: "2026-06-02T00:00:00.000Z",
    });
    bus.emit({
      type: "experience_executed",
      experienceId: exp.id,
      workflowRunId: "wf-e",
      outcome: "success",
    });
    await bus.awaitIdle();
    const updated = await store.findById(exp.id);
    expect(updated?.successCount).toBe(1);
    expect(updated?.failCount).toBe(0);
  });

  test("outcome=fail → failCount++", async () => {
    const exp = await store.insert({
      kind: "procedural",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "y" },
      validFrom: "2026-06-02T00:00:00.000Z",
    });
    bus.emit({
      type: "experience_executed",
      experienceId: exp.id,
      workflowRunId: "wf-e",
      outcome: "fail",
    });
    await bus.awaitIdle();
    const updated = await store.findById(exp.id);
    expect(updated?.failCount).toBe(1);
  });

  test("outcome=partial/unknown 仅落 op_log，不动计数", async () => {
    const exp = await store.insert({
      kind: "procedural",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "y" },
      validFrom: "2026-06-02T00:00:00.000Z",
    });
    bus.emit({
      type: "experience_executed",
      experienceId: exp.id,
      workflowRunId: "wf-e",
      outcome: "partial",
    });
    await bus.awaitIdle();
    const updated = await store.findById(exp.id);
    expect(updated?.successCount).toBe(0);
    expect(updated?.failCount).toBe(0);
    const ops = await store.listOps(exp.id);
    expect(ops.length).toBe(1);
  });
});

describe("Writer — lifecycle", () => {
  test("detach() 后事件不再触发 writer", async () => {
    writer.detach();
    bus.emit({
      type: "step_emitted",
      workflowRunId: "wf-detached",
      definitionId: "d",
      step: makeStep(),
    });
    await bus.awaitIdle();
    expect((await store.query({ scopeId: "wf-detached" })).length).toBe(0);
  });

  test("handler 内部 store 抛错被吞 + 不影响后续事件", async () => {
    // 用 wrapper 让一次 logOp 抛错
    const orig = store.logOp.bind(store);
    let calls = 0;
    store.logOp = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return orig(input);
    };

    const exp = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "x" },
      validFrom: "2026-06-02T00:00:00.000Z",
    });

    bus.emit({
      type: "experience_recalled",
      experienceId: exp.id,
      workflowRunId: "wf-a",
      agentStepId: null,
      rank: 0,
      score: 1,
    });
    bus.emit({
      type: "experience_recalled",
      experienceId: exp.id,
      workflowRunId: "wf-b",
      agentStepId: null,
      rank: 0,
      score: 1,
    });
    await bus.awaitIdle();

    const ops = await store.listOps(exp.id);
    expect(ops.length).toBe(1); // 第二次成功
  });
});

describe("Writer — pure helpers", () => {
  test("formatStepEntry 紧凑可 grep", () => {
    const out = formatStepEntry(makeStep({ stepIndex: 7, actionJson: { tool: "foo" } }));
    expect(out).toContain("#7");
    expect(out).toContain("act/tool_call");
    expect(out).toContain('"tool":"foo"');
  });
});
