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
});
