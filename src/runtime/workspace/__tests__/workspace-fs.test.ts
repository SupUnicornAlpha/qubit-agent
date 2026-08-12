import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspacePathError,
  WorkspaceProviderError,
  buildWorkspaceBootstrapPack,
  createBuiltinFsMemoryProvider,
  createFsWorkspace,
  discoverWorkspaces,
  listRegisteredProviderKinds,
  openWorkspaceById,
  registerMemoryProvider,
  resolveInsideRoot,
  resolveProviders,
  slugifyWorkspaceName,
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
    const dataDir = process.env.QUBIT_DATA_DIR?.trim() || (await mkdtemp(join(tmpdir(), "qb-ws-")));
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
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits.some((h) => h.manifest.id === created.manifest.id)).toBe(true);

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

      const { memory, decision } = resolveProviders(opened.manifest);
      expect(decision.kind).toBe("builtin.local_quant");
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
      await memory.remove(opened.fs, entry.id);
      const afterRemove = await memory.list(opened.fs, {});
      expect(afterRemove.some((e) => e.id === entry.id)).toBe(false);

      await opened.fs.writeJson("research/factors/demo-factor.json", {
        id: "f1",
        name: "demo",
      });
      const factors = await decision.listFactors(opened.fs);
      expect(factors.some((f) => f.name.includes("demo-factor"))).toBe(true);

      await writeRunRecord(opened.fs, {
        id: "run_test_1",
        title: "分析 NVDA",
        status: "running",
        workflowId: "wf-1",
      });
      expect(await opened.fs.exists("runs/run_test_1/run.json")).toBe(true);

      // 恢复说明书供 bootstrap（已被换成 AGENTS.md）
      const pack = await buildWorkspaceBootstrapPack(created.manifest.id);
      expect(pack.contextBlock).toContain("Workspace 课题上下文");
      expect(pack.contextBlock).toContain("AGENTS.md");

      // 路径越权
      await expect(opened.fs.readText("../outside.txt")).rejects.toThrow();
    } finally {
      // QUBIT_DATA_DIR 由测试 harness 管理，勿整目录删除以免误伤其它用例
    }
  });
});

describe("workspace provider registry", () => {
  test("lists builtin + external stub kinds", () => {
    const kinds = listRegisteredProviderKinds();
    expect(kinds.memory).toContain("builtin.fs_memory");
    expect(kinds.memory).toContain("external.http_memory");
    expect(kinds.decision).toContain("builtin.local_quant");
    expect(kinds.decision).toContain("external.decision_stub");
  });

  test("unknown kind fails closed", async () => {
    const dataDir = process.env.QUBIT_DATA_DIR?.trim() || (await mkdtemp(join(tmpdir(), "qb-ws-")));
    const created = await createFsWorkspace({ name: "provider-strict", dataDir });
    const badManifest = {
      ...created.manifest,
      providers: {
        ...created.manifest.providers,
        memory: { kind: "vendor.unknown_memory", config: {} },
      },
    };
    expect(() => resolveProviders(badManifest)).toThrow(WorkspaceProviderError);
    const fallback = resolveProviders(badManifest, { allowBuiltinFallback: true });
    expect(fallback.memory.kind).toBe("builtin.fs_memory");
  });

  test("registerMemoryProvider extends registry", () => {
    registerMemoryProvider("test.custom_memory", () => createBuiltinFsMemoryProvider());
    expect(listRegisteredProviderKinds().memory).toContain("test.custom_memory");
  });
});
