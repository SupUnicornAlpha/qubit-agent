/**
 * P7 detectors 单测。
 *
 * 复用真实 SQLite + fixture：1 workspace + 1 project + 1 agent_definition / instance / step / workflow_run
 * 然后 seed 不同形状的 tool_call_log / experience。
 *
 * 覆盖：
 *   - signature 归一化：tool: / mcp: / concept:
 *   - unknown_tool：errorMessage 命中 → signal；非命中 → 跳
 *   - repeated_fail：同 toolName ≥ 3 次 error → 一条 signal；< 3 次 → 不出
 *   - reflective_mention：中英 mention 都能命中；空正文跳；停用词不选
 *   - 不同 project 隔离
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import {
  agentDefinition,
  agentInstance,
  agentStep,
  experience as experienceTable,
  project,
  sandboxPolicy,
  toolCallLog,
  workflowRun,
  workspace,
} from "../../../db/sqlite/schema";
import {
  detectReflectiveMention,
  detectRepeatedFail,
  detectUnknownTool,
} from "../detectors";
import {
  makeConceptSignature,
  makeMcpSignature,
  makeToolSignature,
} from "../signature";

interface Fixture {
  workspaceId: string;
  projectId: string;
  otherProjectId: string;
  sandboxPolicyId: string;
  definitionId: string;
  instanceId: string;
  workflowRunId: string;
  agentStepId: string;
}

let fx: Fixture;

beforeAll(async () => {
  process.env.QUBIT_DATA_DIR = join("/tmp", `qubit-p7-detect-${Date.now()}`);
  await runMigrations();
  const db = await getDb();

  const f: Fixture = {
    workspaceId: `ws_${randomUUID()}`,
    projectId: `prj_${randomUUID()}`,
    otherProjectId: `prj_${randomUUID()}`,
    sandboxPolicyId: `pol_${randomUUID()}`,
    definitionId: `def_${randomUUID()}`,
    instanceId: `inst_${randomUUID()}`,
    workflowRunId: `wf_${randomUUID()}`,
    agentStepId: `step_${randomUUID()}`,
  };
  await db.insert(workspace).values({ id: f.workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values([
      { id: f.projectId, workspaceId: f.workspaceId, name: "p", marketScope: "US" },
      { id: f.otherProjectId, workspaceId: f.workspaceId, name: "p2", marketScope: "US" },
    ])
    .run();
  await db
    .insert(sandboxPolicy)
    .values({ id: f.sandboxPolicyId, name: "permissive-test" })
    .run();
  await db
    .insert(agentDefinition)
    .values({
      id: f.definitionId,
      role: "research",
      name: "test-agent",
      systemPrompt: "test",
      llmProvider: "mock",
      sandboxPolicyId: f.sandboxPolicyId,
    })
    .run();
  await db
    .insert(workflowRun)
    .values({
      id: f.workflowRunId,
      projectId: f.projectId,
      goal: "test",
      mode: "research",
    })
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
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(toolCallLog).where(eq(toolCallLog.agentStepId, fx.agentStepId));
  await db.delete(experienceTable).where(eq(experienceTable.scopeId, fx.projectId));
  await db.delete(experienceTable).where(eq(experienceTable.scopeId, fx.otherProjectId));
});

afterEach(async () => {
  const db = await getDb();
  await db.delete(toolCallLog).where(eq(toolCallLog.agentStepId, fx.agentStepId));
});

function nowIso(deltaMs = 0): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

async function seedToolCall(
  toolName: string,
  toolKind: "builtin" | "mcp" | "acp_connector" | "skill",
  status: "success" | "error" | "timeout" | "sandbox_blocked",
  errorMessage: string | null,
  opts?: { mcp?: { serverName: string; toolName: string }; responseJson?: unknown }
): Promise<string> {
  const db = await getDb();
  const id = `tcl_${randomUUID()}`;
  await db
    .insert(toolCallLog)
    .values({
      id,
      agentStepId: fx.agentStepId,
      workflowRunId: fx.workflowRunId,
      traceId: id,
      retryCount: 0,
      toolName,
      toolKind,
      requestJson: { reasonText: "test", targetKind: toolKind === "mcp" ? "mcp" : "tool", mcp: opts?.mcp ?? null },
      responseJson: opts?.responseJson ?? null,
      status,
      latencyMs: 10,
      errorMessage,
    })
    .run();
  return id;
}

async function seedReflective(body: string): Promise<string> {
  const { getExperienceStore } = await import("../../experience/experience-store");
  const store = getExperienceStore();
  const r = await store.insert({
    kind: "reflective",
    subKind: "post_workflow_reflection",
    scope: "project",
    scopeId: fx.projectId,
    visibility: "project_shared",
    contentJson: { summary: body.slice(0, 80), body },
    tagsJson: [],
    validFrom: new Date().toISOString(),
    qualityScore: 0.5,
  });
  return r.id;
}

describe("signature 归一化", () => {
  test("tool: 命名空间", () => {
    expect(makeToolSignature("get_weather")).toBe("tool:get_weather");
    expect(makeToolSignature("  get weather  ")).toBe("tool:get_weather");
  });

  test("mcp: 命名空间", () => {
    expect(makeMcpSignature("slack", "post_message")).toBe("mcp:slack/post_message");
  });

  test("concept: 命名空间小写化", () => {
    expect(makeConceptSignature("RealtimeOptions")).toBe("concept:realtimeoptions");
  });
});

describe("detectUnknownTool", () => {
  const window = { fromTs: nowIso(-3600_000), toTs: nowIso(60_000) };

  test("errorMessage='unknown tool' → 一条 signal", async () => {
    await seedToolCall("get_weather", "builtin", "error", "unknown tool: get_weather");
    const r = await detectUnknownTool({ projectId: fx.projectId, ...window });
    expect(r.signals.length).toBe(1);
    const s = r.signals[0]!;
    expect(s.signature).toBe("tool:get_weather");
    expect(s.requestedToolName).toBe("get_weather");
    expect(s.kind).toBe("unknown_tool");
    expect(s.definitionId).toBe(fx.definitionId);
    expect(s.workflowRunId).toBe(fx.workflowRunId);
  });

  test("中文'找不到xx工具' → 命中", async () => {
    await seedToolCall("xx_tool", "builtin", "error", "找不到 xx_tool 工具");
    const r = await detectUnknownTool({ projectId: fx.projectId, ...window });
    expect(r.signals.length).toBe(1);
    expect(r.signals[0]!.signature).toBe("tool:xx_tool");
  });

  test("status=success → 不出 signal", async () => {
    await seedToolCall("ok_tool", "builtin", "success", null);
    const r = await detectUnknownTool({ projectId: fx.projectId, ...window });
    expect(r.signals.length).toBe(0);
  });

  test("errorMessage 与模式无关 → 不出 signal", async () => {
    await seedToolCall("ok_tool", "builtin", "error", "validation: x must be > 0");
    const r = await detectUnknownTool({ projectId: fx.projectId, ...window });
    expect(r.signals.length).toBe(0);
  });

  test("MCP path → mcp: 签名", async () => {
    await seedToolCall("post_message", "mcp", "error", "unknown tool: post_message", {
      mcp: { serverName: "slack", toolName: "post_message" },
    });
    const r = await detectUnknownTool({ projectId: fx.projectId, ...window });
    expect(r.signals.length).toBe(1);
    expect(r.signals[0]!.signature).toBe("mcp:slack/post_message");
  });

  test("project 隔离：不属于本 project 的 tool_call 不出 signal", async () => {
    await seedToolCall("foo", "builtin", "error", "unknown tool: foo");
    const r = await detectUnknownTool({ projectId: fx.otherProjectId, ...window });
    expect(r.signals.length).toBe(0);
  });
});

describe("detectRepeatedFail", () => {
  const window = { fromTs: nowIso(-3600_000), toTs: nowIso(60_000) };

  test("3 次 error → 一条 repeated_fail signal", async () => {
    for (let i = 0; i < 3; i++) {
      await seedToolCall("flaky", "builtin", "error", "boom " + i);
    }
    const r = await detectRepeatedFail({ projectId: fx.projectId, ...window });
    expect(r.signals.length).toBe(1);
    const s = r.signals[0]!;
    expect(s.signature).toBe("tool:flaky");
    expect((s.metadata as { failCount: number }).failCount).toBe(3);
  });

  test("2 次 error → 不达阈值，不出", async () => {
    for (let i = 0; i < 2; i++) {
      await seedToolCall("flaky2", "builtin", "error", "boom");
    }
    const r = await detectRepeatedFail({ projectId: fx.projectId, ...window });
    expect(r.signals.length).toBe(0);
  });

  test("自定义阈值=2 → 2 次也算 hot", async () => {
    for (let i = 0; i < 2; i++) {
      await seedToolCall("flaky3", "builtin", "error", "x");
    }
    const r = await detectRepeatedFail({
      projectId: fx.projectId,
      ...window,
      repeatedFailThreshold: 2,
    });
    expect(r.signals.length).toBe(1);
    expect(r.signals[0]!.signature).toBe("tool:flaky3");
  });
});

describe("detectReflectiveMention", () => {
  const window = { fromTs: nowIso(-3600_000), toTs: nowIso(60_000) };

  test("中文'需要……工具' → 命中", async () => {
    await seedReflective("本轮反思：需要一个实时期权链工具，否则无法做对冲。");
    const r = await detectReflectiveMention({ projectId: fx.projectId, ...window });
    expect(r.signals.length).toBeGreaterThanOrEqual(1);
    expect(r.signals[0]!.kind).toBe("reflective_mention");
    expect(r.signals[0]!.signature.startsWith("concept:")).toBe(true);
  });

  test("英文 'need a tool to X' → 命中", async () => {
    await seedReflective("Reflection: we need a tool to fetch realtime options chains.");
    const r = await detectReflectiveMention({ projectId: fx.projectId, ...window });
    expect(r.signals.length).toBeGreaterThanOrEqual(1);
  });

  test("空 body → 不出", async () => {
    await seedReflective("");
    const r = await detectReflectiveMention({ projectId: fx.projectId, ...window });
    expect(r.signals.length).toBe(0);
  });

  test("正文不含 'tool/工具' → 不命中", async () => {
    await seedReflective("Reflection: we did good today. nothing to add.");
    const r = await detectReflectiveMention({ projectId: fx.projectId, ...window });
    expect(r.signals.length).toBe(0);
  });
});
