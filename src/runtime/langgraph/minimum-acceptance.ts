import { graphRunner } from "./graph-factory";
import { getDb } from "../../db/sqlite/client";
import {
  acpCall,
  agentDefinition,
  agentStep,
  project,
  sandboxPolicy,
  sandboxViolationLog,
  toolCallLog,
  workflowRun,
  workspace,
} from "../../db/sqlite/schema";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";

async function ensureBaseProject() {
  const db = await getDb();
  const wsId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  await db.insert(workspace).values({
    id: wsId,
    name: "LangGraph Acceptance Workspace",
    owner: "system",
  });
  await db.insert(project).values({
    id: projectId,
    workspaceId: wsId,
    name: "LangGraph Acceptance Project",
    marketScope: "CN-A",
    status: "active",
  });
  return projectId;
}

async function createWorkflow(projectId: string, goal: string) {
  const db = await getDb();
  const workflowId = crypto.randomUUID();
  await db.insert(workflowRun).values({
    id: workflowId,
    projectId,
    goal,
    mode: "research",
    status: "pending",
  });
  return workflowId;
}

async function upsertPolicy(params: {
  id: string;
  allowedTools: string[];
  maxIterationsPerRun: number;
}): Promise<void> {
  const db = await getDb();
  await db
    .insert(sandboxPolicy)
    .values({
      id: params.id,
      name: params.id,
      description: `acceptance-${params.id}`,
      allowedToolsJson: params.allowedTools,
      allowedMcpServersJson: [],
      allowedConnectorsJson: [],
      allowedHostsJson: [],
      allowedFsPathsJson: [],
      canWriteMemory: true,
      canReadLiveMarket: false,
      canSubmitOrder: false,
      maxToolCallMs: 30_000,
      maxIterationsPerRun: params.maxIterationsPerRun,
      maxOutputTokens: 4096,
      isolationLevel: "none",
    })
    .onConflictDoUpdate({
      target: sandboxPolicy.id,
      set: {
        allowedToolsJson: params.allowedTools,
        maxIterationsPerRun: params.maxIterationsPerRun,
        updatedAt: new Date().toISOString(),
      },
    });
}

async function writeWorkspaceConfig(params: {
  definitions: Array<{
    id: string;
    role: string;
    name: string;
    version: string;
    systemPrompt: string;
    tools: string[];
    mcpServers: string[];
    skills: string[];
    subscriptions: string[];
    llmProvider: string;
    maxIterations: number;
    sandboxPolicyId: string;
    enabled: boolean;
  }>;
  policies: Array<{
    id: string;
    name: string;
    description: string;
    allowedTools: string[];
    allowedMcpServers: string[];
    allowedConnectors: string[];
    allowedHosts: string[];
    allowedFsPaths: string[];
    maxToolCallMs: number;
    maxIterationsPerRun: number;
    maxOutputTokens: number;
    isolationLevel: "none" | "process" | "vm";
    canWriteMemory: boolean;
    canReadLiveMarket: boolean;
    canSubmitOrder: boolean;
  }>;
}) {
  const dir = join(process.cwd(), ".qubit");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "agents.json"),
    JSON.stringify({ definitions: params.definitions }, null, 2),
    "utf-8"
  );
  await writeFile(
    join(dir, "sandbox.json"),
    JSON.stringify({ policies: params.policies }, null, 2),
    "utf-8"
  );
}

async function setDefinitionPolicy(definitionId: string, policyId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(agentDefinition)
    .set({ sandboxPolicyId: policyId, updatedAt: new Date().toISOString() })
    .where(eq(agentDefinition.id, definitionId));
}

async function waitWorkflowDone(workflowId: string): Promise<"completed" | "failed"> {
  const db = await getDb();
  const maxRetry = 200;
  for (let i = 0; i < maxRetry; i += 1) {
    const rows = await db
      .select({ status: workflowRun.status })
      .from(workflowRun)
      .where(eq(workflowRun.id, workflowId))
      .limit(1);
    const status = rows[0]?.status;
    if (status === "completed" || status === "failed") {
      return status;
    }
    await Bun.sleep(50);
  }
  throw new Error(`workflow ${workflowId} was not finished in expected time`);
}

