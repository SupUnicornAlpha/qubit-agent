/**
 * WorkflowFactsPort — single entry for scenario facts used by Loop / Policy / Completion.
 */

import type { Database } from "bun:sqlite";
import {
  type A2aTaskFact,
  type ChildEvidenceFact,
  loadA2aFactsForWorkflow,
} from "../../a2a/evidence-aggregate";
import { type ScenarioRuntimeSnapshot, loadScenarioRuntimeSnapshot } from "../scenario-snapshot";
import { ensureRuntimeSqlite, getRuntimeSqlite } from "./runtime-sqlite";

export type { A2aTaskFact, ChildEvidenceFact };

export interface LoadSnapshotOpts {
  availableTools?: readonly string[];
  extraAttemptedTools?: readonly string[];
  /** When true (default), attach open A2A tasks + child evidence. */
  includeA2a?: boolean;
}

export interface WorkflowFactsPort {
  loadSnapshot(workflowId: string, opts?: LoadSnapshotOpts): ScenarioRuntimeSnapshot;
  listOpenA2aTasks(workflowId: string): A2aTaskFact[];
  listChildEvidence(workflowId: string): ChildEvidenceFact[];
}

export class SqliteWorkflowFactsPort implements WorkflowFactsPort {
  constructor(private readonly sqlite: Database) {}

  loadSnapshot(workflowId: string, opts: LoadSnapshotOpts = {}): ScenarioRuntimeSnapshot {
    const base = loadScenarioRuntimeSnapshot({
      sqlite: this.sqlite,
      workflowId,
      availableTools: opts.availableTools,
      extraAttemptedTools: opts.extraAttemptedTools,
    });
    if (opts.includeA2a === false) return base;
    const a2a = loadA2aFactsForWorkflow(this.sqlite, workflowId);
    return {
      ...base,
      openA2aTasks: a2a.openTasks,
      childEvidence: a2a.childEvidence,
      a2aGap: a2a.a2aGap,
    };
  }

  listOpenA2aTasks(workflowId: string): A2aTaskFact[] {
    return loadA2aFactsForWorkflow(this.sqlite, workflowId).openTasks;
  }

  listChildEvidence(workflowId: string): ChildEvidenceFact[] {
    return loadA2aFactsForWorkflow(this.sqlite, workflowId).childEvidence;
  }
}

let _port: WorkflowFactsPort | null = null;

/** Sync accessor after ensureFactsPort() / getDb(). */
export function getWorkflowFactsPort(): WorkflowFactsPort {
  if (!_port) {
    _port = new SqliteWorkflowFactsPort(getRuntimeSqlite());
  }
  return _port;
}

export async function ensureFactsPort(): Promise<WorkflowFactsPort> {
  const sqlite = await ensureRuntimeSqlite();
  _port = new SqliteWorkflowFactsPort(sqlite);
  return _port;
}

/** Test helper */
export function setWorkflowFactsPortForTest(port: WorkflowFactsPort | null): void {
  _port = port;
}
