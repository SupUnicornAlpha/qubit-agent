/**
 * Reflector prompt 升级单测 — Memory V2 P1.5
 *
 * 覆盖：
 *   - buildReflectionPrompt 默认带 few-shot；includeFewShot=false 可关掉
 *   - few-shot 内含正反例 + 关键引导词
 *   - playReflectionOnce 不写库，返回 prompt + raw + parsed + tokens
 *   - playReflectionOnce 解析失败时 parseError != null
 *   - evalLessonsAgainstGroundTruth：命中率正确、missed 列表正确
 */

import { describe, expect, test } from "bun:test";
import {
  REFLECTION_FEWSHOT,
  type ReflectorWorkflowContext,
  buildReflectionPrompt,
  evalLessonsAgainstGroundTruth,
  playReflectionOnce,
} from "../pipes/reflector";

function buildCtx(over: Partial<ReflectorWorkflowContext> = {}): ReflectorWorkflowContext {
  return {
    workflowRunId: "wf-1",
    projectId: "p1",
    status: "failed",
    mode: "research",
    goal: "评估 momentum_20d",
    failureHint: { role: "research", toolName: "factor.discoveryRun", errorClass: "TimeoutError" },
    definitionId: "def-r",
    episodicIds: [],
    recentStepsText: "step1\nstep2",
    ...over,
  };
}

describe("buildReflectionPrompt — few-shot 注入", () => {
  test("默认含 few-shot + schema + 输出约束", () => {
    const p = buildReflectionPrompt(buildCtx());
    expect(p.system).toContain("反思");
    expect(p.system).toContain("Schema");
    expect(p.system).toContain("示例");
    expect(p.system).toContain("factor.discoveryRun"); // few-shot 内含
    expect(p.system).toContain("反例");
  });

  test("includeFewShot=false 去掉示例段（A/B 对比用）", () => {
    const p = buildReflectionPrompt(buildCtx(), { includeFewShot: false });
    expect(p.system).not.toContain("示例");
    expect(p.system).not.toContain("反例");
    // schema 必须保留
    expect(p.system).toContain("Schema");
  });

  test("REFLECTION_FEWSHOT 含正反例标签", () => {
    expect(REFLECTION_FEWSHOT).toContain("示例 1");
    expect(REFLECTION_FEWSHOT).toContain("反例");
    expect(REFLECTION_FEWSHOT).toContain("failure_mode");
    expect(REFLECTION_FEWSHOT).toContain("preference");
  });

  test("user prompt 含 failureHint 字段", () => {
    const p = buildReflectionPrompt(buildCtx());
    expect(p.user).toContain("TimeoutError");
    expect(p.user).toContain("factor.discoveryRun");
  });
});

describe("playReflectionOnce — 调优用回放", () => {
  const VALID = `\`\`\`json
{"lessons":[{"subKind":"failure_mode","summary":"discoveryRun universe<20 容易 timeout","body":"加 assert","tags":["tool:factor.discoveryRun"]}]}
\`\`\``;

  test("不写库；返回 prompt + raw + parsed + tokens", async () => {
    const res = await playReflectionOnce({
      ctx: buildCtx(),
      llm: async () => ({ text: VALID, tokensUsed: 654 }),
    });
    expect(res.prompt.system.length).toBeGreaterThan(50);
    expect(res.rawText).toBe(VALID);
    expect(res.parsed.length).toBe(1);
    expect(res.tokensUsed).toBe(654);
    expect(res.parseError).toBeUndefined();
  });

  test("解析失败 → parseError 标记", async () => {
    const res = await playReflectionOnce({
      ctx: buildCtx(),
      llm: async () => ({ text: "garbage", tokensUsed: 100 }),
    });
    expect(res.parsed.length).toBe(0);
    expect(res.parseError).toBe("no_lessons_or_unparsable");
  });

  test("includeFewShot=false 透传到 prompt", async () => {
    const res = await playReflectionOnce({
      ctx: buildCtx(),
      llm: async () => ({ text: VALID, tokensUsed: 0 }),
      promptOptions: { includeFewShot: false },
    });
    expect(res.prompt.system).not.toContain("示例");
  });
});

describe("evalLessonsAgainstGroundTruth — 命中率", () => {
  test("subKind 匹配 + summary 至少 2 token 重合 → hit", () => {
    const truth = [
      {
        subKind: "failure_mode",
        summary: "discoveryRun universe 太小 timeout",
        body: "",
        tags: [],
      },
    ];
    const predicted = [
      {
        subKind: "failure_mode",
        summary: "discoveryRun universe 子集会 timeout",
        body: "",
        tags: [],
      },
    ];
    const r = evalLessonsAgainstGroundTruth(predicted, truth);
    expect(r.hit).toBe(1);
    expect(r.hitRate).toBe(1);
  });

  test("subKind 不一致 → miss", () => {
    const truth = [{ subKind: "failure_mode", summary: "a b c", body: "", tags: [] }];
    const predicted = [{ subKind: "preference", summary: "a b c", body: "", tags: [] }];
    const r = evalLessonsAgainstGroundTruth(predicted, truth);
    expect(r.hit).toBe(0);
    expect(r.missed).toContain("a b c");
  });

  test("truth 空时 hitRate=1", () => {
    expect(evalLessonsAgainstGroundTruth([], []).hitRate).toBe(1);
  });
});
