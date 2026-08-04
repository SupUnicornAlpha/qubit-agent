import { createBuiltinFsMemoryProvider, type MemoryProvider } from "./fs-memory";
import { createLocalQuantDecisionProvider } from "./local-quant";
import type { WorkspaceManifest } from "../types";
import type { WorkspaceFs } from "../workspace-fs";

export type DecisionEngineProvider = {
  readonly kind: string;
  listStrategies(ws: WorkspaceFs): Promise<Array<{ id: string; name: string; relPath?: string }>>;
  listFactors(ws: WorkspaceFs): Promise<Array<{ id: string; name: string; relPath?: string }>>;
  openStrategy?(
    ws: WorkspaceFs,
    id: string
  ): Promise<{ relPath?: string; externalUrl?: string }>;
  runBacktest?(
    ws: WorkspaceFs,
    req: { strategyId: string; params?: Record<string, unknown> }
  ): Promise<{ runId: string; artifactRelPath?: string }>;
  syncIntoWorkspace?(
    ws: WorkspaceFs,
    opts: { projectId: string }
  ): Promise<{ factorCount: number; strategyCount: number }>;
};

export type ResolvedProviders = {
  memory: MemoryProvider;
  decision: DecisionEngineProvider;
};

type MemoryFactory = () => MemoryProvider;
type DecisionFactory = () => DecisionEngineProvider;

const memoryRegistry = new Map<string, MemoryFactory>([
  ["builtin.fs_memory", () => createBuiltinFsMemoryProvider()],
]);

const decisionRegistry = new Map<string, DecisionFactory>([
  ["builtin.local_quant", () => createLocalQuantDecisionProvider()],
]);

export function registerMemoryProvider(kind: string, factory: MemoryFactory): void {
  memoryRegistry.set(kind, factory);
}

export function registerDecisionProvider(kind: string, factory: DecisionFactory): void {
  decisionRegistry.set(kind, factory);
}

export function listRegisteredProviderKinds(): {
  memory: string[];
  decision: string[];
} {
  return {
    memory: [...memoryRegistry.keys()],
    decision: [...decisionRegistry.keys()],
  };
}

export function resolveProviders(manifest: WorkspaceManifest): ResolvedProviders {
  const memoryKind = manifest.providers.memory?.kind || "builtin.fs_memory";
  const decisionKind = manifest.providers.decision?.kind || "builtin.local_quant";

  const memoryFactory = memoryRegistry.get(memoryKind) ?? memoryRegistry.get("builtin.fs_memory")!;
  const decisionFactory =
    decisionRegistry.get(decisionKind) ?? decisionRegistry.get("builtin.local_quant")!;

  if (!memoryRegistry.has(memoryKind)) {
    console.warn(
      `[workspace] memory provider "${memoryKind}" not registered; falling back to builtin.fs_memory`
    );
  }
  if (!decisionRegistry.has(decisionKind)) {
    console.warn(
      `[workspace] decision provider "${decisionKind}" not registered; falling back to builtin.local_quant`
    );
  }

  return {
    memory: memoryFactory(),
    decision: decisionFactory(),
  };
}

export type OpenedWorkspace = {
  fs: WorkspaceFs;
  manifest: WorkspaceManifest;
  providers: ResolvedProviders;
};
