import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  appendAuditLog,
  computeAuditEntryHash,
  type AuditChainEntry,
  verifyAuditLogChain,
  verifyAuditEntries,
} from "./audit-chain-service";
import type { DbClient } from "../../db/sqlite/client";

function seal(input: Omit<AuditChainEntry, "entryHash">): AuditChainEntry {
  return { ...input, entryHash: computeAuditEntryHash(input) };
}

describe("audit hash chain", () => {
  test("verifies a valid chain and detects tampering", () => {
    const first = seal({
      id: "1", traceId: "t", workflowRunId: "w", agentInstanceId: null,
      actorType: "system", actorId: "test", action: "created", resourceType: "order",
      resourceId: "o1", detailJson: { qty: 10 }, previousHash: null,
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const second = seal({
      id: "2", traceId: "t", workflowRunId: "w", agentInstanceId: null,
      actorType: "system", actorId: "test", action: "filled", resourceType: "order",
      resourceId: "o1", detailJson: { qty: 10 }, previousHash: first.entryHash,
      createdAt: "2026-07-13T00:01:00.000Z",
    });
    expect(verifyAuditEntries([first, second]).valid).toBe(true);
    expect(verifyAuditEntries([{ ...first, detailJson: { qty: 11 } }, second]).reason).toBe("entry_hash_mismatch");
  });

  test("keeps legacy rows visible but unsealed", () => {
    const legacy: AuditChainEntry = {
      id: "legacy", traceId: "t", workflowRunId: null, agentInstanceId: null,
      actorType: "system", actorId: "legacy", action: "old", resourceType: "workflow",
      resourceId: "w", detailJson: {}, previousHash: null, entryHash: null,
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    const result = verifyAuditEntries([legacy]);
    expect(result.valid).toBe(true);
    expect(result.legacyUnsealedEntries).toBe(1);
  });

  test("serializes concurrent appends into one valid chain", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`CREATE TABLE audit_log (
      id TEXT PRIMARY KEY NOT NULL, trace_id TEXT NOT NULL, workflow_run_id TEXT,
      agent_instance_id TEXT, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
      action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
      detail_json TEXT NOT NULL, previous_hash TEXT, entry_hash TEXT, created_at TEXT NOT NULL
    )`);
    const db = drizzle(sqlite) as unknown as DbClient;
    await Promise.all(Array.from({ length: 12 }, (_, index) => appendAuditLog(db, {
      traceId: "trace-concurrent",
      actorType: "system",
      actorId: "test",
      action: "append",
      resourceType: "test",
      resourceId: String(index),
      detailJson: { index },
      createdAt: "2026-07-14T00:00:00.000Z",
    })));
    const verification = await verifyAuditLogChain(db, { traceId: "trace-concurrent" });
    expect(verification.valid).toBe(true);
    expect(verification.sealedEntries).toBe(12);
    sqlite.close();
  });
});
