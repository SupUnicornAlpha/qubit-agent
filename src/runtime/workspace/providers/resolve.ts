/**
 * Workspace Provider 注册与解析。
 * 未知 kind 默认失败；勿静默回退到 builtin（避免配置写错却“看起来正常”）。
 */
import { createBuiltinFsMemoryProvider, type MemoryProvider } from "./fs-memory";
import { createLocalQuantDecisionProvider } from "./local-quant";
import { createExternalHttpMemoryStub } from "./external-http-memory";
import { createExternalDecisionStub } from "./external-decision-stub";
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

export class WorkspaceProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceProviderError";
  }
}

type MemoryFactory = () => MemoryProvider;
type DecisionFactory = () => DecisionEngineProvider;

const memoryRegistry = new Map<string, MemoryFactory>([
  ["builtin.fs_memory", () => createBuiltinFsMemoryProvider()],
  ["external.http_memory", () => createExternalHttpMemoryStub()],
]);

const decisionRegistry = new Map<string, DecisionFactory>([
  ["builtin.local_quant", () => createLocalQuantDecisionProvider()],
  ["external.decision_stub", () => createExternalDecisionStub()],
]);

export function registerMemoryProvider(kind: string, factory: MemoryFactory): void {
  const k = kind.trim();
  if (!k) throw new WorkspaceProviderError("memory provider kind is required");
  memoryRegistry.set(k, factory);
}

export function registerDecisionProvider(kind: string, factory: DecisionFactory): void {
  const k = kind.trim();
  if (!k) throw new WorkspaceProviderError("decision provider kind is required");
  decisionRegistry.set(k, factory);
}

export function listRegisteredProviderKinds(): {
  memory: string[];
  decision: string[];
} {
  return {
    memory: [...memoryRegistry.keys()].sort(),
    decision: [...decisionRegistry.keys()].sort(),
  };
}

export type ResolveProvidersOptions = {
  /**
   * 未知 kind 是否回退 builtin（默认 false）。
   * 仅调试/迁移脚本应显式打开。
   */
  allowBuiltinFallback?: boolean;
};

export function resolveProviders(
  manifest: WorkspaceManifest,
  opts?: ResolveProvidersOptions
): ResolvedProviders {
  const memoryKind = manifest.providers.memory?.kind || "builtin.fs_memory";
  const decisionKind = manifest.providers.decision?.kind || "builtin.local_quant";
  const allowFallback = opts?.allowBuiltinFallback === true;

  let memoryFactory = memoryRegistry.get(memoryKind);
  if (!memoryFactory) {
    if (!allowFallback) {
      throw new WorkspaceProviderError(
        `Unknown memory provider "${memoryKind}". Registered: ${[...memoryRegistry.keys()].join(", ")}`
      );
    }
    console.warn(
      `[workspace] memory provider "${memoryKind}" not registered; falling back to builtin.fs_memory`
    );
    memoryFactory = memoryRegistry.get("builtin.fs_memory")!;
  }

  let decisionFactory = decisionRegistry.get(decisionKind);
  if (!decisionFactory) {
    if (!allowFallback) {
      throw new WorkspaceProviderError(
        `Unknown decision provider "${decisionKind}". Registered: ${[
          ...decisionRegistry.keys(),
        ].join(", ")}`
      );
    }
    console.warn(
      `[workspace] decision provider "${decisionKind}" not registered; falling back to builtin.local_quant`
    );
    decisionFactory = decisionRegistry.get("builtin.local_quant")!;
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
