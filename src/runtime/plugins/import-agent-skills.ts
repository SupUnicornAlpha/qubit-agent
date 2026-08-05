import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseSkillMdFrontmatter } from "./parse-skill-md";

export type ParsedSkillImport = {
  name: string;
  description: string;
  bodyMd: string;
  relativePath: string;
};

export async function parseAgentSkillFile(
  absolutePath: string,
  relativePath = basename(absolutePath)
): Promise<ParsedSkillImport> {
  const raw = await readFile(absolutePath, "utf-8");
  const parsed = parseSkillMdFrontmatter(raw);
  const fallbackName = basename(relativePath).replace(/\.md$/i, "") || "imported-skill";
  const name = (parsed.name ?? fallbackName).trim();
  if (!name) throw new Error(`skill import: empty name (${relativePath})`);
  const description = (parsed.description ?? "").trim() || `Imported skill ${name}`;
  const bodyMd = parsed.body.trim() || `# ${name}\n\n${description}`;
  return { name, description, bodyMd, relativePath };
}

/** Import a single skill directory (`…/foo/SKILL.md`) or a lone `.md` file. */
export async function importAgentSkillPath(path: string): Promise<ParsedSkillImport> {
  const skillMd = path.toLowerCase().endsWith("skill.md")
    ? path
    : path.toLowerCase().endsWith(".md")
      ? path
      : join(path, "SKILL.md");
  return parseAgentSkillFile(skillMd, basename(path));
}