async function assertWorkflowDbRecords(workflowId: string, expectFailed: boolean): Promise<void> {
  const db = await getDb();
  const [statusRow] = await db
    .select({ status: workflowRun.status })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  const steps = await db
    .select({ id: agentStep.id })
    .from(agentStep)
    .where(eq(agentStep.workflowRunId, workflowId));
  const tools = await db
    .select({ id: toolCallLog.id })
    .from(toolCallLog)
    .innerJoin(agentStep, eq(toolCallLog.agentStepId, agentStep.id))
    .where(eq(agentStep.workflowRunId, workflowId));
  const acps = await db
    .select({ id: acpCall.id })
    .from(acpCall)
    .where(eq(acpCall.workflowRunId, workflowId));

  if (steps.length === 0) {
    throw new Error(`workflow=${workflowId} no agent_step records found`);
  }
  if (tools.length === 0) {
    throw new Error(`workflow=${workflowId} no tool_call_log records found`);
  }
  if (acps.length === 0) {
    throw new Error(`workflow=${workflowId} no acp_call records found`);
  }

  const isFailed = statusRow?.status === "failed";
  if (expectFailed && !isFailed) {
    throw new Error(`workflow=${workflowId} should be failed by max_iterations`);
  }
  if (!expectFailed && statusRow?.status !== "completed") {
    throw new Error(`workflow=${workflowId} should be completed`);
  }

  console.log(
    `[acceptance] workflow=${workflowId} status=${statusRow?.status} steps=${steps.length} tools=${tools.length} acp=${acps.length}`
  );
}

async function assertSandboxBlocked(workflowId: string): Promise<void> {
  const db = await getDb();
  const blockedTools = await db
    .select({ id: toolCallLog.id, status: toolCallLog.status })
    .from(toolCallLog)
    .innerJoin(agentStep, eq(toolCallLog.agentStepId, agentStep.id))
    .where(eq(agentStep.workflowRunId, workflowId));
  const blockedAcp = await db
    .select({ id: acpCall.id, status: acpCall.status })
    .from(acpCall)
    .where(eq(acpCall.workflowRunId, workflowId));
  const violations = await db
    .select({ id: sandboxViolationLog.id })
    .from(sandboxViolationLog)
    .where(eq(sandboxViolationLog.workflowRunId, workflowId));

  const hasToolBlocked = blockedTools.some((row) => row.status === "sandbox_blocked");
  const hasAcpBlocked = blockedAcp.some((row) => row.status === "blocked_by_sandbox");
  if (!hasToolBlocked || !hasAcpBlocked || violations.length === 0) {
    throw new Error(`workflow=${workflowId} sandbox blocked assertions failed`);
  }
}

