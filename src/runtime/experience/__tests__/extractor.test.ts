/**
 * Extractor Pipe 单测 — Memory V2 P1
 *
 * 用 InMemoryStore + fake ExtractorLoader，覆盖 3 条规则的命中 / 不命中 /
 * 去重 / linkAdd 链回 / handler 失败隔离。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getExperienceBus, setExperienceBusForTesting } from "../experience-bus";
import { InMemoryExperienceStore, setExperienceStoreForTesting } from "../experience-store";
import {
  type ExtractorHandle,
  type ExtractorLoader,
  type ExtractorWorkflowSummary,
  startExtractorPipe,
} from "../pipes/extractor";

class FakeLoader implements ExtractorLoader {
  summaries = new Map<string, ExtractorWorkflowSummary>();
  async loadWorkflowSummary(id: string): Promise<ExtractorWorkflowSummary | null> {
    return this.summaries.get(id) ?? null;
  }
}

function buildSummary(
  over: Partial<ExtractorWorkflowSummary> = {},
  participants?: ExtractorWorkflowSummary["participants"]
): ExtractorWorkflowSummary {
  return {
    workflowRunId: "wf-1",
    projectId: "proj-1",
    goal: "评估 momentum_20d 在 CN-A 的有效性",
    mode: "backtest",
    status: "completed",
    startedAt: "2026-06-02T09:00:00.000Z",
    endedAt: "2026-06-02T09:05:00.000Z",
    episodicIds: [],
    participants: participants ?? [
      {
        definitionId: "def-research",
        role: "research",
        toolsUsed: {
          "factor.list": 1,
          "discovery.run": 1,
          "discovery.promote": 1,
          "factor.autoEvaluate": 2,
          "skill.use_record": 1,
        },
        toolChain: [
          "factor.list",
          "discovery.run",
          "discovery.promote",
          "factor.autoEvaluate",
          "skill.use_record",
        ],
        finalAnswer:
          "momentum_20d 在 2024H1 回测：RankIC=0.045, IR=0.82, Sharpe=1.34, Max Drawdown=-12%。建议上线。",
        stepCount: 12,
      },
    ],
    ...over,
  };
}

let store: InMemoryExperienceStore;
let bus: ReturnType<typeof getExperienceBus>;
let loader: FakeLoader;
let extractor: ExtractorHandle;

beforeEach(() => {
  store = new InMemoryExperienceStore();
  setExperienceStoreForTesting(store);
  setExperienceBusForTesting(null);
  bus = getExperienceBus();
  loader = new FakeLoader();
  extractor = startExtractorPipe({ store, bus, loader });
});

afterEach(() => {
  extractor.detach();
  bus.clearAllForTesting();
  setExperienceStoreForTesting(null);
  setExperienceBusForTesting(null);
});

describe("Extractor — R1 factor_archive", () => {
  test("backtest + final_answer 含 RankIC → 命中", async () => {
    loader.summaries.set("wf-1", buildSummary());
    const ids = await extractor.extractOnce("wf-1");
    const semantic = await store.query({ kind: "semantic", subKind: "factor_archive" });
    expect(semantic.length).toBe(1);
    expect(ids).toContain(semantic[0]?.id);
    expect(semantic[0]?.contentJson.summary).toContain("backtest");
    expect(semantic[0]?.contentJson.goal).toContain("momentum_20d");
    expect(semantic[0]?.tagsJson).toContain("rule:R1");
    expect(semantic[0]?.visibility).toBe("project_shared"); // semantic 默认共享
    expect(semantic[0]?.definitionId).toBeNull();
  });

  test("mode=research → 不命中", async () => {
    loader.summaries.set("wf-1", buildSummary({ mode: "research" }));
    await extractor.extractOnce("wf-1");
    const semantic = await store.query({ kind: "semantic", subKind: "factor_archive" });
    expect(semantic.length).toBe(0);
  });

  test("final_answer 无量化指标关键词 → 不命中", async () => {
    loader.summaries.set(
      "wf-1",
      buildSummary({}, [
        {
          definitionId: "d",
          role: "research",
          toolsUsed: { "a.b": 1, "c.d": 1, "e.f": 1, "g.h": 1, "i.j": 1 },
          toolChain: ["a.b", "c.d", "e.f", "g.h", "i.j"],
          finalAnswer: "今天没跑出来什么有用的结果",
          stepCount: 6,
        },
      ])
    );
    await extractor.extractOnce("wf-1");
    expect((await store.query({ subKind: "factor_archive" })).length).toBe(0);
  });

  test("同 goal 重复触发不写第二条（去重）", async () => {
    loader.summaries.set("wf-1", buildSummary());
    loader.summaries.set("wf-2", buildSummary({ workflowRunId: "wf-2" }));
    await extractor.extractOnce("wf-1");
    await extractor.extractOnce("wf-2");
    expect((await store.query({ subKind: "factor_archive" })).length).toBe(1);
  });
});

describe("Extractor — R2 workflow_play", () => {
  test("5+ tool_call + 3+ distinct + 有 final_answer → 命中", async () => {
    loader.summaries.set("wf-1", buildSummary());
    await extractor.extractOnce("wf-1");
    const proc = await store.query({ kind: "procedural", subKind: "workflow_play" });
    expect(proc.length).toBe(1);
    expect(proc[0]?.metadataJson.signature).toContain("factor.list>discovery.run");
    expect(proc[0]?.contentJson.body).toContain("# auto-play");
  });

  test("仅 2 distinct tool → 不命中", async () => {
    loader.summaries.set(
      "wf-1",
      buildSummary({}, [
        {
          definitionId: "d",
          role: "research",
          toolsUsed: { "a.b": 4, "c.d": 4 },
          toolChain: ["a.b", "c.d"],
          finalAnswer: "done",
          stepCount: 8,
        },
      ])
    );
    await extractor.extractOnce("wf-1");
    expect((await store.query({ kind: "procedural" })).length).toBe(0);
  });

  test("同 signature 不重复写第二条", async () => {
    loader.summaries.set("wf-1", buildSummary());
    loader.summaries.set("wf-2", buildSummary({ workflowRunId: "wf-2", goal: "另一个 goal" }));
    await extractor.extractOnce("wf-1");
    await extractor.extractOnce("wf-2");
    const proc = await store.query({ kind: "procedural" });
    expect(proc.length).toBe(1);
  });
});

describe("Extractor — R3 iteration_summary", () => {
  test("role=research + final_answer 非空 → 命中", async () => {
    loader.summaries.set("wf-1", buildSummary());
    await extractor.extractOnce("wf-1");
    const iter = await store.query({ kind: "semantic", subKind: "iteration_summary" });
    expect(iter.length).toBe(1);
    expect(iter[0]?.tagsJson).toContain("rule:R3");
    expect(iter[0]?.tagsJson).toContain("mode:backtest");
  });

  test("role=risk → 不命中", async () => {
    loader.summaries.set(
      "wf-1",
      buildSummary({}, [
        {
          definitionId: "d",
          role: "risk",
          toolsUsed: { "a.b": 1, "c.d": 1, "e.f": 1 },
          toolChain: ["a.b", "c.d", "e.f"],
          finalAnswer: "风险评估通过",
          stepCount: 3,
        },
      ])
    );
    await extractor.extractOnce("wf-1");
    expect((await store.query({ subKind: "iteration_summary" })).length).toBe(0);
  });
});

describe("Extractor — derive_from 链回 episodic", () => {
  test("episodicIds 非空时给每条新经验加 derive_from link", async () => {
    const ep1 = await store.insert({
      kind: "episodic",
      scope: "workflow",
      scopeId: "wf-1",
      contentJson: { summary: "ep1" },
      validFrom: "2026-06-02T00:00:00.000Z",
    });
    loader.summaries.set("wf-1", buildSummary({ episodicIds: [ep1.id] }));
    const ids = await extractor.extractOnce("wf-1");
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const links = await store.linkList(id);
      expect(links.length).toBeGreaterThan(0);
      expect(links[0]?.relation).toBe("derive_from");
      expect(links[0]?.toId).toBe(ep1.id);
    }
  });
});

describe("Extractor — Bus 接入", () => {
  test("workflow_terminal 事件触发自动提炼", async () => {
    loader.summaries.set("wf-bus", buildSummary({ workflowRunId: "wf-bus" }));
    bus.emit({
      type: "workflow_terminal",
      workflowRunId: "wf-bus",
      projectId: "proj-1",
      status: "completed",
    });
    await bus.awaitIdle();
    expect((await store.query({ subKind: "factor_archive" })).length).toBe(1);
  });

  test("workflow_terminal 找不到 summary → 静默跳过", async () => {
    bus.emit({
      type: "workflow_terminal",
      workflowRunId: "wf-missing",
      projectId: "proj-1",
      status: "completed",
    });
    await bus.awaitIdle();
    expect((await store.query({})).length).toBe(0);
  });
});
