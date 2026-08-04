import { createBuiltinFsMemoryProvider, type MemoryProvider } from "./fs-memory";
import type { WorkspaceManifest } from "../types";
import type { WorkspaceFs } from "../workspace-fs";

export type DecisionEngineProvider = {
  readonly kind: string;
  /** v1：占位，后续接工坊 API 投影 */
  listStrategies(ws: WorkspaceFs): Promise<Array<{ id: string; name: string; relPath?: string }>>;
  listFactors(ws: WorkspaceFs): Promise<Array<{ id: string; name: string; relPath?: string }>>;
};

export type ResolvedProviders = {
  memory: MemoryProvider;
  decision: DecisionEngineProvider;
};

function createLocalQuantStub(): DecisionEngineProvider {
  return {
    kind: "builtin.local_quant",
    async listStrategies(ws) {
      const tree = await ws.listTree({ maxDepth: 5 });
      const folder = tree.children
        ?.find((c) => c.name === "decision")
        ?.children?.find((c) => c.name === "strategies");
      return (folder?.children ?? [])
        .filter((n) => n.kind !== "folder")
        .map((n) => ({
          id: n.relPath || n.id,
          name: n.name,
          relPath: n.relPath,
        }));
    },
    async listFactors(ws) {
      const tree = await ws.listTree({ maxDepth: 5 });
      const folder = tree.children
        ?.find((c) => c.name === "research")
        ?.children?.find((c) => c.name === "factors");
      return (folder?.children ?? [])
        .filter((n) => n.kind !== "folder")
        .map((n) => ({
          id: n.relPath || n.id,
          name: n.name,
          relPath: n.relPath,
        }));
    },
  };
}

export function resolveProviders(manifest: WorkspaceManifest): ResolvedProviders {
  const memoryKind = manifest.providers.memory?.kind || "builtin.fs_memory";
  const decisionKind = manifest.providers.decision?.kind || "builtin.local_quant";

  const memory =
    memoryKind === "builtin.fs_memory"
      ? createBuiltinFsMemoryProvider()
      : createBuiltinFsMemoryProvider(); // 未知 kind 暂时回退 FS；后续注册表扩展

  const decision =
    decisionKind === "builtin.local_quant"
      ? createLocalQuantStub()
      : createLocalQuantStub();

  if (memoryKind !== "builtin.fs_memory") {
    console.warn(
      `[workspace] memory provider "${memoryKind}" not registered; falling back to builtin.fs_memory`
    );
  }
  if (decisionKind !== "builtin.local_quant") {
    console.warn(
      `[workspace] decision provider "${decisionKind}" not registered; falling back to builtin.local_quant`
    );
  }

  return { memory, decision };
}

export type OpenedWorkspace = {
  fs: WorkspaceFs;
  manifest: WorkspaceManifest;
  providers: ResolvedProviders;
};
