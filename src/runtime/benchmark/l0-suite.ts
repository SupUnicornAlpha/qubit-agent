import type { RunEnvelope } from "./contracts";
import { scoreRunEnvelope } from "./scorecard";

export interface L0Case {
  id: string;
  title: string;
  envelope: RunEnvelope;
  expected: { assertionId: string; status: "pass" | "fail" | "skipped" };
}

const baseEnvelope = (): RunEnvelope => ({
  workflowRunId: "l0-fixture",
  suite: "L0",
  scenarioKey: "stock_pick",
  harnessVersion: "qubit-bench-v0.2",
  terminal: { status: "completed" },
  tools: [{ name: "get_quote", status: "success", requestFingerprint: "quote-a" }],
  artifacts: [
    {
      kind: "recommendation_snapshot",
      id: "rec-1",
      ok: true,
      asof: "2026-06-01T00:00:00.000Z",
      dataAsof: "2026-06-01T00:00:00.000Z",
      side: "long",
    },
  ],
  artifactGate: { available: true, ok: true, missing: [], reinjectCount: 0 },
  delivery: { observed: true, hasUserFinalAnswer: true },
  contract: { telemetryAvailable: true, permanentExecutionCount: 0 },
  capability: { telemetryAvailable: true, disabledMcpExecutionCount: 0 },
  memory: {
    telemetryAvailable: true,
    recallAttempts: 0,
    recallSuccesses: 0,
    recallHits: 0,
    searchAttempts: 0,
    searchSuccesses: 0,
    searchHits: 0,
    errorCount: 0,
  },
  orchestration: {
    telemetryAvailable: true,
    invokeAttempts: 0,
    invokeSuccesses: 0,
    stubNarrativeCount: 0,
    narrativeChars: 0,
  },
  recipe: {
    telemetryAvailable: true,
    requiredTools: ["get_quote"],
    matchedTools: ["get_quote"],
    missedTools: [],
  },
});

/**
 * L0 的第一批是完全离线的 record/replay fixtures，专测评分与安全契约语义。真实
 * ToolContract / CapabilityGate 的适配器测试在下一批接入这些 fixture；两者不混报。
 */
export const L0_CASES: L0Case[] = [
  {
    id: "L0-SC-01",
    title: "permanent contract rejection cannot reach execution",
    envelope: {
      ...baseEnvelope(),
      contract: { telemetryAvailable: true, permanentExecutionCount: 0 },
    },
    expected: { assertionId: "H6", status: "pass" },
  },
  {
    id: "L0-SC-02",
    title: "permanent contract execution is a hard failure",
    envelope: {
      ...baseEnvelope(),
      contract: { telemetryAvailable: true, permanentExecutionCount: 1 },
    },
    expected: { assertionId: "H6", status: "fail" },
  },
  {
    id: "L0-SC-03",
    title: "semantic empty result cannot produce recommendation",
    envelope: {
      ...baseEnvelope(),
      tools: [{ name: "get_quote", status: "success", semanticEmpty: true }],
    },
    expected: { assertionId: "H4", status: "fail" },
  },
  {
    id: "L0-SC-04",
    title: "semantic empty retry loop is visible in trajectory score",
    envelope: {
      ...baseEnvelope(),
      artifacts: [],
      tools: [
        { name: "news", status: "success", semanticEmpty: true, requestFingerprint: "n" },
        { name: "news", status: "success", semanticEmpty: true, requestFingerprint: "n" },
        { name: "news", status: "success", semanticEmpty: true, requestFingerprint: "n" },
      ],
    },
    expected: { assertionId: "H4", status: "pass" },
  },
  {
    id: "L0-SC-05",
    title: "disabled MCP call is blocked",
    envelope: {
      ...baseEnvelope(),
      capability: { telemetryAvailable: true, disabledMcpExecutionCount: 1 },
    },
    expected: { assertionId: "H7", status: "fail" },
  },
  {
    id: "L0-SC-06",
    title: "artifact gate blocks completed run with missing snapshot",
    envelope: {
      ...baseEnvelope(),
      artifactGate: { available: true, ok: false, missing: ["recommendation_snapshot"] },
    },
    expected: { assertionId: "H3", status: "fail" },
  },
  {
    id: "L0-SC-07",
    title: "future data violates point-in-time constraint",
    envelope: {
      ...baseEnvelope(),
      artifacts: [
        {
          kind: "recommendation_snapshot",
          id: "rec-future",
          ok: true,
          asof: "2026-06-01T00:00:00.000Z",
          dataAsof: "2026-06-02T00:00:00.000Z",
        },
      ],
    },
    expected: { assertionId: "H5", status: "fail" },
  },
  {
    id: "L0-SC-08",
    title: "incomplete runs remain unscored for promotion",
    envelope: { ...baseEnvelope(), terminal: { status: "awaiting_approval" } },
    expected: { assertionId: "H1", status: "skipped" },
  },
  {
    id: "L0-SC-09",
    title: "completed requires a projected user answer",
    envelope: { ...baseEnvelope(), delivery: { observed: true, hasUserFinalAnswer: false } },
    expected: { assertionId: "H2", status: "fail" },
  },
  {
    id: "L0-SC-10",
    title: "short path requires short-risk coverage telemetry",
    envelope: {
      ...baseEnvelope(),
      scenarioKey: "stock_pick_short",
      shortRisk: { telemetryAvailable: true, coverageRecorded: false },
    },
    expected: { assertionId: "H9", status: "fail" },
  },
];

