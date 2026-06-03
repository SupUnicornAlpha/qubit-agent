/**
 * P7 ToolGapWatcher 集成测。
 *
 * Fixture：与 detectors.test.ts 一致（workspace/project/agent_definition/instance/step/workflow_run）。
 *
 * 覆盖：
 *   1) 跑一次：3 路 detector 都有数据 → 折叠按 signature 后 INSERT 新行
 *   2) 重跑：同 signature 已 open → occurrence_count += 1（不 INSERT 新行）
 *   3) 同 signature 已 wont_fix → skipped；不会被 worker 误重开
 *   4) 多 signal 同 signature → 优先级高的 detection_kind 作为代表
 *   5) extraSignals（来自 builtin / API） + detector 输出一起 ingest
 *   6) tool_gap_run 写一行 status='completed'，actionsJson 含明细
 *   7) emit maintenance_run/tool_gap_watcher event
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
  experience as experienceTable,
  project,
  sandboxPolicy,
  toolCallLog,
  toolGapLog,
  toolGapRun,
  workflowRun,
  workspace,
} from "../../../db/sqlite/schema";
import type { ExperienceBus } from "../../experience/experience-bus";
import { reportExplicitGap, ToolGapWatcher } from "../watcher";

interface Fixture {
  workspaceId: string;
  projectId: string;
  sandboxPolicyId: string;
  definitionId: string;
  instanceId: string;
  workflowRunId: string;
  agentStepId: string;
}

let fx: Fixture;

beforeAll(async () => {
  process.env.QUBIT_DATA_DIR = join("/tmp", `qubit-p7-watcher-${Date.now()}`);
  closeDb();
  await runMigrations();
  const db = await getDb();
  const f: Fixture = {
    workspaceId: `ws_${randomUUID()}`,
    projectId: `prj_${randomUUID()}`,
    sandboxPolicyId: `pol_${randomUUID()}`,
    definitionId: `def_${randomUUID()}`,
    instanceId: `inst_${randomUUID()}`,
    workflowRunId: `wf_${randomUUID()}`,
    agentStepId: `step_${randomUUID()}`,
  };
  await db.insert(workspace).values({ id: f.workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: f.projectId, workspaceId: f.workspaceId, name: "p", marketScope: "US" })
    .run();
  await db
    .insert(sandboxPolicy)
    .values({ id: f.sandboxPolicyId, name: "permissive" })
    .run();
  await db
    .insert(agentDefinition)
    .values({
      id: f.definitionId,
      role: "research",
      name: "agent",
      systemPrompt: "x",
      llmProvider: "mock",
      sandboxPolicyId: f.sandboxPolicyId,
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
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(toolCallLog).where(eq(toolCallLog.agentStepId, fx.agentStepId));
  await db.delete(experienceTable).where(eq(experienceTable.scopeId, fx.projectId));
  await db.delete(toolGapLog).where(eq(toolGapLog.projectId, fx.projectId));
  await db.delete(toolGapRun).where(eq(toolGapRun.projectId, fx.projectId));
});

async function seedToolCall(
  toolName: string,
  errorMessage: string,
  kind: "builtin" | "mcp" = "builtin"
): Promise<void> {
  const db = await getDb();
  await db
    .insert(toolCallLog)
    .values({
      id: `tcl_${randomUUID()}`,
      agentStepId: fx.agentStepId,
      workflowRunId: fx.workflowRunId,
      traceId: randomUUID(),
      retryCount: 0,
      toolName,
      toolKind: kind,
      requestJson: { reasonText: "t" },
      responseJson: null,
      status: "error",
      latencyMs: 10,
      errorMessage,
    })
    .run();
}

async function seedReflective(body: string): Promise<void> {
  const { getExperienceStore } = await import("../../experience/experience-store");
  const store = getExperienceStore();
  await store.insert({
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
}

describe("ToolGapWatcher.runOnce", () => {
  test("1) 3 路 detector 都命中 → 各自折叠后 INSERT 不同 signature", async () => {
    await seedToolCall("get_weather", "unknown tool: get_weather");
    for (let i = 0; i < 3; i++) await seedToolCall("flaky", "boom " + i);
    await seedReflective("反思：需要一个实时期权链工具，否则无法做对冲。");

    const watcher = new ToolGapWatcher();
    const r = await watcher.runOnce({ projectId: fx.projectId, emitMetrics: false });
    expect(r.status).toBe("completed");
    expect(r.unknownToolCount).toBe(1);
    expect(r.repeatedFailCount).toBe(1);
    expect(r.reflectiveMentionCount).toBeGreaterThanOrEqual(1);

    const db = await getDb();
    const rows = await db.select().from(toolGapLog).where(eq(toolGapLog.projectId, fx.projectId));
    const sigSet = new Set(rows.map((r) => r.gapSignature));
    expect(sigSet.has("tool:get_weather")).toBe(true);
    expect(sigSet.has("tool:flaky")).toBe(true);
    expect([...sigSet].some((s) => s.startsWith("concept:"))).toBe(true);
    expect(r.gapsCreated).toBe(rows.length);
  });

  test("2) 重跑：同 signature → occurrence_count 累加，不 INSERT 新行", async () => {
    await seedToolCall("get_weather", "unknown tool: get_weather");
    const watcher = new ToolGapWatcher();
    await watcher.runOnce({ projectId: fx.projectId, emitMetrics: false });
    await watcher.runOnce({ projectId: fx.projectId, emitMetrics: false });

    const db = await getDb();
    const rows = await db
      .select()
      .from(toolGapLog)
      .where(
        and(eq(toolGapLog.projectId, fx.projectId), eq(toolGapLog.gapSignature, "tool:get_weather"))
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.occurrenceCount).toBeGreaterThanOrEqual(2);
  });

  test("3) 同 signature 已 wont_fix → 不被 watcher 重开", async () => {
    await seedToolCall("get_weather", "unknown tool: get_weather");
    const watcher = new ToolGapWatcher();
    const r1 = await watcher.runOnce({ projectId: fx.projectId, emitMetrics: false });
    const gapId = r1.actions[0]!.gapId!;
    const db = await getDb();
    await db
      .update(toolGapLog)
      .set({ status: "wont_fix", statusAt: new Date().toISOString(), statusBy: "user" })
      .where(eq(toolGapLog.id, gapId));

    // 同样的错误再来 —— 不应该新开一行
    await seedToolCall("get_weather", "unknown tool: get_weather");
    const r2 = await watcher.runOnce({ projectId: fx.projectId, emitMetrics: false });

    const rows = await db
      .select()
      .from(toolGapLog)
      .where(
        and(eq(toolGapLog.projectId, fx.projectId), eq(toolGapLog.gapSignature, "tool:get_weather"))
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("wont_fix");
    expect(r2.gapsSkipped).toBeGreaterThanOrEqual(1);
  });

  test("4) 同 signature 多 signal → 用优先级最高 detection_kind 作代表", async () => {
    // signature='tool:flaky' 被 unknown_tool（高） + repeated_fail（低）同时命中
    for (let i = 0; i < 3; i++) {
      await seedToolCall("flaky", "unknown tool: flaky " + i);
    }
    const watcher = new ToolGapWatcher();
    await watcher.runOnce({ projectId: fx.projectId, emitMetrics: false });
    const db = await getDb();
    const row = (
      await db
        .select()
        .from(toolGapLog)
        .where(
          and(eq(toolGapLog.projectId, fx.projectId), eq(toolGapLog.gapSignature, "tool:flaky"))
        )
    )[0]!;
    expect(row.detectionKind).toBe("unknown_tool");
  });

  test("5) extraSignals（builtin/API 入口） + detector 一起处理", async () => {
    const watcher = new ToolGapWatcher();
    const r = await watcher.runOnce({
      projectId: fx.projectId,
      emitMetrics: false,
      extraSignals: [
        {
          kind: "explicit_report",
          signature: "concept:hourly_options_iv",
          projectId: fx.projectId,
          occurredAt: new Date().toISOString(),
          excerpt: "user wants hourly IV",
        },
      ],
    });
    expect(r.gapsCreated).toBeGreaterThanOrEqual(1);
    const db = await getDb();
    const row = (
      await db
        .select()
        .from(toolGapLog)
        .where(
          and(
            eq(toolGapLog.projectId, fx.projectId),
            eq(toolGapLog.gapSignature, "concept:hourly_options_iv")
          )
        )
    )[0]!;
    expect(row.detectionKind).toBe("explicit_report");
    expect(row.excerpt).toContain("hourly IV");
  });

  test("6) tool_gap_run 写完整 summary + actions json", async () => {
    await seedToolCall("get_weather", "unknown tool: get_weather");
    const watcher = new ToolGapWatcher();
    const r = await watcher.runOnce({ projectId: fx.projectId, emitMetrics: false });
    const db = await getDb();
    const run = (await db.select().from(toolGapRun).where(eq(toolGapRun.id, r.runId)))[0]!;
    expect(run.status).toBe("completed");
    expect(run.gapsCreated).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(run.actionsJson)).toBe(true);
    expect((run.actionsJson as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  test("7) emitMetrics=true → 触发 maintenance_run/tool_gap_watcher event", async () => {
    await seedToolCall("get_weather", "unknown tool: get_weather");
    const captured: Array<{ kind: string; summary: Record<string, unknown> }> = [];
    const handlers = new Set<(ev: { kind: string; summary: Record<string, number | string> }) => void>();
    const bus: ExperienceBus = {
      emit: (ev) => {
        if (ev.type === "maintenance_run") for (const h of handlers) h(ev);
      },
      subscribe: (_t, handler) => {
        const h = handler as unknown as (ev: { kind: string; summary: Record<string, number | string> }) => void;
        handlers.add(h);
        return () => handlers.delete(h);
      },
      handlerCount: () => handlers.size,
      clearAllForTesting: () => handlers.clear(),
      awaitIdle: async () => undefined,
    };
    bus.subscribe("maintenance_run", (ev) => {
      captured.push({ kind: ev.kind, summary: ev.summary });
    });
    const watcher = new ToolGapWatcher({ bus });
    await watcher.runOnce({ projectId: fx.projectId, emitMetrics: true });
    const evs = captured.filter((e) => e.kind === "tool_gap_watcher");
    expect(evs.length).toBe(1);
  });

  test("8) reportExplicitGap helper：同 signature 已 open → incremented", async () => {
    // 先 explicit 写一条
    const a = await reportExplicitGap({
      projectId: fx.projectId,
      signature: "concept:earnings_calendar",
      excerpt: "需要财报日历",
    });
    expect(a.action).toBe("created");

    // 再 explicit 写一条相同 signature
    const b = await reportExplicitGap({
      projectId: fx.projectId,
      signature: "concept:earnings_calendar",
      excerpt: "again",
    });
    expect(b.action).toBe("incremented");

    const db = await getDb();
    const row = (
      await db
        .select()
        .from(toolGapLog)
        .where(
          and(
            eq(toolGapLog.projectId, fx.projectId),
            eq(toolGapLog.gapSignature, "concept:earnings_calendar")
          )
        )
    )[0]!;
    expect(row.occurrenceCount).toBe(2);
  });
});
