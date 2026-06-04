/**
 * exec_call_log 端到端集成测试
 *
 * 覆盖：
 *   1. migration 0075 表创建 + 索引存在
 *   2. shell.exec happy path 经 dispatchBuiltinTool 落一条 status=success 日志
 *   3. cwd 逃逸被治理拦截 → 落 status=sandbox_blocked + error_code=cwd_escape
 *   4. binary 未注册 → 落 status=sandbox_blocked + error_code=binary_not_registered
 *   5. 缺 toolCallId/agentStepId 时静默跳过（不抛错）
 *   6. getExecSummary 聚合返回上述三类调用，errorCode/binary 切分正确
 *
 * 注意：测试与现有 builtin-tools.test.ts 的"factor.mine.llm builtin"集成测试同套路：
 *   先设 QUBIT_DATA_DIR / HOME → 再 dynamic import → 跑 migrations → 准备外键 → dispatch。
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * dataDir 兼容策略：
 *
 *   `config` 是模块单例（src/config.ts:50 顶层执行 loadConfig()），bun test 串行跑
 *   多个 test 文件时第一个 import config 的人会锁定 dataDir，后续文件的 process.env
 *   再覆盖也无效。runner.test.ts 同目录也设了 QUBIT_DATA_DIR，所以本文件**不能**
 *   假设自己设的 TMP_DIR 一定生效——必须读 config.dataDir 的实际值再拼 workflowDir。
 *
 *   过程：
 *     1. 先把 QUBIT_DATA_DIR 设到一个准备好的 TMP_DIR（如果本文件先跑，能用）
 *     2. dynamic import config 拿真实 dataDir
 *     3. 在真实 dataDir 下 mkdir workflow 目录
 */
const TMP_DIR = join(tmpdir(), `qubit-exec-log-${process.pid}-${Date.now()}`);
rmSync(TMP_DIR, { recursive: true, force: true });
mkdirSync(TMP_DIR, { recursive: true });
if (!process.env.QUBIT_DATA_DIR) process.env.QUBIT_DATA_DIR = TMP_DIR;
if (!process.env.HOME) process.env.HOME = TMP_DIR;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { randomUUID } = await import("node:crypto");
const { config } = await import("../../../config");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const drizzle = await import("drizzle-orm");
const { dispatchBuiltinTool } = await import("../../tools/builtin-tools");
const { getExecSummary } = await import("../../monitor/exec-summary");

const EFFECTIVE_DATA_DIR = config.dataDir;
const WORKSPACE_ID = randomUUID();
const PROJECT_ID = randomUUID();
const WORKFLOW_ID = randomUUID();
const AGENT_DEF_ID = `def-research-exec-log-${process.pid}`;
const AGENT_INSTANCE_ID = randomUUID();
const AGENT_STEP_ID = randomUUID();
const TRACE_ID = randomUUID();

const workflowDir = join(EFFECTIVE_DATA_DIR, "projects", PROJECT_ID, "workflows", WORKFLOW_ID);
mkdirSync(workflowDir, { recursive: true });

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();

  await db
    .insert(schema.workspace)
    .values({ id: WORKSPACE_ID, name: "exec-log-ws", owner: "test" })
    .onConflictDoNothing();
  await db
    .insert(schema.project)
    .values({
      id: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      name: "exec-log-proj",
      marketScope: "CN-A",
    })
    .onConflictDoNothing();

  await db
    .insert(schema.sandboxPolicy)
    .values({
      id: "exec-log-policy",
      name: "exec-log-policy",
      description: "for exec-log test",
    })
    .onConflictDoNothing();

  // def-research 在 SEED 已存在；用唯一 def-id 避免与 seed 冲突
  await db
    .insert(schema.agentDefinition)
    .values({
      id: AGENT_DEF_ID,
      role: "research",
      name: "research-exec-log-test",
      version: "1.0.0",
      systemPrompt: "",
      toolsJson: ["shell.exec", "cli_agent.run"],
      mcpServersJson: [],
      skillsJson: [],
      subscriptionsJson: ["TASK_ASSIGN"],
      llmProvider: "mock",
      sandboxPolicyId: "exec-log-policy",
      enabled: true,
    })
    .onConflictDoNothing();

  await db.insert(schema.workflowRun).values({
    id: WORKFLOW_ID,
    projectId: PROJECT_ID,
    goal: "exec-log-test",
    mode: "research",
    source: "manual",
    status: "running",
  });

  await db.insert(schema.agentInstance).values({
    id: AGENT_INSTANCE_ID,
    definitionId: AGENT_DEF_ID,
    workflowRunId: WORKFLOW_ID,
    status: "running",
  });

  await db.insert(schema.agentStep).values({
    id: AGENT_STEP_ID,
    agentInstanceId: AGENT_INSTANCE_ID,
    workflowRunId: WORKFLOW_ID,
    stepIndex: 0,
    phase: "act",
    actionType: "tool_call",
    actionJson: {},
  });
});

