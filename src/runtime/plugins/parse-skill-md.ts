/** Minimal YAML frontmatter parser for Agent Skills SKILL.md (name/description). */

export function parseSkillMdFrontmatter(raw: string): {
  name?: string;
  description?: string;
  body: string;
  frontmatter: Record<string, string>;
} {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    return { body: text.trim(), frontmatter: {} };
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) {
    return { body: text.trim(), frontmatter: {} };
  }
  const fmBlock = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.trim();
    let value = m[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return {
    ...(frontmatter.name ? { name: frontmatter.name } : {}),
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    body: body.trim(),
    frontmatter,
  };
}
