import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEED_AGENT_DEFINITIONS } from "../../seed-agent-definitions-data";
import { SKILL_HANDLERS } from "../../tools/skill-handlers";
import { searchFilesystemSkills } from "../filesystem-skill-store";

const roots: string[] = [];

afterEach(async () => {
  // Bun's temp sandbox is removed by the OS; avoid a recursive deletion here.
  roots.length = 0;
});

describe("filesystem global skills", () => {
  test("reads standard <skill>/SKILL.md without any database", async () => {
    const root = await mkdtemp(join(tmpdir(), "qubit-skills-"));
    roots.push(root);
    const dir = join(root, "market-microstructure");
    await mkdir(dir);
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: market-microstructure\ndescription: Read order book imbalance before execution.\nversion: v1\n---\n# Checklist\nUse ticks, trades, and order-book depth.\n",
    );

    const hits = await searchFilesystemSkills({
      root,
      query: "order book imbalance",
      declaredSkillRefs: ["market-microstructure"],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.skill).toMatchObject({
      id: "fs:market-microstructure/SKILL.md",
      name: "market-microstructure",
      source: "filesystem",
      version: "v1",
    });
    expect(hits[0]?.skill.bodyMd).toContain("ticks");
  });

  test("skill.search injects a filesystem Skill without a project database", async () => {
    const root = await mkdtemp(join(tmpdir(), "qubit-skills-handler-"));
    const previous = process.env.QUBIT_SKILLS_DIR;
    process.env.QUBIT_SKILLS_DIR = root;
    try {
      const dir = join(root, "spread-check");
      await mkdir(dir);
      await writeFile(
        join(dir, "SKILL.md"),
        "---\nname: spread-check\ndescription: Check bid ask spread before a trade.\n---\nInspect order book and recent trades.\n",
      );
      const definition = SEED_AGENT_DEFINITIONS.find((item) => item.id === "def-market-data")!;
      const output = (await SKILL_HANDLERS["skill.search"]!(
        {
          workflowId: "prime-bridge",
          runId: "run",
          traceId: "trace",
          agentInstanceId: "agent",
          definition,
        },
        { query: "bid ask spread", recordUsage: true },
      )) as { sources: { filesystem: number; database: number }; skills: Array<{ name: string; source: string }> };

      expect(output.sources).toEqual({ filesystem: 1, database: 0 });
      expect(output.skills).toEqual([expect.objectContaining({ name: "spread-check", source: "filesystem" })]);
    } finally {
      if (previous === undefined) delete process.env.QUBIT_SKILLS_DIR;
      else process.env.QUBIT_SKILLS_DIR = previous;
    }
  });
});
