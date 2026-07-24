/**
 * F-P0-05 集成回归（2026-06）：getWorkflowObservability 必须从 `llm_call_log`
 * 取真实 LLM 调用 / token / cost，**不能**再只读 `agent_step.tokenCount`
 * （后者漏掉所有走 runLlmGateway 直调但不经 reason 节点的内部调用，如
 * orchestrator planning / runDebateSession / summarize_team_decision）。
 *
 * Bug 复现场景：
 *   - 同一 workflow 有 5 条 llm_call_log（含 1 条 agentDefinitionId=null，
 *     模拟"内部 LLM 调用"）
 *   - 只有 2 条 agent_step (phase=reason)，tokenCount 全部 null
 *   - 修复前：observability 返回 totalTokenCount=null，byAgentRole 找不到
 *     internal_llm 桶，所有 role 的 tokens 都是 null
 *   - 修复后：totalTokenCount=2010, llmCalls=5, byAgentRole 含 'internal_llm'
 *     桶，per-role tokens 来自 llm_call_log
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-obs-int-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const { getWorkflowObservability } = await import("../workflow-observability");

const WORKSPACE_ID = "ws-obs";
const PROJECT_ID = "proj-obs";
const SESSION_ID = "sess-obs";
const WORKFLOW_ID = "wf-obs-p005";
const OTHER_WORKFLOW_ID = "wf-obs-other";
const SANDBOX_ID = "sb-obs";
const DEF_FUND = "def-fund-obs";
const DEF_MACRO = "def-macro-obs";

describe("getWorkflowObservability · F-P0-05 集成", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();

    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "obs-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "obs-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
    await db
      .insert(schema.chatSession)
      .values({ id: SESSION_ID, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, title: "s" })
      .onConflictDoNothing();
    await db
      .insert(schema.workflowRun)
      .values([
        {
          id: WORKFLOW_ID,
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          goal: "g1",
          mode: "research",
          status: "completed",
        },
        {
          id: OTHER_WORKFLOW_ID,
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          goal: "noise",
          mode: "research",
          status: "completed",
        },
      ])
      .onConflictDoNothing();
    await db
      .insert(schema.sandboxPolicy)
      .values({ id: SANDBOX_ID, name: "obs-sb", description: "" })
      .onConflictDoNothing();
    await db
      .insert(schema.agentDefinition)
      .values([
        {
          id: DEF_FUND,
          role: "analyst_fundamental",
          name: "FundAnalyst",
          version: "v1",
          systemPrompt: "",
          toolsJson: [],
          mcpServersJson: [],
          skillsJson: [],
          subscriptionsJson: [],
          llmProvider: "mock",
          maxIterations: 6,
          sandboxPolicyId: SANDBOX_ID,
          enabled: true,
        },
        {
          id: DEF_MACRO,
          role: "analyst_macro",
          name: "MacroAnalyst",
          version: "v1",
          systemPrompt: "",
          toolsJson: [],
          mcpServersJson: [],
          skillsJson: [],
          subscriptionsJson: [],
          llmProvider: "mock",
          maxIterations: 6,
          sandboxPolicyId: SANDBOX_ID,
          enabled: true,
        },
      ])
      .onConflictDoNothing();

    /** 2 个 agent_instance + 2 个 agent_step (phase=reason)，但 tokenCount 都是 null
     *  —— 模拟"reason 节点跑了但没回填 token"或"走 gateway 后没 patch 回 agent_step"
     *  的常见生产路径。修复前 totalTokenCount=null，修复后应回退到 llm_call_log */
    await db.insert(schema.agentInstance).values([
      {
        id: "inst-fund",
        definitionId: DEF_FUND,
        workflowRunId: WORKFLOW_ID,
        status: "completed",
        currentIteration: 1,
      },
      {
        id: "inst-macro",
        definitionId: DEF_MACRO,
        workflowRunId: WORKFLOW_ID,
        status: "completed",
        currentIteration: 1,
      },
    ]);
    await db.insert(schema.agentStep).values([
      {
        id: "step-fund-1",
        agentInstanceId: "inst-fund",
        workflowRunId: WORKFLOW_ID,
        stepIndex: 1,
        phase: "reason",
        thought: "test",
        actionType: "tool_call",
        actionJson: {},
        tokenCount: null,
      },
      {
        id: "step-macro-1",
        agentInstanceId: "inst-macro",
        workflowRunId: WORKFLOW_ID,
        stepIndex: 1,
        phase: "reason",
        thought: "test",
        actionType: "tool_call",
        actionJson: {},
        tokenCount: null,
      },
    ]);

    /**
     * 5 条 llm_call_log：
     *   - 2 条 def-fund：500 + 600 = 1100 token, cost 0.005 + 0.006
     *   - 1 条 def-macro：800 token, cost 0.008
     *   - 1 条 agentDefinitionId=null（"内部" orchestrator planning 调用）：300 token, cost 0.003
     *   - 1 条 OTHER_WORKFLOW_ID：噪声，必须被 workflowRunId 过滤掉
     *
     * 期望：llm.llmCalls=4（不含其他 workflow），totalTokenCount=2200
     * byAgentRole 含 'analyst_fundamental' / 'analyst_macro' / 'internal_llm' 3 桶
     */
    await db.insert(schema.llmCallLog).values([
      {
        id: "llm-fund-1",
        workflowRunId: WORKFLOW_ID,
        agentStepId: "step-fund-1",
        agentDefinitionId: DEF_FUND,
        provider: "openai",
        model: "gpt-4",
        promptTokens: 400,
        completionTokens: 100,
        totalTokens: 500,
        promptCachedTokens: 200,
        latencyMs: 1000,
        status: "success",
        costUsd: 0.005,
        requestMetaJson: {
          nativeToolCallingUsed: true,
          promptCompacted: true,
          iteration: 2,
          promptComponentChars: {
            systemFinal: 9000,
            userGoalAndContext: 3000,
            tools: 400,
          },
        },
      },
      {
        id: "llm-fund-2",
        workflowRunId: WORKFLOW_ID,
        agentStepId: "step-fund-1",
        agentDefinitionId: DEF_FUND,
        provider: "openai",
        model: "gpt-4",
        promptTokens: 480,
        completionTokens: 120,
        totalTokens: 600,
        latencyMs: 1100,
        status: "success",
        costUsd: 0.006,
      },
      {
        id: "llm-macro-1",
        workflowRunId: WORKFLOW_ID,
        agentStepId: "step-macro-1",
        agentDefinitionId: DEF_MACRO,
        provider: "anthropic",
        model: "claude-3",
        promptTokens: 640,
        completionTokens: 160,
        totalTokens: 800,
        latencyMs: 1300,
        status: "success",
        costUsd: 0.008,
      },
      {
        id: "llm-internal-1",
        workflowRunId: WORKFLOW_ID,
        agentStepId: null,
        agentDefinitionId: null,
        provider: "deepseek",
        model: "deepseek-v4",
        promptTokens: 240,
        completionTokens: 60,
        totalTokens: 300,
        latencyMs: 700,
        status: "success",
        costUsd: 0.003,
      },
      {
        id: "llm-other-noise",
        workflowRunId: OTHER_WORKFLOW_ID,
        agentStepId: null,
        agentDefinitionId: DEF_FUND,
        provider: "openai",
        model: "gpt-4",
        totalTokens: 9999,
        latencyMs: 5000,
        status: "success",
        costUsd: 0.999,
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("LLM 顶层指标全部从 llm_call_log 取，而不是 agent_step.tokenCount", async () => {
    const obs = await getWorkflowObservability(WORKFLOW_ID);
    expect(obs.workflowRunId).toBe(WORKFLOW_ID);
    expect(obs.llm.llmCalls).toBe(4);
    expect(obs.llm.totalTokenCount).toBe(2200);
    expect(obs.llm.totalPromptTokens).toBe(1760);
    expect(obs.llm.totalCompletionTokens).toBe(440);
    expect(obs.llm.totalCostUsd).toBeCloseTo(0.022, 5);
    expect(obs.llm.reasonSteps).toBe(2);
  });

  test("byAgentRole 三桶：analyst_fundamental / analyst_macro / internal_llm（含无 def 的内部 LLM 调用）", async () => {
    const obs = await getWorkflowObservability(WORKFLOW_ID);
    const roles = obs.byAgentRole.map((r) => r.role);
    expect(roles).toContain("analyst_fundamental");
    expect(roles).toContain("analyst_macro");
    expect(roles).toContain("internal_llm");

    const fund = obs.byAgentRole.find((r) => r.role === "analyst_fundamental")!;
    expect(fund.llmCalls).toBe(2);
    expect(fund.tokens).toBe(1100);
    expect(fund.llmPromptTokens).toBe(880);
    expect(fund.llmCompletionTokens).toBe(220);
    expect(fund.llmCostUsd).toBeCloseTo(0.011, 5);

    const macro = obs.byAgentRole.find((r) => r.role === "analyst_macro")!;
    expect(macro.llmCalls).toBe(1);
    expect(macro.tokens).toBe(800);
    expect(macro.llmCostUsd).toBeCloseTo(0.008, 5);

    const internal = obs.byAgentRole.find((r) => r.role === "internal_llm")!;
    expect(internal.llmCalls).toBe(1);
    expect(internal.tokens).toBe(300);
    expect(internal.llmCostUsd).toBeCloseTo(0.003, 5);
    // 内部 LLM 调用没经过 agent_step，reasonSteps=0 是预期
    expect(internal.reasonSteps).toBe(0);
  });

  test("workflowRunId 过滤生效——其他 workflow 的 llm_call_log 不会污染本 workflow 统计", async () => {
    const obs = await getWorkflowObservability(WORKFLOW_ID);
    // 9999 token 的 noise 行不应进 totalTokenCount
    expect(obs.llm.totalTokenCount).not.toBe(12199);
    expect(obs.llm.totalTokenCount).toBe(2200);
  });

  test("返回预算、缓存、原生工具与 Prompt 组件效率归因", async () => {
    const obs = await getWorkflowObservability(WORKFLOW_ID);
    expect(obs.efficiency.averageTokensPerCall).toBe(550);
    expect(obs.efficiency.promptTokenShare).toBeCloseTo(0.8, 5);
    expect(obs.efficiency.cachedPromptTokenShare).toBeCloseTo(200 / 1760, 5);
    expect(obs.efficiency.nativeToolCallingRate).toBe(0.25);
    expect(obs.efficiency.compactedCalls).toBe(1);
    expect(obs.efficiency.promptComponentsChars.systemFinal).toBe(9000);
    expect(obs.efficiency.tokenBudget.usedTokens).toBe(2200);
    expect(obs.efficiency.tokenBudget.utilization).toBeGreaterThan(0);
    expect(obs.efficiency.estimatedWasteTokens.repeatedStaticContext).toBeGreaterThan(0);
  });

  test("空 workflow（无任何调用）返回 null token 字段 + 空 byAgentRole", async () => {
    const obs = await getWorkflowObservability("wf-nonexistent");
    expect(obs.llm.llmCalls).toBe(0);
    expect(obs.llm.totalTokenCount).toBeNull();
    expect(obs.llm.totalPromptTokens).toBeNull();
    expect(obs.llm.totalCostUsd).toBeNull();
    expect(obs.byAgentRole).toEqual([]);
  });
});
