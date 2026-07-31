import { describe, expect, test } from "bun:test";
import type { AnalystTeamGraphPayload } from "../api/types";
import { buildSubAgentRunSummaries } from "./subAgentRuns";

function emptyGraph(partial: Partial<AnalystTeamGraphPayload> = {}): AnalystTeamGraphPayload {
  return {
    nodes: [],
    edges: [],
    interactions: [],
    toolCalls: [],
    mcpCalls: [],
    agentSteps: [],
    ...partial,
  };
}

describe("buildSubAgentRunSummaries", () => {
  test("hides msa / orchestrator and surfaces dispatched expert as queued", () => {
    const graph = emptyGraph({
      nodes: [
        { id: "n1", role: "orchestrator", label: "orch" },
        { id: "n2", role: "msa", label: "msa" },
        { id: "n3", role: "research", label: "research" },
      ],
      interactions: [
        {
          id: "1",
          workflowRunId: "wf",
          fromRole: "orchestrator",
          toRole: "research",
          kind: "llm_message",
          toolKind: null,
          toolName: null,
          contentText: "请研究 NVDA",
          payloadJson: null,
          createdAt: "2026-07-31T10:00:00.000Z",
        },
      ],
    });

    const runs = buildSubAgentRunSummaries({
      graph,
      streamingByRole: {},
      workflowRunning: true,
    });

    expect(runs.map((r) => r.role)).toEqual(["research"]);
    expect(runs[0]?.status).toBe("queued");
    expect(runs[0]?.headline).toContain("已派发");
  });

  test("marks streaming expert as running and prefers stream headline", () => {
    const graph = emptyGraph({
      interactions: [
        {
          id: "1",
          workflowRunId: "wf",
          fromRole: "orchestrator",
          toRole: "backtest",
          kind: "llm_message",
          toolKind: null,
          toolName: null,
          contentText: "跑回测",
          payloadJson: null,
          createdAt: "2026-07-31T10:00:00.000Z",
        },
      ],
    });

    const runs = buildSubAgentRunSummaries({
      graph,
      streamingByRole: {
        backtest: { text: "正在计算夏普比率…", ts: "2026-07-31T10:00:05.000Z" },
      },
      workflowRunning: true,
    });

    expect(runs[0]?.role).toBe("backtest");
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.headline).toContain("夏普");
  });

  test("uses heartbeat alive for running status", () => {
    const graph = emptyGraph({
      interactions: [
        {
          id: "1",
          workflowRunId: "wf",
          fromRole: "orchestrator",
          toRole: "risk",
          kind: "llm_message",
          toolKind: null,
          toolName: null,
          contentText: "审风控",
          payloadJson: null,
          createdAt: "2026-07-31T10:00:00.000Z",
        },
      ],
      toolCalls: [
        {
          id: "t1",
          agentRole: "risk",
          agentInstanceId: "i1",
          toolName: "check_limits",
          toolKind: "builtin",
          status: "success",
          latencyMs: 12,
          createdAt: "2026-07-31T10:00:02.000Z",
          agentStepId: "s1",
        },
      ],
    });

    const runs = buildSubAgentRunSummaries({
      graph,
      streamingByRole: {},
      workflowRunning: true,
      heartbeatsByRole: { risk: { alive: true, lastPhase: "act" } },
    });

    expect(runs[0]?.status).toBe("running");
  });
});
