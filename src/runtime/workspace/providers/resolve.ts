/**
 * Workspace Provider 注册与解析。
 * 未知 kind 默认失败；勿静默回退到 builtin（避免配置写错却“看起来正常”）。
 */
import type { ProviderRef, WorkspaceManifest } from "../types";
import type { WorkspaceFs } from "../workspace-fs";
import { createBuiltinFsMemoryProvider, type MemoryProvider } from "./fs-memory";
import { createLocalQuantDecisionProvider } from "./local-quant";
import { createExternalHttpMemoryProvider } from "./external-http-memory";
import {
  createExternalHttpDecisionProvider,
  EXTERNAL_DECISION_STUB_KIND,
  EXTERNAL_HTTP_DECISION_KIND,
} from "./external-decision-stub";
import type { DecisionEngineProvider, ResolvedProviders } from "./provider-types";

export type { DecisionEngineProvider, ResolvedProviders } from "./provider-types";

export class WorkspaceProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceProviderError";
  }
}

type MemoryFactory = (ref: ProviderRef) => MemoryProvider;
type DecisionFactory = (ref: ProviderRef) => DecisionEngineProvider;

const memoryRegistry = new Map<string, MemoryFactory>([
  ["builtin.fs_memory", () => createBuiltinFsMemoryProvider()],
  ["external.http_memory", (ref) => createExternalHttpMemoryProvider(ref)],
]);

const decisionRegistry = new Map<string, DecisionFactory>([
  ["builtin.local_quant", () => createLocalQuantDecisionProvider()],
  [EXTERNAL_HTTP_DECISION_KIND, (ref) => createExternalHttpDecisionProvider(ref)],
  [EXTERNAL_DECISION_STUB_KIND, (ref) => createExternalHttpDecisionProvider(ref)],
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
  const memoryRef: ProviderRef = manifest.providers.memory ?? {
    kind: "builtin.fs_memory",
  };
  const decisionRef: ProviderRef = manifest.providers.decision ?? {
    kind: "builtin.local_quant",
  };
  const memoryKind = memoryRef.kind || "builtin.fs_memory";
  const decisionKind = decisionRef.kind || "builtin.local_quant";
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
    memory: memoryFactory(memoryRef),
    decision: decisionFactory(decisionRef),
  };
}

export type OpenedWorkspace = {
  fs: WorkspaceFs;
  manifest: WorkspaceManifest;
  providers: ResolvedProviders;
};
