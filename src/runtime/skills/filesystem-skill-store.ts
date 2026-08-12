import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { getGlobalSkillsDir } from "../app-paths";
import { parseSkillMdFrontmatter } from "../plugins/parse-skill-md";

const MAX_SKILL_BYTES = 16 * 1024;

export type FilesystemSkill = {
  /** Stable within the configured global skills root; deliberately not a DB id. */
  id: string;
  name: string;
  description: string;
  bodyMd: string;
  category: string;
  version: string;
  source: "filesystem";
  sourcePath: string;
};

export type FilesystemSkillHit = {
  skill: FilesystemSkill;
  score: number;
  rank: number;
};

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function terms(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .filter((term) => term.length > 1);
}

function fallbackDescription(body: string, name: string): string {
  const line = body
    .split(/\r?\n/)
    .map((value) => value.replace(/^#+\s*/, "").trim())
    .find((value) => value.length > 0);
  return line && line !== name ? line.slice(0, 500) : `Reusable procedure: ${name}`;
}

async function readOneSkill(root: string, path: string): Promise<FilesystemSkill | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_SKILL_BYTES) return null;
  const parsed = parseSkillMdFrontmatter(raw);
  const pathName = basename(path, extname(path));
  const directoryName = basename(pathName.toUpperCase() === "SKILL" ? join(path, "..") : pathName);
  const name = (parsed.name?.trim() || directoryName).slice(0, 120);
  const bodyMd = parsed.body.trim();
  if (!name || !bodyMd) return null;
  const rel = relative(root, path).replace(/\\/g, "/");
  return {
    id: `fs:${rel}`,
    name,
    description: (parsed.description?.trim() || fallbackDescription(bodyMd, name)).slice(0, 500),
    bodyMd,
    category: parsed.frontmatter.category?.trim() || "global",
    version: parsed.frontmatter.version?.trim() || "filesystem",
    source: "filesystem",
    sourcePath: path,
  };
}

/** Read `*.md` and `<folder>/SKILL.md`; absent roots are a normal empty state. */
export async function listFilesystemSkills(
  root = getGlobalSkillsDir()
): Promise<FilesystemSkill[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      candidates.push(join(root, entry.name));
    } else if (entry.isDirectory()) {
      candidates.push(join(root, entry.name, "SKILL.md"));
    }
  }
  const skills = await Promise.all(candidates.map((path) => readOneSkill(root, path)));
  return skills
    .filter((skill): skill is FilesystemSkill => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function scoreSkill(skill: FilesystemSkill, query: string, declaredRefs: Set<string>): number {
  const normalizedQuery = normalize(query);
  const queryTerms = terms(query);
  const name = normalize(skill.name);
  const description = normalize(skill.description);
  const body = normalize(skill.bodyMd);
  let score = 0.2;
  if (declaredRefs.has(skill.name) || declaredRefs.has(skill.id)) score += 0.2;
  if (!normalizedQuery) return score;
  if (name.includes(normalizedQuery)) score += 0.8;
  if (description.includes(normalizedQuery)) score += 0.45;
  for (const term of queryTerms) {
    if (name.includes(term)) score += 0.3;
    else if (description.includes(term)) score += 0.16;
    else if (body.includes(term)) score += 0.06;
  }
  return score;
}

/** Filesystem-first lexical recall; a declared Agent skill gets a small deterministic boost. */
export async function searchFilesystemSkills(input: {
  query?: string;
  topK?: number;
  declaredSkillRefs?: string[];
  root?: string;
}): Promise<FilesystemSkillHit[]> {
  const declaredRefs = new Set((input.declaredSkillRefs ?? []).map((value) => value.trim()));
  const ranked = (await listFilesystemSkills(input.root)).map((skill) => ({
    skill,
    score: scoreSkill(skill, input.query ?? "", declaredRefs),
  }));
  const queryTerms = terms(input.query ?? "");
  const filtered = queryTerms.length ? ranked.filter(({ score }) => score > 0.2) : ranked;
  return filtered
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, Math.max(1, Math.min(Number(input.topK ?? 5) || 5, 20)))
    .map((hit, index) => ({ ...hit, rank: index + 1 }));
}
