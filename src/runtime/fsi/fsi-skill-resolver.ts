import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getFsiContentRoot, maxSkillInjectTotalChars } from "./fsi-config";
import { loadFsiManifest } from "./fsi-manifest-loader";
import type { FsiResolvedSkill } from "./fsi-types";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function stripYamlFrontmatter(md: string): string {
  return md.replace(FRONTMATTER_RE, "").trim();
}

function truncateByCodepoints(text: string, max: number): { text: string; truncated: boolean } {
  const chars = [...text];
  if (chars.length <= max) return { text, truncated: false };
  return {
    text: `${chars.slice(0, max).join("")}\n\n…[FSI skill truncated]`,
    truncated: true,
  };
}

export async function resolveFsiSkillBody(skillId: string): Promise<FsiResolvedSkill | null> {
  const root = getFsiContentRoot();
  if (!root) return null;
  const manifest = await loadFsiManifest();
  const entry = manifest.skills[skillId];
  if (!entry) return null;
  const absPath = join(root, entry.path);
  try {
    const raw = await readFile(absPath, "utf-8");
    const stripped = stripYamlFrontmatter(raw);
    const max = entry.maxInjectChars ?? 10000;
    const { text, truncated } = truncateByCodepoints(stripped, max);
    return { id: skillId, body: text, truncated, sourcePath: absPath };
  } catch {
    return null;
  }
}

export async function resolveFsiPlaybookBody(
  relativePath: string,
  maxChars: number
): Promise<string | null> {
  const root = getFsiContentRoot();
  if (!root) return null;
  try {
    const raw = await readFile(join(root, relativePath), "utf-8");
    const stripped = stripYamlFrontmatter(raw);
    return truncateByCodepoints(stripped, maxChars).text;
  } catch {
    return null;
  }
}

/** 将 skill id 列表解析为可注入 prompt 的合并正文 */
export async function assembleFsiSkillsBlock(skillIds: string[]): Promise<string> {
  const unique = [...new Set(skillIds.filter((id) => id.startsWith("fsi/")))];
  if (unique.length === 0) return "";
  const root = getFsiContentRoot();
  if (!root) {
    return [
      "## FSI Skills（内容未就绪）",
      "已启用 FSI，但 `content-packs/anthropic-fsi/vendor/` 为空。请运行：`./scripts/sync-fsi-vendor.sh`",
      `期望 skill：${unique.join(", ")}`,
    ].join("\n");
  }

  const parts: string[] = ["## FSI Skills（Anthropic Financial Services）"];
  let budget = maxSkillInjectTotalChars();
  for (const id of unique) {
    if (budget <= 0) break;
    const resolved = await resolveFsiSkillBody(id);
    if (!resolved) {
      parts.push(`### ${id}\n[未找到 SKILL.md]`);
      continue;
    }
    const slice = resolved.body.slice(0, budget);
    budget -= [...slice].length;
    parts.push(`### ${id}\n${slice}`);
    if (resolved.truncated || slice.length < resolved.body.length) {
      parts.push(`> 注：${id} 已截断以控制上下文长度。`);
    }
  }
  return parts.join("\n\n");
}
