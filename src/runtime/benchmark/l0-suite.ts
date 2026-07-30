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
  harnessVersion: "qubit-bench-v0.1",
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
