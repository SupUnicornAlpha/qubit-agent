import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type ParsedSkillImport, parseAgentSkillFile } from "./import-agent-skills";
import type { PluginManifest, PluginManifestRef } from "./types";

export type CodexPluginImportResult = {
  manifest: PluginManifest;
  skills: ParsedSkillImport[];
  mcpServers: NonNullable<PluginManifestRef["mcpServers"]>;
  warnings: string[];
};

type CodexPluginJson = {
  name?: string;
  version?: string;
  description?: string;
  skills?: string;
  mcpServers?: string;
  apps?: string;
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
    const skillMd = join(skillsRoot, e.name, "SKILL.md");
    if (await pathExists(skillMd)) dirs.push(join(skillsRoot, e.name));
  }
  return dirs;
}

function parseMcpJson(raw: string): NonNullable<PluginManifestRef["mcpServers"]> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const map =
    parsed.mcpServers && typeof parsed.mcpServers === "object"
      ? (parsed.mcpServers as Record<string, unknown>)
      : parsed.mcp_servers && typeof parsed.mcp_servers === "object"
        ? (parsed.mcp_servers as Record<string, unknown>)
        : parsed;
  const out: NonNullable<PluginManifestRef["mcpServers"]> = [];
  for (const [name, value] of Object.entries(map)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const command = typeof v.command === "string" ? v.command : undefined;
    const args = Array.isArray(v.args) ? v.args.map(String) : [];
    const cmdParts = [...(typeof v.command === "string" ? [v.command] : []), ...args];
    const url = typeof v.url === "string" ? v.url : undefined;
    const transport = typeof v.transport === "string" ? v.transport : url ? "http" : "stdio";
    const env =
      v.env && typeof v.env === "object"
        ? Object.fromEntries(
            Object.entries(v.env as Record<string, unknown>).map(([k, val]) => [k, String(val)])
          )
        : undefined;
    out.push({
      name,
      ...(cmdParts.length ? { command: cmdParts.join(" ") } : command ? { command } : {}),
      ...(url ? { url } : {}),
      transport,
      ...(env ? { env } : {}),
    });
  }
  return out;
}

/**
 * Parse a Codex plugin directory (`.codex-plugin/plugin.json` + skills/ + optional .mcp.json).
 * Does not install — caller persists via registry.
 */
export async function importCodexPluginDir(rootPath: string): Promise<CodexPluginImportResult> {
  const manifestPath = join(rootPath, ".codex-plugin", "plugin.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error(`not a Codex plugin: missing ${manifestPath}`);
  }
  const pluginJson = JSON.parse(await readFile(manifestPath, "utf-8")) as CodexPluginJson;
  const warnings: string[] = [];

  const appsPath = join(rootPath, ".app.json");
  if (await pathExists(appsPath)) {
    warnings.push(
      "检测到 .app.json（OpenAI App Connector）。该连接器 ID 不可移植到 Qubit，已跳过；OAuth SaaS 需自建 connector。"
    );
  }

  const skillsRel = pluginJson.skills ?? "./skills/";
  const skillsRoot = join(rootPath, skillsRel.replace(/^\.\//, ""));
  const skillDirs = await collectSkillDirs(skillsRoot);
  const skills: ParsedSkillImport[] = [];
  for (const dir of skillDirs) {
    skills.push(await parseAgentSkillFile(join(dir, "SKILL.md"), dir));
  }

  let mcpServers: NonNullable<PluginManifestRef["mcpServers"]> = [];
  const mcpRel = pluginJson.mcpServers ?? "./.mcp.json";
  const mcpPath = join(rootPath, mcpRel.replace(/^\.\//, ""));
  if (await pathExists(mcpPath)) {
    try {
      mcpServers = parseMcpJson(await readFile(mcpPath, "utf-8"));
    } catch (e) {
      warnings.push(`解析 .mcp.json 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const name = (pluginJson.name ?? "imported-codex-plugin").trim();
  const kind = skills.length && mcpServers.length ? "bundle" : skills.length ? "skill" : "mcp";

  const manifest: PluginManifest = {
    id: `import:codex:${name}`,
    name,
    version: pluginJson.version,
    description: pluginJson.description ?? `Imported Codex plugin ${name}`,
    category: "imported",
    visibility: "project",
    kind,
    ref: {
      ...(mcpServers.length ? { mcpServers } : {}),
      ...(skills.length ? { skillPaths: skillDirs } : {}),
    },
    auth: { type: "none" },
    safetyLevel: mcpServers.length ? "medium" : "low",
    origin: { format: "codex_plugin", sourcePath: rootPath },
  };

  return { manifest, skills, mcpServers, warnings };
}
