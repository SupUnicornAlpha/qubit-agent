import { describe, expect, test } from "bun:test";
import { buildCoreUserText } from "../run-orchestrator-via-core";
import { readPrimeCoreBinding } from "../workflow-session-binding";

describe("prime core adapter helpers", () => {
  test("readPrimeCoreBinding requires sessionId + agentSpecId", () => {
    expect(readPrimeCoreBinding(null)).toBeNull();
    expect(readPrimeCoreBinding({})).toBeNull();
    expect(
      readPrimeCoreBinding({
        primeCore: { sessionId: "ses_1", agentSpecId: "def-orchestrator" },
      })
    ).toEqual({
      sessionId: "ses_1",
      agentSpecId: "def-orchestrator",
    });
  });

  test("resolveCoreBackend treats auto as ts until attach", async () => {
    const prev = process.env.QUBIT_CORE_BACKEND;
    process.env.QUBIT_CORE_BACKEND = "auto";
    const { resetCoreRuntimeCache, resolveCoreBackend } = await import("../core-runtime");
    resetCoreRuntimeCache();
    expect(resolveCoreBackend()).toBe("ts");
    if (prev === undefined) delete process.env.QUBIT_CORE_BACKEND;
    else process.env.QUBIT_CORE_BACKEND = prev;
    resetCoreRuntimeCache();
  });

  test("resolveCoreBackend defaults to ts", async () => {
    const prev = process.env.QUBIT_CORE_BACKEND;
    delete process.env.QUBIT_CORE_BACKEND;
    const { resetCoreRuntimeCache, resolveCoreBackend } = await import("../core-runtime");
    resetCoreRuntimeCache();
    expect(resolveCoreBackend()).toBe("ts");
    process.env.QUBIT_CORE_BACKEND = "rust";
    resetCoreRuntimeCache();
    expect(resolveCoreBackend()).toBe("rust");
    if (prev === undefined) delete process.env.QUBIT_CORE_BACKEND;
    else process.env.QUBIT_CORE_BACKEND = prev;
    resetCoreRuntimeCache();
  });

  test("buildCoreUserText includes HITL resume context", () => {
    const text = buildCoreUserText({
      taskType: "workflow_resume",
      workflowGoal: "分析 AAPL",
      params: {
        hitlApproval: { requestId: "h1", decision: "approved" },
        hitlPayload: { primeCoreInboxId: "inbox_x" },
        primeCoreInboxId: "inbox_x",
      },
    });
    expect(text).toContain("[hitl_approval]");
    expect(text).toContain("inbox_x");
    expect(text).toContain("分析 AAPL");
  });

  test("buildCoreUserText for chat keeps goal+context", () => {
    const text = buildCoreUserText({
      taskType: "orchestrator_chat",
      params: { goal: "hello", context: "ctx" },
    });
    expect(text).toContain("[context]\nctx");
    expect(text).toContain("[user]\nhello");
  });

  test("resolveCalleeSpecId maps role and definitionId", async () => {
    const { resolveCalleeSpecId } = await import("../run-specialist-via-core");
    expect(resolveCalleeSpecId({ definitionId: "def-research" })).toBe(
      "def-research"
    );
    expect(resolveCalleeSpecId({ role: "market_data" })).toBe("def-market-data");
    expect(resolveCalleeSpecId({ role: "analyst_technical" })).toBe(
      "def-analyst-technical"
    );
  });
});
