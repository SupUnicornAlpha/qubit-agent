import type { WorkspaceFs } from "../workspace-fs";
import type { MemoryProvider } from "./fs-memory";

export type DecisionEngineProvider = {
  readonly kind: string;
  listStrategies(ws: WorkspaceFs): Promise<Array<{ id: string; name: string; relPath?: string }>>;
  listFactors(ws: WorkspaceFs): Promise<Array<{ id: string; name: string; relPath?: string }>>;
  openStrategy?(ws: WorkspaceFs, id: string): Promise<{ relPath?: string; externalUrl?: string }>;
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
