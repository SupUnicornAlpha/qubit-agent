import { describe, expect, test } from "bun:test";
import type { StepStreamEvent } from "../../api/types";
import { resolveOrchestratorLivePhase } from "./orchestratorLivePhase";

function event(
  type: StepStreamEvent["type"],
  payload: Record<string, unknown> = {},
  role = "orchestrator"
): StepStreamEvent {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    traceId: "t-1",
    role,
    type,
    stepIndex: 1,
    ts: Date.now(),
    payload,
  };
}

describe("resolveOrchestratorLivePhase", () => {
  test("prefers HITL over tools", () => {
    const phase = resolveOrchestratorLivePhase({
      running: true,
      chatInFlight: true,
      pendingHitl: true,
      activity: null,
      streamEvents: [event("tool_call_start", { toolCallId: "1", toolName: "factor.list" })],
      subAgentRuns: [],
    });
    expect(phase?.kind).toBe("hitl");
  });

  test("shows running tool calls", () => {
    const phase = resolveOrchestratorLivePhase({
      running: true,
      chatInFlight: false,
      pendingHitl: false,
      activity: null,
      streamEvents: [
        event("tool_call_start", { toolCallId: "1", toolName: "strategy.create_version" }),
      ],
      subAgentRuns: [],
    });
    expect(phase?.kind).toBe("tool");
    expect(phase && "label" in phase ? phase.label : "").toContain("strategy.create_version");
  });

  test("idle ignores dangling tool_call_start", () => {
    const phase = resolveOrchestratorLivePhase({
      running: false,
      chatInFlight: false,
      pendingHitl: false,
      activity: null,
      streamEvents: [
        event("tool_call_start", { toolCallId: "1", toolName: "strategy.create_version" }),
      ],
      subAgentRuns: [],
    });
    expect(phase).toBeNull();
  });

  test("shows expert progress when no open tools", () => {
    const phase = resolveOrchestratorLivePhase({
      running: false,
      chatInFlight: false,
      pendingHitl: false,
      activity: null,
      streamEvents: [],
      subAgentRuns: [
        {
          role: "strategy",
          status: "running",
          dispatchedAt: null,
          updatedAt: new Date().toISOString(),
          headline: "组合因子中",
          stepCount: 2,
          toolCount: 1,
          inbound: [],
          outbound: [],
          steps: [],
          tools: [],
          mcps: [],
          streamingText: null,
        },
      ],
    });
    expect(phase?.kind).toBe("expert");
  });

  test("shows waiting for an expert instead of the parent call_team tool", () => {
    const phase = resolveOrchestratorLivePhase({
      running: true,
      chatInFlight: true,
      pendingHitl: false,
      activity: null,
      streamEvents: [
        event("tool_call_start", { toolCallId: "1", toolName: "call_team_market_data" }),
      ],
      subAgentRuns: [
        {
          role: "market_data",
          status: "running",
          dispatchedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          headline: "正在拉取 A 股 K 线",
          stepCount: 1,
          toolCount: 1,
          inbound: [],
          outbound: [],
          steps: [],
          tools: [],
          mcps: [],
          streamingText: null,
        },
      ],
    });
    expect(phase).toMatchObject({ kind: "expert", label: "market data 运行中" });
  });

  test("thinking when stream text present", () => {
    const phase = resolveOrchestratorLivePhase({
      running: false,
      chatInFlight: true,
      pendingHitl: false,
      activity: null,
      streamEvents: [],
      subAgentRuns: [],
      thinkingText: "先盘点因子池…",
    });
    expect(phase?.kind).toBe("thinking");
  });

  test("idle ignores leftover thinking text when turn finished", () => {
    const phase = resolveOrchestratorLivePhase({
      running: false,
      chatInFlight: false,
      pendingHitl: false,
      activity: null,
      streamEvents: [],
      subAgentRuns: [],
      thinkingText: "Prime Core reasoning… # 兆易创新",
    });
    expect(phase).toBeNull();
  });

  test("idle when nothing active", () => {
    const phase = resolveOrchestratorLivePhase({
      running: false,
      chatInFlight: false,
      pendingHitl: false,
      activity: null,
      streamEvents: [],
      subAgentRuns: [],
    });
    expect(phase).toBeNull();
  });
});
