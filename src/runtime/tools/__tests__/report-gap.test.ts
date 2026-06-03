/**
 * P7 builtin `tool.report_gap` 单测。
 *
 * 验证：
 *   - 提供 toolName → tool:<name> 签名落库
 *   - 提供 serverName + toolName → mcp:<srv>/<tool> 签名
 *   - 只提供 reason → concept:<keyword> 签名
 *   - 不提供任何识别信息 → 抛错
 *   - workflowId 能解析出 projectId
 *   - 同 signature 第二次调 → action='incremented'
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import {
  agentDefinition,
  agentInstance,
  agentStep,
  project,
  sandboxPolicy,
  toolGapLog,
  workflowRun,
  workspace,
} from "../../../db/sqlite/schema";
import { dispatchBuiltinTool } from "../builtin-tools";
import type { BuiltinToolContext } from "../types";

interface Fixture {
  projectId: string;
  definitionId: string;
  instanceId: string;
  workflowRunId: string;
  agentStepId: string;
}

let fx: Fixture;
let ctx: BuiltinToolContext;

beforeAll(async () => {
  process.env.QUBIT_DATA_DIR = join("/tmp", `qubit-p7-rg-${Date.now()}`);
  closeDb();
  await runMigrations();
  const db = await getDb();
  const wsId = `ws_${randomUUID()}`;
  const polId = `pol_${randomUUID()}`;
  const f: Fixture = {
    projectId: `prj_${randomUUID()}`,
    definitionId: `def_${randomUUID()}`,
    instanceId: `inst_${randomUUID()}`,
    workflowRunId: `wf_${randomUUID()}`,
    agentStepId: `step_${randomUUID()}`,
  };
  await db.insert(workspace).values({ id: wsId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: f.projectId, workspaceId: wsId, name: "p", marketScope: "US" })
    .run();
  await db.insert(sandboxPolicy).values({ id: polId, name: "permissive" }).run();
  await db
    .insert(agentDefinition)
    .values({
      id: f.definitionId,
      role: "research",
      name: "a",
      systemPrompt: "x",
      llmProvider: "mock",
      sandboxPolicyId: polId,
    })
    .run();
  await db
    .insert(workflowRun)
    .values({ id: f.workflowRunId, projectId: f.projectId, goal: "g", mode: "research" })
    .run();
  await db
    .insert(agentInstance)
    .values({ id: f.instanceId, definitionId: f.definitionId, workflowRunId: f.workflowRunId })
    .run();
  await db
    .insert(agentStep)
    .values({
      id: f.agentStepId,
      agentInstanceId: f.instanceId,
      workflowRunId: f.workflowRunId,
      stepIndex: 0,
      phase: "act",
      actionType: "tool_call",
      actionJson: {},
    })
    .run();
  fx = f;
  ctx = {
    workflowId: f.workflowRunId,
    runId: f.workflowRunId,
    traceId: randomUUID(),
    agentInstanceId: f.instanceId,
    // 故意不传 projectId，验证从 workflowRun 兜底解析
    definition: {
      id: f.definitionId,
      role: "research",
      name: "a",
      version: "1.0.0",
      systemPrompt: "",
      tools: [],
      mcpServers: [],
      skills: [],
      subscriptions: [],
      llmProvider: "mock",
      maxIterations: 20,
      sandboxPolicyId: polId,
      signalWeight: 1.0,
      enabled: true,
    } as unknown as BuiltinToolContext["definition"],
  };
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(toolGapLog).where(eq(toolGapLog.projectId, fx.projectId));
});

async function call(params: Record<string, unknown>): Promise<{
  ok: boolean;
  action: "created" | "incremented" | "skipped";
  signature: string;
  gapId?: string;
}> {
  return (await dispatchBuiltinTool("tool.report_gap", ctx, params)) as {
    ok: boolean;
    action: "created" | "incremented" | "skipped";
    signature: string;
    gapId?: string;
  };
}

describe("builtin tool.report_gap", () => {
  test("提供 toolName → tool:<name> 签名落库", async () => {
    const r = await call({ toolName: "get_realtime_options_chain" });
    expect(r.ok).toBe(true);
    expect(r.signature).toBe("tool:get_realtime_options_chain");
    expect(r.action).toBe("created");

    const db = await getDb();
    const rows = await db
      .select()
      .from(toolGapLog)
      .where(
        and(
          eq(toolGapLog.projectId, fx.projectId),
          eq(toolGapLog.gapSignature, "tool:get_realtime_options_chain")
        )
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.detectionKind).toBe("explicit_report");
    expect(rows[0]!.definitionId).toBe(fx.definitionId);
    expect(rows[0]!.workflowRunId).toBe(fx.workflowRunId);
  });

  test("serverName + toolName → mcp:<srv>/<tool> 签名", async () => {
    const r = await call({ serverName: "slack", toolName: "post_message" });
    expect(r.signature).toBe("mcp:slack/post_message");
    expect(r.action).toBe("created");
  });

  test("只提供 reason → concept:<keyword>", async () => {
    const r = await call({ reason: "需要实时期权链 IV 计算工具" });
    expect(r.signature.startsWith("concept:")).toBe(true);
    expect(r.action).toBe("created");
  });

  test("不提供 toolName / reason → 抛错", async () => {
    await expect(call({})).rejects.toThrow(/必须提供 toolName 或 reason/);
  });

  test("同 signature 第二次调 → action='incremented'", async () => {
    const a = await call({ toolName: "x_tool", reason: "demo" });
    expect(a.action).toBe("created");
    const b = await call({ toolName: "x_tool", reason: "demo again" });
    expect(b.action).toBe("incremented");
    expect(b.signature).toBe(a.signature);

    const db = await getDb();
    const row = (
      await db
        .select()
        .from(toolGapLog)
        .where(
          and(eq(toolGapLog.projectId, fx.projectId), eq(toolGapLog.gapSignature, "tool:x_tool"))
        )
    )[0]!;
    expect(row.occurrenceCount).toBe(2);
  });
});
