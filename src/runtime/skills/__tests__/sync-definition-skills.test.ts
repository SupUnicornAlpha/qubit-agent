import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { runMigrations } from "../../../db/sqlite/migrate";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { skillService } from "../skill-service";
import { getFsiContentRoot } from "../../fsi/fsi-config";
import {
  syncDefinitionSkillsForProject,
  _deleteSyncedSkillsForProject,
} from "../sync-definition-skills";

const NOW = "2026-06-05T00:00:00.000Z";
const SANDBOX_ID = "sb-sync-skills-test";

let projectId: string;

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  const workspaceId = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: "sync_skills_ws",
    owner: "test",
    createdAt: NOW,
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "sync_skills_proj",
    marketScope: "CN-A",
    createdAt: NOW,
  });
  await db
    .insert(schema.sandboxPolicy)
    .values({ id: SANDBOX_ID, name: "sync-skills-sb", description: "" })
    .onConflictDoNothing();
  await db.insert(schema.agentDefinition).values({
    id: randomUUID(),
    role: "analyst_fundamental",
    name: "sync-skills-def",
    systemPrompt: "test",
    skillsJson: ["fsi/comps-analysis"],
    llmProvider: "mock",
    sandboxPolicyId: SANDBOX_ID,
    enabled: true,
  });
});

describe("syncDefinitionSkillsForProject", () => {
  test("把内置 definition 的 fsi/* 镜像到 agent_skill，searchWithMeta 可召回", async () => {
    if (!getFsiContentRoot()) return;
    await _deleteSyncedSkillsForProject(projectId);
    const n = await syncDefinitionSkillsForProject(projectId);
    expect(n).toBeGreaterThan(0);

    const hits = await skillService.searchWithMeta({
      projectId,
      query: "comparable company valuation comps",
      topK: 3,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.skill.name).toContain("comps");
  });

  /**
   * Wave-1（2026-06-10）：内置 quant skill 在 sync 时一并写入；不依赖 FSI。
   */
  test("Wave-1：同步 11 条内置 quant skill，PEAD 关键词可命中", async () => {
    await _deleteSyncedSkillsForProject(projectId);
    await syncDefinitionSkillsForProject(projectId);
    const hits = await skillService.searchWithMeta({
      projectId,
      query: "PEAD post-earnings drift SUE",
      topK: 5,
    });
    const peadHit = hits.find((h) => h.skill.name === "quant:alpha-pead-drift");
    expect(peadHit, "PEAD quant skill 应被召回").toBeDefined();
    /** description 应该非空（来自 frontmatter） */
    expect(peadHit!.skill.description?.length ?? 0).toBeGreaterThan(20);
  });

  test("Wave-1：内置 quant skill 至少 11 条全部入库，可按名查到", async () => {
    await _deleteSyncedSkillsForProject(projectId);
    await syncDefinitionSkillsForProject(projectId);
    const expectedSlugs = [
      "alpha-pead-drift",
      "quality-piotroski-f-score",
      "momentum-52w-breakout",
      "mean-reversion-bollinger",
      "vol-regime-classifier",
      "yield-curve-recession-probe",
      "news-sentiment-event-scoring",
      "factor-ic-ir-report",
      "risk-concentration-var-checklist",
      "backtest-leakage-self-check",
      "order-intent-buy-checklist",
    ];
    for (const slug of expectedSlugs) {
      const skill = await skillService.findByName(projectId, `quant:${slug}`);
      expect(skill, `quant:${slug} 应入库`).toBeTruthy();
    }
  });

  test("Wave-1：syncBuiltinQuantSkills 幂等 —— 跑 2 次 skill 数不变", async () => {
    await _deleteSyncedSkillsForProject(projectId);
    await syncDefinitionSkillsForProject(projectId);
    const first = await skillService.findByName(projectId, "quant:alpha-pead-drift");
    expect(first).toBeTruthy();
    const firstId = first!.id;

    await syncDefinitionSkillsForProject(projectId);
    const second = await skillService.findByName(projectId, "quant:alpha-pead-drift");
    expect(second?.id).toBe(firstId);
  });
});
