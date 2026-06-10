/**
 * 把 agent_definition.skills_json 里声明的 FSI skill 镜像到 agent_skill 表。
 *
 * reason 节点的 skillService.searchWithMeta 只查 agent_skill；skills_json 里的
 * fsi/* 引用若不镜像，S-1（skill_recall_log）永远 n/a。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentSkill, project } from "../../db/sqlite/schema";
import { resolveFsiSkillBody } from "../fsi/fsi-skill-resolver";
import { syncBuiltinQuantSkillsForProject } from "./seed-builtin-quant-skills";
import { skillService } from "./skill-service";

const FRONTMATTER_DESC_RE =
  /description:\s*(?:\|\s*\n([\s\S]*?)(?=\n[A-Za-z_][\w-]*:|\n---)|["']?([^\n"']+)["']?)/;

function skillNameFromRef(ref: string): string {
  return ref
    .trim()
    .toLowerCase()
    .replace(/\//g, ":")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_\-:.]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function descriptionFromSkillMd(rawBody: string, skillId: string): string {
  const fm = rawBody.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const m = fm[1]!.match(FRONTMATTER_DESC_RE);
    const block = (m?.[1] ?? m?.[2] ?? "").trim();
    if (block) {
      return block
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);
    }
  }
  const first = rawBody.replace(/^#+\s*/, "").split("\n").find((l) => l.trim());
  return (first ?? skillId).trim().slice(0, 500);
}

function collectSkillRefs(skillsJson: unknown): string[] {
  if (!Array.isArray(skillsJson)) return [];
  return [...new Set(skillsJson.filter((s): s is string => typeof s === "string" && s.length > 0))];
}

async function mirrorFsiSkillForProject(
  projectId: string,
  skillRef: string,
  definitionId?: string | null
): Promise<boolean> {
  if (!skillRef.startsWith("fsi/")) return false;
  const resolved = await resolveFsiSkillBody(skillRef);
  if (!resolved) return false;

  const name = skillNameFromRef(skillRef);
  if (!name) return false;

  const description = descriptionFromSkillMd(resolved.body, skillRef);
  const bodyMd = resolved.body.slice(0, 16 * 1024);

  const existing = await skillService.findByName(projectId, name);
  if (existing) {
    await skillService.patch({
      skillId: existing.id,
      description,
      bodyMd,
      metadata: {
        ...((existing.metadataJson as Record<string, unknown>) ?? {}),
        fsiSkillId: skillRef,
        syncedFrom: "definition_skills_json",
      },
    });
    return true;
  }

  await skillService.create({
    projectId,
    definitionId: definitionId ?? null,
    name,
    description,
    bodyMd,
    category: "fsi",
    source: "user_authored",
    createdBy: "builtin-sync",
    metadata: { fsiSkillId: skillRef, syncedFrom: "definition_skills_json" },
  });
  return true;
}

/** 为单个 project 镜像所有内置 definition 声明的 fsi/* skill。 */
export async function syncDefinitionSkillsForProject(projectId: string): Promise<number> {
  const db = await getDb();
  const defs = await db
    .select({ id: agentDefinition.id, skillsJson: agentDefinition.skillsJson })
    .from(agentDefinition);

  const refs = new Set<string>();
  for (const def of defs) {
    for (const ref of collectSkillRefs(def.skillsJson)) {
      if (ref.startsWith("fsi/")) refs.add(ref);
    }
  }

  let n = 0;
  for (const ref of refs) {
    const ok = await mirrorFsiSkillForProject(projectId, ref);
    if (ok) n += 1;
  }
  /**
   * Wave-1（2026-06-10）：在 FSI 镜像之后追加 11 个内置 quant skill。
   * quant skill 不依赖 FSI 内容包或 env，是金融研究 base layer；幂等。
   */
  try {
    n += await syncBuiltinQuantSkillsForProject(projectId);
  } catch (err) {
    console.warn(
      `[Seed:quant-skills] sync failed for project ${projectId}: ${(err as Error).message}`
    );
  }
  return n;
}

/** Bootstrap：为 DB 里每个 project 同步一次（幂等 upsert）。 */
export async function syncDefinitionSkillsForAllProjects(): Promise<number> {
  const db = await getDb();
  const projects = await db.select({ id: project.id }).from(project);
  let total = 0;
  for (const p of projects) {
    total += await syncDefinitionSkillsForProject(p.id);
  }
  return total;
}

/** 测试钩子：清空某 project 下 builtin-sync 写入的 skill */
export async function _deleteSyncedSkillsForProject(projectId: string): Promise<void> {
  const db = await getDb();
  await db.delete(agentSkill).where(eq(agentSkill.projectId, projectId));
}
