import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseAgentSkillFile, type ParsedSkillImport } from "./import-agent-skills";
import type { PluginManifest, PluginManifestRef } from "./types";

export type ClaudePluginImportResult = {
  manifest: PluginManifest;
  skills: ParsedSkillImport[];
  mcpServers: NonNullable<PluginManifestRef["mcpServers"]>;
  warnings: string[];
};

type ClaudePluginJson = {
  name?: string;
  version?: string;
  description?: string;
  skills?: string | string[];
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function collectSkillDirs(skillsRoot: string): Promise<string[]> {
  if (!(await pathExists(skillsRoot))) return [];
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const dirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (await pathExists(join(skillsRoot, e.name, "SKILL.md"))) {
      dirs.push(join(skillsRoot, e.name));
    }
  }
  return dirs;
}

/**
 * Parse a Claude Code plugin directory (`.claude-plugin/plugin.json`).
 * Skills + optional MCP; Claude-only hooks/agents are warned and skipped.
 */
export async function importClaudePluginDir(rootPath: string): Promise<ClaudePluginImportResult> {
  const manifestPath = join(rootPath, ".claude-plugin", "plugin.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error(`not a Claude plugin: missing ${manifestPath}`);
  }
  const pluginJson = JSON.parse(await readFile(manifestPath, "utf-8")) as ClaudePluginJson;
  const warnings: string[] = [];

  for (const extra of ["hooks", "agents", ".mcp.json"]) {
    if (await pathExists(join(rootPath, extra))) {
      if (extra === "hooks" || extra === "agents") {
        warnings.push(`检测到 Claude 专用目录 ${extra}/，已跳过（宿主私有，不在 Qubit 执行）。`);
      }
    }
  }

  const skillsRoot = join(rootPath, "skills");
  const skillDirs = await collectSkillDirs(skillsRoot);
  const skills: ParsedSkillImport[] = [];
  for (const dir of skillDirs) {
    skills.push(await parseAgentSkillFile(join(dir, "SKILL.md"), dir));
  }

  let mcpServers: NonNullable<PluginManifestRef["mcpServers"]> = [];
  const mcpPath = join(rootPath, ".mcp.json");
  if (await pathExists(mcpPath)) {
    try {
      const parsed = JSON.parse(await readFile(mcpPath, "utf-8")) as Record<string, unknown>;
      const map =
        (parsed.mcpServers as Record<string, unknown> | undefined) ??
        (parsed.mcp_servers as Record<string, unknown> | undefined) ??
        {};
      for (const [name, value] of Object.entries(map)) {
        if (!value || typeof value !== "object") continue;
        const v = value as Record<string, unknown>;
        const args = Array.isArray(v.args) ? v.args.map(String) : [];
        const cmd = typeof v.command === "string" ? [v.command, ...args].join(" ") : undefined;
        const url = typeof v.url === "string" ? v.url : undefined;
        mcpServers.push({
          name,
          ...(cmd ? { command: cmd } : {}),
          ...(url ? { url } : {}),
          transport: url ? "http" : "stdio",
        });
      }
    } catch (e) {
      warnings.push(`解析 .mcp.json 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const name = (pluginJson.name ?? "imported-claude-plugin").trim();
  const kind = skills.length && mcpServers.length ? "bundle" : skills.length ? "skill" : "mcp";

  return {
    manifest: {
      id: `import:claude:${name}`,
      name,
      version: pluginJson.version,
      description: pluginJson.description ?? `Imported Claude plugin ${name}`,
      category: "imported",
      visibility: "project",
      kind,
      ref: {
        ...(mcpServers.length ? { mcpServers } : {}),
        ...(skills.length ? { skillPaths: skillDirs } : {}),
      },
      auth: { type: "none" },
      safetyLevel: mcpServers.length ? "medium" : "low",
      origin: { format: "claude_plugin", sourcePath: rootPath },
    },
    skills,
    mcpServers,
    warnings,
  };
}
