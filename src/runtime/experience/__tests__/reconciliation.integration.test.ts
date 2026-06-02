/**
 * Memory V2 双写对账集成测试 — Memory V2 P1.5
 *
 * 验证对账工具对真实 SQLite 数据库的诊断行为：
 *   - D1: semantic vs midterm_memory 双方齐全 → both++
 *   - D1: 仅旧表有 → onlyOldWorkflowIds
 *   - D1: 仅新表有 → onlyNewWorkflowIds
 *   - D2: signature 抽取正确（同 signature 匹配上）
 *   - D2: 旧 skill 已 archived → 不计入对账（避免历史包袱误报）
 *   - D3: reflective 统计 bySubKind / recent7d
 *   - recommendation: drift=0 → ok_to_sunset
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUBIT_DATA_DIR = mkdtempSync(join(tmpdir(), "memory-reconcile-it-"));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import * as schema from "../../../db/sqlite/schema";
import { SqliteExperienceStore, setExperienceStoreForTesting } from "../experience-store";
import { extractSkillSignature, reconcileProject } from "../reconciliation";

const NOW_STR = "2026-06-02T00:00:00.000Z";
const NOW = new Date(NOW_STR);
let workspaceId: string;
let projectId: string;
let definitionId: string;

beforeAll(async () => {
  await runMigrations();
  setExperienceStoreForTesting(new SqliteExperienceStore());
  const db = await getDb();
  workspaceId = randomUUID();
  projectId = randomUUID();
  const sandboxId = randomUUID();
  definitionId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: "rec_ws",
    owner: "test",
    createdAt: NOW_STR,
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "rec_proj",
    marketScope: "CN-A",
    createdAt: NOW_STR,
  });
  await db.insert(schema.sandboxPolicy).values({
    id: sandboxId,
    name: "rec-sb",
  });
  await db.insert(schema.agentDefinition).values({
    id: definitionId,
    role: "research",
    name: "rec-research",
    systemPrompt: "stub",
    llmProvider: "mock:any",
    sandboxPolicyId: sandboxId,
  });
});

beforeEach(async () => {
  const db = await getDb();
  // 清表，让每个用例独立。先删 reflection_run（被 experience 引用风险低，但保守起见）
  await db.delete(schema.experienceOpLog);
  await db.delete(schema.experienceLink);
  await db.delete(schema.experience).where(eq(schema.experience.scopeId, projectId));
  await db.delete(schema.midtermMemory).where(eq(schema.midtermMemory.projectId, projectId));
  await db.delete(schema.agentSkill).where(eq(schema.agentSkill.projectId, projectId));
  await db.delete(schema.workflowRun).where(eq(schema.workflowRun.projectId, projectId));
});

async function insertWorkflow(id: string, startedAt: string): Promise<void> {
  const db = await getDb();
  await db.insert(schema.workflowRun).values({
    id,
    projectId,
    goal: "g",
    mode: "research",
    source: "manual",
    status: "completed",
    loopKind: "native",
    executionPath: "graph",
    loopOptionsJson: {},
    startedAt,
    endedAt: startedAt,
  });
}

describe("Reconciliation — D1 semantic vs midterm", () => {
  test("双方都存在 → both++", async () => {
    await insertWorkflow("wf-1", NOW_STR);
    const db = await getDb();
    await db.insert(schema.midtermMemory).values({
      id: randomUUID(),
      projectId,
      memoryType: "strategy_iteration",
      contentJson: { content: "x", workflowRunId: "wf-1" },
      timeWindowStart: NOW_STR,
      timeWindowEnd: NOW_STR,
      asofTime: NOW_STR,
      updatedAt: NOW_STR,
    });
    const store = new SqliteExperienceStore();
    await store.insert({
      kind: "semantic",
      subKind: "iteration_summary",
      scope: "project",
      scopeId: projectId,
      contentJson: { summary: "x" },
      validFrom: NOW_STR,
      sourceRunId: "wf-1",
    });

    const rep = await reconcileProject({ projectId, now: NOW });
    expect(rep.semantic.bothCount).toBe(1);
    expect(rep.semantic.onlyOldWorkflowIds.length).toBe(0);
    expect(rep.semantic.onlyNewWorkflowIds.length).toBe(0);
    expect(rep.recommendation).toBe("ok_to_sunset");
  });

  test("仅旧表 → onlyOld 命中", async () => {
    await insertWorkflow("wf-2", NOW_STR);
    const db = await getDb();
    await db.insert(schema.midtermMemory).values({
      id: randomUUID(),
      projectId,
      memoryType: "strategy_iteration",
      contentJson: { content: "x", workflowRunId: "wf-2" },
      timeWindowStart: NOW_STR,
      timeWindowEnd: NOW_STR,
      asofTime: NOW_STR,
      updatedAt: NOW_STR,
    });
    const rep = await reconcileProject({ projectId, now: NOW });
    expect(rep.semantic.onlyOldWorkflowIds).toContain("wf-2");
    expect(rep.recommendation).toBe("needs_attention");
  });

  test("仅新表 → onlyNew 命中", async () => {
    await insertWorkflow("wf-3", NOW_STR);
    const store = new SqliteExperienceStore();
    await store.insert({
      kind: "semantic",
      subKind: "iteration_summary",
      scope: "project",
      scopeId: projectId,
      contentJson: { summary: "x" },
      validFrom: NOW_STR,
      sourceRunId: "wf-3",
    });
    const rep = await reconcileProject({ projectId, now: NOW });
    expect(rep.semantic.onlyNewWorkflowIds).toContain("wf-3");
  });
});

describe("Reconciliation — D2 procedural vs agent_skill", () => {
  test("signature 匹配 → both++", async () => {
    const db = await getDb();
    await db.insert(schema.agentSkill).values({
      id: randomUUID(),
      projectId,
      name: "skill-a",
      description: "d",
      bodyMd: "## body\n\n<!-- signature: fooBarBaz -->",
      state: "active",
      version: "v1",
      source: "agent_created",
    });
    const store = new SqliteExperienceStore();
    await store.insert({
      kind: "procedural",
      subKind: "workflow_play",
      scope: "project",
      scopeId: projectId,
      contentJson: { summary: "play" },
      metadataJson: { signature: "fooBarBaz" },
      validFrom: NOW_STR,
    });
    const rep = await reconcileProject({ projectId, now: NOW });
    expect(rep.procedural.bothCount).toBe(1);
  });

  test("archived skill 不计 → onlyNew 不会被 archived 干扰", async () => {
    const db = await getDb();
    await db.insert(schema.agentSkill).values({
      id: randomUUID(),
      projectId,
      name: "skill-b",
      description: "d",
      bodyMd: "<!-- signature: histSig -->",
      state: "archived",
      version: "v1",
      source: "agent_created",
    });
    const store = new SqliteExperienceStore();
    await store.insert({
      kind: "procedural",
      subKind: "workflow_play",
      scope: "project",
      scopeId: projectId,
      contentJson: { summary: "play" },
      metadataJson: { signature: "newSig" },
      validFrom: NOW_STR,
    });
    const rep = await reconcileProject({ projectId, now: NOW });
    // 期望：新表的 newSig 是 onlyNew；archived 的 histSig 完全不出现在统计里
    expect(rep.procedural.onlyNewSignatures).toContain("newSig");
    expect(rep.procedural.onlyOldSignatures).not.toContain("histSig");
    expect(rep.procedural.bothCount).toBe(0);
  });
});

describe("Reconciliation — D3 reflective stats", () => {
  test("统计 total / bySubKind / recent7d", async () => {
    const store = new SqliteExperienceStore();
    await store.insert({
      kind: "reflective",
      subKind: "failure_mode",
      scope: "project",
      scopeId: projectId,
      definitionId,
      visibility: "agent_private",
      contentJson: { summary: "r1" },
      validFrom: NOW_STR,
    });
    await store.insert({
      kind: "reflective",
      subKind: "preference",
      scope: "project",
      scopeId: projectId,
      definitionId,
      visibility: "agent_private",
      contentJson: { summary: "r2" },
      validFrom: NOW_STR,
    });
    const rep = await reconcileProject({ projectId, now: NOW });
    expect(rep.reflective.total).toBe(2);
    expect(rep.reflective.bySubKind.failure_mode).toBe(1);
    expect(rep.reflective.bySubKind.preference).toBe(1);
    expect(rep.reflective.recent7d).toBe(2);
  });
});

describe("Reconciliation — extractSkillSignature", () => {
  test("命中标准注释格式", () => {
    expect(extractSkillSignature("body\n\n<!-- signature: abc123 -->\n")).toBe("abc123");
  });
  test("无注释 → null", () => {
    expect(extractSkillSignature("no marker here")).toBeNull();
  });
  test("空输入 → null", () => {
    expect(extractSkillSignature(null)).toBeNull();
  });
});
