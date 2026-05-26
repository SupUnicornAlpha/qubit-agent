/**
 * P2-1：ACP → connector_call_log 字段映射回归测试（纯函数级，无 sqlite 依赖）。
 *
 * 覆盖 inferOperation / mapAcpStatusToConnectorStatus / buildConnectorLogInputFromAcpEvent
 * 三个 export 的纯函数，避免 bun ESM 不可 monkey-patch 模块导出的限制。
 */
import { describe, expect, test } from "bun:test";
import type { AcpRequest, AcpResponse } from "../../../types/acp";
import type { AcpCallObservedEvent } from "../../../messaging/acp";
import {
  buildConnectorLogInputFromAcpEvent,
  inferOperation,
  mapAcpStatusToConnectorStatus,
} from "../acp-monitoring-hook";

function buildRequest(overrides: Partial<AcpRequest> = {}): AcpRequest {
  return {
    traceId: "trace-1",
    sessionId: "sess-1",
    workflowId: "wf-1",
    senderAgent: "Coordinator",
    targetKind: "connector",
    targetName: "polygon",
    intent: "execute",
    inputSchemaVersion: "1.0",
    payload: { symbol: "AAPL" },
    timeoutMs: 30_000,
    riskLevel: "low",
    priority: 50,
    ...overrides,
  };
}

function buildResponse(status: AcpResponse["status"] = "success"): AcpResponse {
  return {
    traceId: "trace-1",
    status,
    errorCode: null,
    latencyMs: 100,
    outputSchemaVersion: "1.0",
    result: { ok: true },
  };
}

describe("inferOperation", () => {
  test("'execute' → 'execute'", () => {
    expect(inferOperation("execute")).toBe("execute");
  });
  test("'init' → 'init'", () => {
    expect(inferOperation("init")).toBe("init");
  });
  test("'healthcheck' / 'health_check' / 'ping' → 'healthcheck'", () => {
    expect(inferOperation("healthcheck")).toBe("healthcheck");
    expect(inferOperation("health_check")).toBe("healthcheck");
    expect(inferOperation("ping")).toBe("healthcheck");
  });
  test("'shutdown' / 'close' → 'shutdown'", () => {
    expect(inferOperation("shutdown")).toBe("shutdown");
    expect(inferOperation("close")).toBe("shutdown");
  });
  test("未知 intent 都 fallback 'execute'", () => {
    expect(inferOperation("place_order_v2")).toBe("execute");
    expect(inferOperation("query_balance")).toBe("execute");
    expect(inferOperation("")).toBe("execute");
    expect(inferOperation(undefined)).toBe("execute");
    expect(inferOperation(null)).toBe("execute");
  });
  test("大小写 / 前后空白都 normalize", () => {
    expect(inferOperation("  INIT  ")).toBe("init");
    expect(inferOperation("Healthcheck")).toBe("healthcheck");
  });
});

describe("mapAcpStatusToConnectorStatus", () => {
  test("'success' → 'success'", () => {
    expect(mapAcpStatusToConnectorStatus("success")).toBe("success");
  });
  test("'timeout' → 'timeout'", () => {
    expect(mapAcpStatusToConnectorStatus("timeout")).toBe("timeout");
  });
  test("'error' → 'error'", () => {
    expect(mapAcpStatusToConnectorStatus("error")).toBe("error");
  });
  test("'blocked' → 'error'", () => {
    expect(mapAcpStatusToConnectorStatus("blocked")).toBe("error");
  });
});

describe("buildConnectorLogInputFromAcpEvent", () => {
  function buildEvent(overrides: Partial<AcpCallObservedEvent> = {}): AcpCallObservedEvent {
    const request = buildRequest(overrides.request ?? {});
    const response = overrides.response ?? buildResponse();
    return {
      request,
      response,
      resultPayload: { ok: true },
      latencyMs: 42,
      status: response.status,
      ...(overrides.errorMessage ? { errorMessage: overrides.errorMessage } : {}),
    };
  }

  test("基本字段映射：connectorName / traceId / workflowRunId / operation / status", () => {
    const input = buildConnectorLogInputFromAcpEvent(buildEvent());
    expect(input.connectorName).toBe("polygon");
    expect(input.traceId).toBe("trace-1");
    expect(input.workflowRunId).toBe("wf-1");
    expect(input.operation).toBe("execute");
    expect(input.status).toBe("success");
    expect(input.latencyMs).toBe(42);
  });

  test("request payload 包了 intent/sessionId/senderAgent/riskLevel", () => {
    const input = buildConnectorLogInputFromAcpEvent(buildEvent());
    const reqRecord = input.request as Record<string, unknown>;
    expect(reqRecord.intent).toBe("execute");
    expect(reqRecord.sessionId).toBe("sess-1");
    expect(reqRecord.senderAgent).toBe("Coordinator");
    expect(reqRecord.riskLevel).toBe("low");
  });

  test("errorMessage 不存在时不应出现该字段（避免污染 exactOptional）", () => {
    const input = buildConnectorLogInputFromAcpEvent(buildEvent());
    expect("errorMessage" in input).toBe(false);
  });

  test("errorMessage 存在时透传", () => {
    const ev = buildEvent({
      response: buildResponse("error"),
      errorMessage: "connector borked",
    });
    const input = buildConnectorLogInputFromAcpEvent({ ...ev, status: "error" });
    expect(input.errorMessage).toBe("connector borked");
    expect(input.status).toBe("error");
  });

  test("blocked → error 透传", () => {
    const ev = buildEvent({
      response: buildResponse("blocked"),
      errorMessage: "blocked by sandbox",
    });
    const input = buildConnectorLogInputFromAcpEvent({ ...ev, status: "blocked" });
    expect(input.status).toBe("error");
  });
});