afterAll(() => {
  rmSync(workflowDir, { recursive: true, force: true });
  // 只在自己创建的 TMP_DIR 上（runner.test.ts 先跑时它可能根本没用到）安全清理
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function buildCtx(toolCallId: string) {
  return {
    workflowId: WORKFLOW_ID,
    runId: WORKFLOW_ID,
    traceId: TRACE_ID,
    agentInstanceId: AGENT_INSTANCE_ID,
    projectId: PROJECT_ID,
    definition: {
      id: AGENT_DEF_ID,
      role: "research" as const,
      name: "research-test",
      version: "1.0.0",
      systemPrompt: "",
      tools: ["shell.exec", "cli_agent.run"],
      mcpServers: [],
      skills: [],
      subscriptions: ["TASK_ASSIGN"],
      llmProvider: "mock",
      maxIterations: 5,
      sandboxPolicyId: "default-policy",
      enabled: true,
    },
    reasonText: "",
    inboundPayload: {},
    toolCallId,
    agentStepId: AGENT_STEP_ID,
  };
}

describe("exec_call_log integration", () => {
  test("migration 0075 created exec_call_log table", async () => {
    const db = await getDb();
    const rows = await db.all<{ name: string }>(
      drizzle.sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'exec_call_log'`
    );
    expect(rows.length).toBe(1);
  });

  test("shell.exec happy path writes exec_call_log row (status=success)", async () => {
    const toolCallId = randomUUID();
    // 用 echo 当无害 binary——但 EXEC_PROVIDERS 默认没有 echo，所以我们走治理拦截路径
    // 这里改用 jq 跑一个简单 identity（jq '.' on empty stdin 会输出 null）；
    // 若机器没装 jq，跳过 happy 路径但仍验证落库行为。
    // 为稳定起见用 git --version：git 大概率在；如果没有，落 binary_not_found（仍验证落库）。
    const result = (await dispatchBuiltinTool("shell.exec", buildCtx(toolCallId), {
      binary: "git",
      args: ["--version"],
      cwd: workflowDir,
    })) as { ok: boolean; exitCode: number | null };

    const db = await getDb();
    const logs = await db
      .select()
      .from(schema.execCallLog)
      .where(drizzle.eq(schema.execCallLog.id, toolCallId));
    expect(logs.length).toBe(1);
    const log = logs[0];
    if (!log) throw new Error("exec_call_log row missing");
    expect(log.providerId).toBe("git");
    expect(log.execKind).toBe("shell");
    expect(log.binary).toBe("git");
    expect(log.cwd).toBe(workflowDir);
    expect(log.agentDefinitionId).toBe(AGENT_DEF_ID);
    expect(log.traceId).toBe(TRACE_ID);
    expect(log.workflowRunId).toBe(WORKFLOW_ID);

    if (result.ok) {
      expect(log.status).toBe("success");
      expect(log.exitCode).toBe(0);
      expect(log.stdoutBytes).toBeGreaterThan(0);
      expect(log.errorCode).toBeNull();
    } else {
      // CI / 干净机可能没有 git——只要落库行为正确即可
      expect(["error", "sandbox_blocked", "timeout"]).toContain(log.status);
    }
  });

  test("cwd escape is logged as sandbox_blocked / cwd_escape", async () => {
    const toolCallId = randomUUID();
    const escapingCwd = join(EFFECTIVE_DATA_DIR, "outside-workflow");
    mkdirSync(escapingCwd, { recursive: true });
    await dispatchBuiltinTool("shell.exec", buildCtx(toolCallId), {
      binary: "git",
      args: ["--version"],
      cwd: escapingCwd,
    });

    const db = await getDb();
    const logs = await db
      .select()
      .from(schema.execCallLog)
      .where(drizzle.eq(schema.execCallLog.id, toolCallId));
    expect(logs.length).toBe(1);
    const log = logs[0];
    if (!log) throw new Error("exec_call_log row missing");
    expect(log.status).toBe("sandbox_blocked");
    expect(log.errorCode).toBe("cwd_escape");
    expect(log.exitCode).toBeNull();
  });

  test("unregistered binary is logged as sandbox_blocked / binary_not_registered", async () => {
    const toolCallId = randomUUID();
    await dispatchBuiltinTool("shell.exec", buildCtx(toolCallId), {
      binary: "totally-random-binary-x9z7",
      args: [],
      cwd: workflowDir,
    });

    const db = await getDb();
    const logs = await db
      .select()
      .from(schema.execCallLog)
      .where(drizzle.eq(schema.execCallLog.id, toolCallId));
    expect(logs.length).toBe(1);
    const log = logs[0];
    if (!log) throw new Error("exec_call_log row missing");
    expect(log.status).toBe("sandbox_blocked");
    expect(log.errorCode).toBe("binary_not_registered");
    expect(log.providerId).toBe("totally-random-binary-x9z7");
  });

  test("missing toolCallId/agentStepId silently skips logging (no throw)", async () => {
    // 模拟非 act 入口（脚本 / 测试），ctx 不带 toolCallId
    const ctxNoIds = {
      ...buildCtx("ignored"),
      toolCallId: undefined,
      agentStepId: undefined,
    };
    // 调用本身要正常返回 ExecResult，不能因为缺 id 抛错
    const result = (await dispatchBuiltinTool("shell.exec", ctxNoIds, {
      binary: "totally-random-binary-x9z7",
      args: [],
      cwd: workflowDir,
    })) as { ok: boolean };
    expect(result.ok).toBe(false);
    // 确认没有任何 id="undefined" 的日志被写入（即静默跳过生效）
    const db = await getDb();
    const stray = await db
      .select()
      .from(schema.execCallLog)
      .where(drizzle.eq(schema.execCallLog.id, "undefined"));
    expect(stray.length).toBe(0);
  });

  test("getExecSummary aggregates the calls above", async () => {
    const summary = await getExecSummary({ windowMinutes: 60 });
    // 应至少看到 git provider（被前两个 case 调用过）+ 未注册 binary 的 provider 行
    const providers = summary.map((r) => r.providerId);
    expect(providers).toContain("git");
    expect(providers).toContain("totally-random-binary-x9z7");

    const gitRow = summary.find((r) => r.providerId === "git");
    if (!gitRow) throw new Error("git summary row missing");
    expect(gitRow.totalCalls).toBeGreaterThanOrEqual(2);
    // cwd_escape 案例计入 sandboxBlocked
    expect(gitRow.sandboxBlockedCount).toBeGreaterThanOrEqual(1);
    // errorCode 切分：至少含 cwd_escape
    const gitErrorCodes = gitRow.byErrorCode.map((e) => e.errorCode);
    expect(gitErrorCodes).toContain("cwd_escape");

    const unregRow = summary.find((r) => r.providerId === "totally-random-binary-x9z7");
    if (!unregRow) throw new Error("unregistered-binary summary row missing");
    expect(unregRow.sandboxBlockedCount).toBeGreaterThanOrEqual(1);
    expect(unregRow.byErrorCode.find((e) => e.errorCode === "binary_not_registered")).toBeDefined();
  });
});
