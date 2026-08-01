import { describe, expect, test } from "bun:test";
import { type TaskAssignPayload, TaskAssignPayloadSchema } from "../../../types/a2a";
import { attachA2aExecutionRunId } from "../a2a-loop-driver";
import {
  extractTopologyTaskEvidence,
  ownsWorkflowTerminalState,
  resolveA2aExecutionRunId,
  resolveA2aOrchestratorMaxIterations,
  resolveA2aSpecialistMaxIterations,
} from "../a2a-react-task";

function payload(taskType: string): TaskAssignPayload {
  return {
    taskId: "task-1",
    taskType,
    assignedRole: "analyst_technical",
    params: {},
  };
}

describe("A2A workflow terminal ownership", () => {
  test("topology child cannot overwrite the orchestrator workflow status", () => {
    expect(ownsWorkflowTerminalState(payload("topology_dispatch"))).toBe(false);
  });

  test("standalone workflow tasks retain terminal ownership", () => {
    expect(ownsWorkflowTerminalState(payload("manual_research"))).toBe(true);
  });
});

describe("A2A execution stream identity", () => {
  test("worker reuses the run id returned by the dispatcher", () => {
    const dispatched = attachA2aExecutionRunId(payload("workflow_start"), "stream-run-1");
    const task = TaskAssignPayloadSchema.parse(dispatched);
    expect(task.executionRunId).toBe("stream-run-1");
    expect(resolveA2aExecutionRunId(task)).toBe("stream-run-1");
  });

  test("direct A2A tasks without a dispatcher id still receive a run id", () => {
    expect(resolveA2aExecutionRunId(payload("manual_research"))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/
    );
  });
});

describe("A2A specialist iteration budget", () => {
  test("allows recovery and summary turns without removing the safety cap", () => {
    expect(resolveA2aSpecialistMaxIterations(5)).toBe(24);
    expect(resolveA2aSpecialistMaxIterations(24)).toBe(24);
    expect(resolveA2aSpecialistMaxIterations(80)).toBe(32);
  });

  test("does not silently inflate the orchestrator beyond the workflow budget", () => {
    expect(resolveA2aOrchestratorMaxIterations(24)).toBe(24);
    expect(resolveA2aOrchestratorMaxIterations(80)).toBe(80);
  });
});

describe("extractTopologyTaskEvidence", () => {
  test("treats a successful realtime quote object as verified market evidence", () => {
    const evidence = extractTopologyTaskEvidence("market_data", {
      toolCalls: [{ toolName: "qubit-data/fetch_quote", status: "success" }],
      observations: [
        {
          connectorResult: {
            symbol: "603986",
            exchange: "SH",
            source: "eastmoney",
            lastPrice: 123.45,
            timestamp: "2026-07-27T08:15:00.000Z",
            freshnessMs: 800,
          },
        },
      ],
    } as never);
    expect(evidence?.sourceTool).toBe("qubit-data/fetch_quote");
    expect(evidence?.result).toMatchObject({
      dataAvailable: true,
      dataKind: "quote",
      lastPrice: 123.45,
      freshnessMs: 800,
    });
  });
});
