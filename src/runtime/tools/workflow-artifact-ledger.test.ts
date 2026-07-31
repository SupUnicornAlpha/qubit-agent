import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import { project, workflowRun, workspace } from "../../db/sqlite/schema";
import {
  classifyWorkflowArtifactKind,
  findWorkflowArtifactByFingerprint,
  listWorkflowArtifactsForContext,
  recordWorkflowDataGap,
  recordWorkflowToolArtifact,
  renderWorkflowArtifactContext,
} from "./workflow-artifact-ledger";

let workflowId = "";

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  const db = await getDb();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  workflowId = randomUUID();
  await db.insert(workspace).values({ id: workspaceId, name: "ledger test", owner: "test" });
  await db.insert(project).values({
    id: projectId,
    workspaceId,
    name: "ledger test",
    marketScope: "CN",
  });
  await db.insert(workflowRun).values({
    id: workflowId,
    projectId,
    goal: "ledger test",
    mode: "research",
  });
});

describe("workflow artifact ledger", () => {
  test("classifies only reusable evidence reads", () => {
    expect(classifyWorkflowArtifactKind("market.resolve_symbol")).toBe("SymbolResolution");
    expect(classifyWorkflowArtifactKind("qubit-data/fetch_quote")).toBe("MarketSnapshot");
    expect(classifyWorkflowArtifactKind("qubit-data/fetch_fundamentals")).toBe(
      "FundamentalSnapshot"
    );
    expect(classifyWorkflowArtifactKind("recommendation.record")).toBe("Recommendation");
    expect(classifyWorkflowArtifactKind("factor.register")).toBeNull();
  });

  test("persists a workflow fact and makes it reusable across a new execution run", async () => {
    const result = {
      connectorResult: {
        symbol: "600519.SH",
        lastPrice: 1420,
        timestamp: "2026-07-31T02:00:00.000Z",
        freshnessMs: 500,
      },
    };
    const written = await recordWorkflowToolArtifact({
      workflowRunId: workflowId,
      fingerprint: "quote-fingerprint",
      toolName: "qubit-data/fetch_quote",
      result,
      producerTaskId: "first-execution",
    });
    const reused = await findWorkflowArtifactByFingerprint(workflowId, "quote-fingerprint");
    expect(written?.kind).toBe("MarketSnapshot");
    expect(reused).toMatchObject({
      producerTaskId: "first-execution",
      payload: result,
      freshnessMs: 500,
    });
  });

  test("does not reuse an expired realtime quote", async () => {
    await recordWorkflowToolArtifact({
      workflowRunId: workflowId,
      fingerprint: "expired-quote",
      toolName: "qubit-data/fetch_quote",
      result: { connectorResult: { symbol: "AAPL", lastPrice: 1 } },
    });
    expect(
      await findWorkflowArtifactByFingerprint(
        workflowId,
        "expired-quote",
        new Date(Date.now() + 60_000)
      )
    ).toBeNull();
  });

  test("persists a non-retryable coverage gap for later A2A executions", async () => {
    await recordWorkflowDataGap({
      workflowRunId: workflowId,
      fingerprint: "fundamentals-gap",
      toolName: "qubit-data/fetch_fundamentals",
      gap: {
        kind: "no_coverage",
        capability: "qubit-data/fetch_fundamentals",
        market: "US",
        provider: "qubit-data",
        reason: "periods_empty",
        retryable: false,
      },
    });
    expect(await findWorkflowArtifactByFingerprint(workflowId, "fundamentals-gap")).toMatchObject({
      kind: "DataGap",
      payload: { dataGap: { kind: "no_coverage" } },
    });
  });

  test("renders only current typed evidence for a subsequent reason turn", async () => {
    await recordWorkflowToolArtifact({
      workflowRunId: workflowId,
      fingerprint: "news-evidence",
      toolName: "qubit-news/fetch_news",
      result: { items: [{ title: "verified event", asOf: "2026-07-31T02:00:00.000Z" }] },
    });
    const artifacts = await listWorkflowArtifactsForContext(workflowId);
    expect(artifacts[0]).toMatchObject({ kind: "NewsEvidence", toolName: "qubit-news/fetch_news" });
    expect(renderWorkflowArtifactContext(artifacts)).toContain("已验证结构化证据");
    expect(renderWorkflowArtifactContext(artifacts)).toContain("verified event");
  });
});
