import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAgentSkillPath } from "../import-agent-skills";
import { importClaudePluginDir } from "../import-claude";
import { importCodexPluginDir } from "../import-codex";
import { listOfficialPluginPacks } from "../official-packs";
import { parseSkillMdFrontmatter } from "../parse-skill-md";
import { INTERNET_PLUGIN_ID } from "../types";

describe("parseSkillMdFrontmatter", () => {
  test("parses name/description and body", () => {
    const raw = `---
name: hello
description: Say hi
---

Greet the user.
`;
    const p = parseSkillMdFrontmatter(raw);
    expect(p.name).toBe("hello");
    expect(p.description).toBe("Say hi");
    expect(p.body).toContain("Greet the user");
  });

  test("handles missing frontmatter", () => {
    const p = parseSkillMdFrontmatter("# Just a doc\n\nBody");
    expect(p.name).toBeUndefined();
    expect(p.body).toContain("Just a doc");
  });
});

describe("official packs", () => {
  test("includes Internet and Futu packs", () => {
    const packs = listOfficialPluginPacks();
    const internet = packs.find((p) => p.id === INTERNET_PLUGIN_ID);
    expect(internet).toBeDefined();
    expect(internet?.ref.builtinTools).toContain("web.search");
    expect(internet?.ref.builtinTools).toContain("web.fetch");
    expect(packs.some((p) => p.id === "connector:futu")).toBe(true);
  });
});

describe("import adapters", () => {
  test("importAgentSkillPath reads SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "qubit-skill-"));
    const skillDir = join(root, "hello");
    await mkdir(skillDir);
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: hello
description: Greet
---

Say hello.
`
    );
    const skill = await importAgentSkillPath(skillDir);
    expect(skill.name).toBe("hello");
    expect(skill.description).toBe("Greet");
    expect(skill.bodyMd).toContain("Say hello");
  });

  test("importCodexPluginDir extracts skills and warns on .app.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "qubit-codex-"));
    await mkdir(join(root, ".codex-plugin"));
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "demo-plugin",
        version: "1.0.0",
        description: "Demo",
        skills: "./skills/",
      })
    );
    await mkdir(join(root, "skills", "greet"), { recursive: true });
    await writeFile(
      join(root, "skills", "greet", "SKILL.md"),
      `---
name: greet
description: Greet users
---

Be friendly.
`
    );
    await writeFile(
      join(root, ".app.json"),
      JSON.stringify({ apps: [{ id: "plugin_asdk_app_demo" }] })
    );
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-mcp"], env: { A: "1" } },
        },
      })
    );

    const result = await importCodexPluginDir(root);
    expect(result.manifest.name).toBe("demo-plugin");
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.name).toBe("greet");
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0]?.name).toBe("demo");
    expect(result.warnings.some((w) => w.includes(".app.json"))).toBe(true);
  });

  test("importClaudePluginDir extracts skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "qubit-claude-"));
    await mkdir(join(root, ".claude-plugin"));
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "claude-demo", description: "x" })
    );
    await mkdir(join(root, "skills", "note"), { recursive: true });
    await writeFile(
      join(root, "skills", "note", "SKILL.md"),
      `---
name: note
description: Take notes
---

Write notes.
`
    );
    await mkdir(join(root, "hooks"));
    const result = await importClaudePluginDir(root);
    expect(result.manifest.name).toBe("claude-demo");
    expect(result.skills[0]?.name).toBe("note");
    expect(result.warnings.some((w) => w.includes("hooks"))).toBe(true);
  });
});
