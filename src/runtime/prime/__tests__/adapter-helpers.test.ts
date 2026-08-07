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
    expect(text).toContain("AUTHORITATIVE");
  });

  test("buildCoreUserText resume prefers params.goal over workflowGoal", () => {
    const text = buildCoreUserText({
      taskType: "workflow_resume",
      workflowGoal: "长期研究任务",
      params: {
        resume: true,
        goal: "标的是兆易创新",
      },
    });
    expect(text).toContain("[user]\n标的是兆易创新");
    expect(text).not.toContain("[user]\n长期研究任务");
    expect(text).toContain("snapshot_resume=true");
  });

  test("buildCoreUserText for chat keeps goal+chronicle", () => {
    const text = buildCoreUserText({
      taskType: "orchestrator_chat",
      params: {
        goal: "hello",
        context:
          "OPTIONAL_BACKGROUND (session_chronicle) — do NOT override CURRENT_USER_TASK:\n- user: hi",
      },
    });
    expect(text).toContain("[session_chronicle]");
    expect(text).toContain("OPTIONAL_BACKGROUND");
    expect(text).toContain("[user]\nhello");
    expect(text.indexOf("[user]")).toBeGreaterThan(text.indexOf("[session_chronicle]"));
  });

  test("buildCoreUserText omitContext leaves only user task", () => {
    const text = buildCoreUserText({
      taskType: "orchestrator_chat",
      omitContext: true,
      params: {
        goal: "帮我选股",
        context: "OPTIONAL_BACKGROUND (session_chronicle) — big manual",
      },
    });
    expect(text).toContain("[user]\n帮我选股");
    expect(text).not.toContain("session_chronicle");
    expect(text).not.toContain("big manual");
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
