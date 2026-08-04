import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFsWorkspace,
  discoverWorkspaces,
  openWorkspaceById,
  resolveInsideRoot,
  resolveProviders,
  slugifyWorkspaceName,
  WorkspacePathError,
  writeRunRecord,
} from "../index";

describe("workspace path safety", () => {
  test("slugify", () => {
    expect(slugifyWorkspaceName("半导体 龙头")).toBe("半导体-龙头");
    expect(slugifyWorkspaceName("")).toBe("workspace");
  });

  test("rejects traversal", () => {
    expect(() => resolveInsideRoot("/tmp/ws", "../etc/passwd")).toThrow(WorkspacePathError);
    expect(() => resolveInsideRoot("/tmp/ws", "/etc/passwd")).toThrow(WorkspacePathError);
  });

  test("resolves nested path", () => {
    const { relPosix } = resolveInsideRoot("/tmp/ws", "research/factors/foo.py");
    expect(relPosix).toBe("research/factors/foo.py");
  });
});

describe("workspace fs lifecycle", () => {
  test("create · discover · tree · memory · instructions · run", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-ws-"));
    try {
      const created = await createFsWorkspace({
        name: "半导体检核",
        dataDir,
        seedUniverse: {
          mode: "basket",
          symbols: [{ symbol: "NVDA", exchange: "US" }],
        },
        defaultFocus: { symbol: "NVDA", exchange: "US" },
      });

      expect(created.manifest.providers.memory.kind).toBe("builtin.fs_memory");
      expect(await created.fs.exists("QUBIT.md")).toBe(true);
      expect(await created.fs.exists(".qubit/workspace.json")).toBe(true);
      expect(await created.fs.exists("input/universe.json")).toBe(true);
      expect(await created.fs.exists("memory/MEMORY.md")).toBe(true);
      expect(await created.fs.exists(".qubit/providers/memory.json")).toBe(true);

      const hits = await discoverWorkspaces(dataDir);
      expect(hits.length).toBe(1);
      expect(hits[0]!.manifest.id).toBe(created.manifest.id);

      const opened = await openWorkspaceById(created.manifest.id, dataDir);
      const tree = await opened.fs.listTree({ maxDepth: 4 });
      const top = new Set((tree.children ?? []).map((c) => c.name));
      expect(top.has("input")).toBe(true);
      expect(top.has("research")).toBe(true);
      expect(top.has("decision")).toBe(true);
      expect(top.has("memory")).toBe(true);
      expect(top.has("runs")).toBe(true);

      const { layers } = await opened.fs.loadAgentInstructions();
      expect(layers.some((l) => l.path === "QUBIT.md")).toBe(true);

      await opened.fs.writeText(".qubit/rules/risk.md", "# risk\nno live without HITL\n");
      const layers2 = await opened.fs.loadAgentInstructions();
      expect(layers2.layers.some((l) => l.path === ".qubit/rules/risk.md")).toBe(true);

      // AGENTS.md 回退：去掉 QUBIT.md 后应读 AGENTS.md
      await opened.fs.remove("QUBIT.md");
      await opened.fs.writeText("AGENTS.md", "# agents\n");
      const layers3 = await opened.fs.loadAgentInstructions();
      expect(layers3.layers[0]?.path).toBe("AGENTS.md");

      const { memory } = resolveProviders(opened.manifest);
      const entry = await memory.upsert(opened.fs, {
        title: "估值框架",
        body: "半导体用 PS 不用 PE",
        pinned: true,
        source: "user",
      });
      expect(entry.id).toBeTruthy();
      const listed = await memory.list(opened.fs, { pinned: true });
      expect(listed.some((e) => e.id === entry.id)).toBe(true);
      const hitsMem = await memory.search(opened.fs, "PS");
      expect(hitsMem.length).toBeGreaterThan(0);
      const boot = await memory.loadBootstrap(opened.fs);
      expect(boot.includes("估值框架") || boot.includes("置顶")).toBe(true);

      await writeRunRecord(opened.fs, {
        id: "run_test_1",
        title: "分析 NVDA",
        status: "running",
        workflowId: "wf-1",
      });
      expect(await opened.fs.exists("runs/run_test_1/run.json")).toBe(true);

      // 路径越权
      await expect(opened.fs.readText("../outside.txt")).rejects.toThrow();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