async function main() {
  await graphRunner.start();
  await writeWorkspaceConfig({
    definitions: [
      {
        id: "def-orchestrator",
        role: "orchestrator",
        name: "Orchestrator",
        version: "3.0.0",
        systemPrompt: "Workspace configured orchestrator.",
        tools: ["task_decompose", "assign_task"],
        mcpServers: [],
        skills: [],
        subscriptions: ["TASK_ASSIGN", "TASK_RESULT", "ALERT", "RISK_BLOCK"],
        llmProvider: "openai:gpt-4o-mini",
        maxIterations: 20,
        sandboxPolicyId: "default-policy",
        enabled: true,
      },
      {
        id: "def-research",
        role: "research",
        name: "Research",
        version: "3.0.0",
        systemPrompt: "Workspace configured research.",
        tools: ["compute_factors", "run_experiment", "version_strategy"],
        mcpServers: [],
        skills: [],
        subscriptions: ["TASK_ASSIGN", "MODEL_UPDATE"],
        llmProvider: "openai:gpt-4o-mini",
        maxIterations: 20,
        sandboxPolicyId: "default-policy",
        enabled: true,
      },
      {
        id: "def-backtest",
        role: "backtest",
        name: "Backtest",
        version: "3.0.0",
        systemPrompt: "Workspace configured backtest.",
        tools: ["run_backtest", "get_backtest_status"],
        mcpServers: [],
        skills: [],
        subscriptions: ["TASK_ASSIGN"],
        llmProvider: "openai:gpt-4o-mini",
        maxIterations: 20,
        sandboxPolicyId: "default-policy",
        enabled: true,
      },
    ],
    policies: [
      {
        id: "default-policy",
        name: "default-policy",
        description: "workspace default policy",
        allowedTools: [
          "task_decompose",
          "assign_task",
          "compute_factors",
          "run_experiment",
          "version_strategy",
          "run_backtest",
          "get_backtest_status",
        ],
        allowedMcpServers: [],
        allowedConnectors: [],
        allowedHosts: [],
        allowedFsPaths: [],
        maxToolCallMs: 30_000,
        maxIterationsPerRun: 20,
        maxOutputTokens: 4096,
        isolationLevel: "none",
        canWriteMemory: true,
        canReadLiveMarket: false,
        canSubmitOrder: false,
      },
    ],
  });
  await graphRunner.reload();
  const projectId = await ensureBaseProject();

  await upsertPolicy({
    id: "default-policy",
    allowedTools: [
      "task_decompose",
      "assign_task",
      "compute_factors",
      "run_experiment",
      "version_strategy",
      "run_backtest",
      "get_backtest_status",
    ],
    maxIterationsPerRun: 20,
  });
  await graphRunner.stop();
  await graphRunner.start();

  const roles: Array<"orchestrator" | "research" | "backtest"> = [
    "orchestrator",
    "research",
    "backtest",
  ];

  for (const role of roles) {
    const workflowId = await createWorkflow(projectId, `acceptance-${role}`);
    const { runId } = await graphRunner.runRoleTask({
      workflowId,
      role,
      payload: {
        taskId: crypto.randomUUID(),
        taskType: "workflow_start",
        assignedRole: role,
        params: { forceLoop: false },
      },
    });
    const status = await waitWorkflowDone(workflowId);
    await assertWorkflowDbRecords(workflowId, false);
    console.log(`[acceptance] role=${role} runId=${runId} status=${status}`);
  }

  const maxIterationWorkflow = await createWorkflow(projectId, "acceptance-max-iterations");
  await upsertPolicy({
    id: "acceptance-iteration-tight",
    allowedTools: ["task_decompose", "assign_task"],
    maxIterationsPerRun: 1,
  });
  await setDefinitionPolicy("def-orchestrator", "acceptance-iteration-tight");
  await graphRunner.stop();
  await graphRunner.start();
  const forced = await graphRunner.runRoleTask({
    workflowId: maxIterationWorkflow,
    role: "orchestrator",
    payload: {
      taskId: crypto.randomUUID(),
      taskType: "workflow_start",
      assignedRole: "orchestrator",
      params: { forceLoop: true },
    },
  });
  const forcedStatus = await waitWorkflowDone(maxIterationWorkflow);
  await assertWorkflowDbRecords(maxIterationWorkflow, true);
  console.log(
    `[acceptance] max-iteration runId=${forced.runId} workflowStatus=${forcedStatus}`
  );

  const blockedWorkflow = await createWorkflow(projectId, "acceptance-sandbox-blocked-tool");
  await upsertPolicy({
    id: "acceptance-tool-block",
    allowedTools: ["assign_task"],
    maxIterationsPerRun: 20,
  });
  await setDefinitionPolicy("def-orchestrator", "acceptance-tool-block");
  await graphRunner.stop();
  await graphRunner.start();
  const blockedRun = await graphRunner.runRoleTask({
    workflowId: blockedWorkflow,
    role: "orchestrator",
    payload: {
      taskId: crypto.randomUUID(),
      taskType: "workflow_start",
      assignedRole: "orchestrator",
      params: { forceLoop: false },
    },
  });
  await waitWorkflowDone(blockedWorkflow);
  await assertSandboxBlocked(blockedWorkflow);
  console.log(`[acceptance] blocked-tool runId=${blockedRun.runId} verified`);
}

void main();