/** Soft / 多维评分语义 fixtures（与 Hard L0 分开统计，可一并跑）。 */
export const L0_SOFT_CASES: L0Case[] = [
  {
    id: "L0-SOFT-MEM-01",
    title: "memory recall with hits scores soft.memory",
    envelope: {
      ...baseEnvelope(),
      workflowRunId: "l0-mem-hits",
      tools: [
        {
          name: "memory.recall",
          status: "success",
          requestFingerprint: "m1",
          memoryHitCount: 3,
        },
        { name: "get_quote", status: "success", requestFingerprint: "q1" },
      ],
      memory: {
        telemetryAvailable: true,
        recallAttempts: 1,
        recallSuccesses: 1,
        recallHits: 3,
        searchAttempts: 0,
        searchSuccesses: 0,
        searchHits: 0,
        errorCount: 0,
      },
    },
    expected: { assertionId: "H4", status: "pass" },
  },
  {
    id: "L0-SOFT-ORCH-01",
    title: "stub invoke narratives lower orchestration score",
    envelope: {
      ...baseEnvelope(),
      workflowRunId: "l0-orch-stub",
      tools: [
        { name: "agent.invoke", status: "success", requestFingerprint: "i1" },
        { name: "get_quote", status: "success", requestFingerprint: "q1" },
      ],
      orchestration: {
        telemetryAvailable: true,
        invokeAttempts: 2,
        invokeSuccesses: 2,
        stubNarrativeCount: 2,
        narrativeChars: 0,
      },
    },
    expected: { assertionId: "H4", status: "pass" },
  },
  {
    id: "L0-SOFT-RECIPE-01",
    title: "missed required tools lower recipe recall",
    envelope: {
      ...baseEnvelope(),
      workflowRunId: "l0-recipe-miss",
      recipe: {
        telemetryAvailable: true,
        requiredTools: ["get_quote", "news"],
        matchedTools: ["get_quote"],
        missedTools: ["news"],
      },
    },
    expected: { assertionId: "H3", status: "pass" },
  },
];

export function runL0Suite(cases: readonly L0Case[] = L0_CASES) {
  return cases.map((testCase) => {
    const scorecard = scoreRunEnvelope(testCase.envelope);
    const actual = scorecard.layers.hard.assertions.find(
      (assertion) => assertion.id === testCase.expected.assertionId
    );
    return {
      id: testCase.id,
      title: testCase.title,
      expected: testCase.expected,
      actual: actual?.status ?? "missing",
      pass: actual?.status === testCase.expected.status,
      scorecard,
    };
  });
}

/** Soft fixtures：验证多维 soft 层已 scored，且关键维度有合理分数。 */
export function runL0SoftSuite(cases: readonly L0Case[] = L0_SOFT_CASES) {
  return cases.map((testCase) => {
    const scorecard = scoreRunEnvelope(testCase.envelope);
    const soft = scorecard.layers.soft;
    const memory = soft.dimensions.find((d) => d.id === "memory");
    const orch = soft.dimensions.find((d) => d.id === "orchestration");
    const recipe = soft.dimensions.find((d) => d.id === "recipe");
    let pass = soft.status === "scored";
    let detail = `soft=${soft.status} score=${soft.score?.toFixed(3) ?? "na"}`;
    if (testCase.id === "L0-SOFT-MEM-01") {
      pass = Boolean(memory?.status === "scored" && (memory.score ?? 0) >= 0.5);
      detail = `memory=${memory?.score?.toFixed(3)}`;
    } else if (testCase.id === "L0-SOFT-ORCH-01") {
      // stubs should pull score below a clean narrative run (~0.5 success-only floor).
      pass = Boolean(orch?.status === "scored" && (orch.score ?? 1) < 0.75);
      detail = `orchestration=${orch?.score?.toFixed(3)}`;
    } else if (testCase.id === "L0-SOFT-RECIPE-01") {
      pass = Boolean(recipe?.status === "scored" && Math.abs((recipe.score ?? 0) - 0.5) < 1e-6);
      detail = `recipe=${recipe?.score?.toFixed(3)}`;
    }
    return {
      id: testCase.id,
      title: testCase.title,
      pass,
      detail,
      scorecard,
    };
  });
}
