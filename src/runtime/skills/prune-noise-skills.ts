/**
 * 清理与量化主线无关、或噪声归纳的 agent_skill：
 *   - 非金融 agent 归纳（如 ai-infra）
 *   - 零使用的 FSI KYC / xlsx / 办公类镜像
 *   - 明确列入黑名单的 name
 *
 * 只 archive，不物理删除（skillService 契约）。
 * 在 syncBuiltinQuantSkillsForProject 之后调用。
 */
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentSkill } from "../../db/sqlite/schema";
import { skillService } from "./skill-service";

/** 精确 name 黑名单（跨项目） */
const ARCHIVE_EXACT_NAMES = new Set(["research:ai-infra-analyst-signals"]);

/** name 子串：FSI 运营/合规文档类（量化交易主路径用不到） */
const FSI_NOISE_SUBSTR = [
  "kyc",
  "xlsx",
  "excel",
  "powerpoint",
  "docx",
  "pdf-form",
  "onboarding",
  "client-intake",
  "regulatory-filing-template",
];

function isFsiNoiseName(name: string): boolean {
  if (!name.startsWith("fsi:")) return false;
  const lower = name.toLowerCase();
  return FSI_NOISE_SUBSTR.some((s) => lower.includes(s));
}

function shouldArchive(row: {
  name: string;
  source: string;
  useCount: number;
  pinned: boolean;
  state: string;
}): boolean {
  if (row.pinned || row.state === "archived") return false;
  if (ARCHIVE_EXACT_NAMES.has(row.name)) return true;
  // 零使用的 FSI 噪声镜像
  if (row.useCount === 0 && isFsiNoiseName(row.name)) return true;
  // agent 归纳且明显非金融
  if (
    (row.source === "agent_created" || row.source === "evolved") &&
    row.useCount === 0 &&
    /ai-infra|infra-analyst|devops|k8s/i.test(row.name)
  ) {
    return true;
  }
  return false;
}

export async function pruneNoiseSkillsForProject(projectId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({
      id: agentSkill.id,
      name: agentSkill.name,
      source: agentSkill.source,
      useCount: agentSkill.useCount,
      pinned: agentSkill.pinned,
      state: agentSkill.state,
    })
    .from(agentSkill)
    .where(and(eq(agentSkill.projectId, projectId), ne(agentSkill.state, "archived")));

  let n = 0;
  for (const row of rows) {
    if (!shouldArchive(row)) continue;
    await skillService.archive(row.id, `prune-noise-skills: ${row.name}`);
    n += 1;
  }
  return n;
}
