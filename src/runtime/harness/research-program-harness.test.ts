import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import { project, strategy, strategyVersion, workflowRun, workspace } from "../../db/sqlite/schema";
import { primeBridgeRouter } from "../../routes/prime-bridge.routes";
import { defaultDataDir } from "../app-paths";
import { backtestJobService } from "../backtest/backtest-job-service";
import { finalHoldoutEvaluationService } from "../effect-validation/final-holdout-evaluation-service";
import { factorService } from "../factor/factor-service";
import { buildMarketSnapshotRecord } from "../market/contracts/market-snapshot-service";
import { bootstrapProviders } from "../provider/bootstrap";
import { researchProgramService } from "../research-program/service";
import type { ResearchProtocolSpec } from "../research-program/types";
import { dispatchBuiltinTool } from "../tools/builtin-tools";
import type { BuiltinToolContext } from "../tools/types";
import { enforceResearchToolAccess } from "./research-program-harness";

const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE"];
const workspaceId = randomUUID();
const projectId = randomUUID();
const legacyProjectId = randomUUID();
const workflowId = randomUUID();
let snapshotId = "";
let factorId = "";
let strategyVersionId = "";
let protocol: ResearchProtocolSpec;

function context(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  return {
    workflowId,
    projectId,
    runId: "research-run",
    traceId: "research-trace",
    agentInstanceId: "",
    definition: {
      id: "research-harness",
      role: "orchestrator",
      name: "Research",
      version: "1",
      systemPrompt: "",
      tools: [],
      mcpServers: [],
      skills: [],
      subscriptions: [],
      llmProvider: "mock",
      maxIterations: 1,
      sandboxPolicyId: "test",
      enabled: true,
    },
    ...overrides,
  };
}

beforeAll(async () => {
  await runMigrations();
  await bootstrapProviders();
  const db = await getDb();
  await db.insert(workspace).values({ id: workspaceId, name: "Harness test", owner: "test" });
  await db.insert(project).values([
    { id: projectId, workspaceId, name: "Controlled", marketScope: "US" },
    { id: legacyProjectId, workspaceId, name: "Exploratory", marketScope: "US" },
  ]);
  await db
    .insert(workflowRun)
    .values({ id: workflowId, projectId, goal: "Research", mode: "research" });
  const record = buildMarketSnapshotRecord({
    asOf: "2026-04-01T00:00:00.000Z",
    purpose: "research",
    timeframe: "1d",
    limit: 90,
    instruments: symbols.map((symbol) => ({ symbol, venue: "US", assetClass: "equity" })),
    window: { start: "2026-01-01", end: "2026-03-31" },
    sources: [
      { provider: `harness-fixture-${randomUUID()}`, feed: "local", upstreamFamily: "fixture" },
    ],
    barsByInstrument: Object.fromEntries(
      symbols.map((symbol, offset) => [
        `US:${symbol}`,
        Array.from({ length: 90 }, (_, day) => {
          const close = 100 + offset * 20 + day * (offset + 1) + Math.sin(day / 3);
          return {
            timestamp: new Date(Date.UTC(2026, 0, day + 1)).toISOString(),
            open: close - 0.2,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1_000,
            turnover: close * 1_000,
          };
        }),
      ])
    ),
  });
  snapshotId = record.snapshot.snapshotId;
  const dir = join(defaultDataDir(), "market-snapshots");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${snapshotId}.json`), JSON.stringify(record));
  protocol = {
    hypothesis: "Causal momentum",
    benchmark: "equal-weight",
    stoppingRule: "Stop at budget",
    development: {
      datasetSnapshotId: snapshotId,
      symbols,
      startDate: "2026-01-01",
      endDate: "2026-03-01",
    },
    evaluation: { method: "factor_rank_ic_v1", horizonDays: 1, groupCount: 3 },
    budget: { maxAttempts: 100, maxEvaluations: 20 },
  };
  await researchProgramService.createProtocol({ projectId, spec: protocol });
  factorId = (
    await factorService.register({
      projectId,
      name: "momentum",
      category: "momentum",
      expr: "close / Ref(close, 1) - 1",
      lang: "qlib_expr",
      universe: "US",
      horizon: 1,
    })
  ).id;
  const strategyId = randomUUID();
  strategyVersionId = randomUUID();
  await db
    .insert(strategy)
    .values({ id: strategyId, projectId, name: "Harness", style: "low_freq" });
  await db.insert(strategyVersion).values({
    id: strategyVersionId,
    strategyId,
    versionTag: "v1",
    logicHash: "fixture",
    paramSchemaJson: {},
  });
});

describe("controlled research tool boundary", () => {
  test("database errors never downgrade a controlled check to legacy execution", async () => {
    const unavailable = spyOn(researchProgramService, "get").mockRejectedValueOnce(
      new Error("research_database_unavailable")
    );
    try {
      await expect(enforceResearchToolAccess("shell.exec", context(), {})).rejects.toThrow(
        "research_database_unavailable"
      );
    } finally {
      unavailable.mockRestore();
    }
  });
  test("denies arbitrary execution, raw data, aliases, MCP and unbound delegation", async () => {
    for (const name of [
      "shell.exec",
      "code.run_python",
      "cli_agent.run",
      "web.search",
      "market.snapshot.get",
      "fetch_klines",
      "factor.compute",
      "factor.autoEvaluate",
      "factor.evaluate",
      "run_experiment",
      "backtest.run",
      "call_mcp",
      "mcp:server:tool",
      "call_team_research",
      "assign_task",
    ]) {
      await expect(dispatchBuiltinTool(name, context(), {})).rejects.toThrow(
        "research_tool_not_allowed"
      );
    }
  });

  test("resolves project from workflow and rejects conflicting or missing authority", async () => {
    const { projectId: _projectId, ...noProject } = context();
    expect((await enforceResearchToolAccess("factor.list", noProject, {})).ctx.projectId).toBe(
      projectId
    );
    await expect(
      enforceResearchToolAccess("factor.list", context({ projectId: legacyProjectId }), {})
    ).rejects.toThrow("context_project_mismatch");
    for (const params of [
      { project_id: legacyProjectId },
      { projectId: legacyProjectId },
      { project_id: projectId, projectId: legacyProjectId },
    ]) {
      await expect(enforceResearchToolAccess("factor.list", context(), params)).rejects.toThrow(
        "argument_project_mismatch"
      );
    }
    await expect(
      enforceResearchToolAccess("factor.list", context({ workflowId: "unknown" }), {})
    ).rejects.toThrow("requires_persisted_workflow");
    await expect(
      enforceResearchToolAccess(
        "shell.exec",
        context({ workflowId: "", projectId: legacyProjectId }),
        { project_id: projectId }
      )
    ).rejects.toThrow("requires_persisted_workflow");
  });

  test("project-owned get/list and safe registration work, paused keeps restrictions", async () => {
    const factor = (await dispatchBuiltinTool("factor.get", context(), {
      factor_id: factorId,
    })) as { projectId: string };
    expect(factor.projectId).toBe(projectId);
    await expect(
      dispatchBuiltinTool("factor.register", context(), {
        name: "unsafe",
        lang: "python",
        expr: "1",
      })
    ).rejects.toThrow("builtin_qlib_expr");
    const safe = await enforceResearchToolAccess("factor.register", context(), {
      expr: "close",
      dry_run: true,
      status: "active",
    });
    expect(safe.params.dry_run).toBe(false);
    expect(safe.params.status).toBe("draft");
    await researchProgramService.setStatus(projectId, "paused");
    try {
      await expect(dispatchBuiltinTool("market.snapshot.get", context(), {})).rejects.toThrow(
        "research_tool_not_allowed"
      );
    } finally {
      await researchProgramService.setStatus(projectId, "active");
    }
    const legacy = await enforceResearchToolAccess(
      "shell.exec",
      context({ workflowId: "", projectId: legacyProjectId }),
      { command: "legacy" }
    );
    expect(legacy.controlled).toBe(false);
  });

  test("the production bridge also rejects connector and MCP dispatch before invocation", async () => {
    for (const name of ["fetch_klines", "call_mcp", "factor.compute"]) {
      const response = await primeBridgeRouter.request("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "legacy.tools.invoke",
          params: { workspace_id: `wf_${workflowId}`, name, args: {} },
        }),
      });
      expect(await response.text()).toContain("research_tool_not_allowed");
    }
  });
});

describe("service entry points inherit and account for research", () => {
  test("factor compute inherits data; mismatches and provider bypasses remain failed attempts", async () => {
    const result = await factorService.compute({
      factorId,
      startDate: protocol.development.startDate,
      endDate: protocol.development.endDate,
    });
    expect(result.rows.length).toBeGreaterThan(0);
    expect((result.meta.dataIntegrity as { datasetSnapshotId: string }).datasetSnapshotId).toBe(
      snapshotId
    );
    for (const override of [{ startDate: "2026-02-01" }, { providerKey: "python_inline" }]) {
      await expect(
        factorService.compute({
          factorId,
          startDate: protocol.development.startDate,
          endDate: protocol.development.endDate,
          ...override,
        })
      ).rejects.toThrow();
    }
    const detail = await researchProgramService.get(projectId);
    expect(detail.attempts.filter((attempt) => attempt.status === "failed").length).toBe(2);
    expect(
      detail.attempts.some(
        (attempt) => attempt.kind === "factor_compute" && attempt.status === "completed"
      )
    ).toBe(true);
  });

  test("server evaluation consumes one attempt despite its nested computation; raw rows cannot certify", async () => {
    const before = (await researchProgramService.get(projectId)).program?.usedAttempts ?? 0;
    const result = await factorService.autoEvaluate({
      factorId,
      startDate: protocol.development.startDate,
      endDate: protocol.development.endDate,
    });
    expect(result.meta.horizonDays).toBe(1);
    expect(result.meta.datasetSnapshotId).toBe(snapshotId);
    expect((await researchProgramService.get(projectId)).program?.usedAttempts).toBe(before + 1);
    await expect(
      factorService.evaluate({ factorId, values: [], datasetSnapshotId: snapshotId })
    ).rejects.toThrow("server_generated_evaluation");
    await expect(factorService.loadValues({ factorId, startDate: "2026-02-01" })).rejects.toThrow(
      "context_mismatch"
    );
    await expect(
      factorService.checkDataIntegrity({ factorId, ...protocol.development, endDate: "2026-03-31" })
    ).rejects.toThrow("context_mismatch");
  });

  test("an empty finite signal is a failed experiment, not a successful computation", async () => {
    const empty = await factorService.register({
      projectId,
      name: `empty-${randomUUID()}`,
      category: "momentum",
      expr: "Ref(close, 9999)",
      lang: "qlib_expr",
    });
    await expect(
      factorService.compute({
        factorId: empty.id,
        startDate: protocol.development.startDate,
        endDate: protocol.development.endDate,
      })
    ).rejects.toThrow("no_finite_factor_values");
    const attempt = (await researchProgramService.get(projectId)).attempts.find(
      (item) => item.candidateId === empty.id
    );
    expect(attempt?.status).toBe("failed");
  });

  test("backtest submits one pending experiment, then completes only after real execution", async () => {
    const input = {
      strategyVersionId,
      ...protocol.development,
      idempotencyKey: randomUUID(),
      signals: {
        kind: "factor_score" as const,
        factorId,
        expr: "close / Ref(close, 1) - 1",
        lang: "qlib_expr" as const,
      },
    };
    const [first, retry] = await Promise.all([
      backtestJobService.submit(input),
      backtestJobService.submit(input),
    ]);
    expect(first.id).toBe(retry.id);
    expect(first.config.researchAttemptId).toBeTruthy();
    const attemptId = first.config.researchAttemptId;
    if (!attemptId) throw new Error("missing_attempt");
    expect((await researchProgramService.getAttempt(attemptId)).status).toBe("pending");
    const completed = await backtestJobService.run(first.id);
    expect(completed.status).toBe("completed");
    expect((await researchProgramService.getAttempt(attemptId)).status).toBe("completed");
    await expect(backtestJobService.run(first.id)).rejects.toThrow("not_pending");
    await expect(
      finalHoldoutEvaluationService.run(first.id, {
        trainEnd: input.endDate,
        holdoutStart: "2026-03-10",
        holdoutEnd: "2026-03-31",
      })
    ).rejects.toThrow("requires_sealed_evaluator");
  });

  test("backtest validation failure stays in the ledger and cancelled jobs cannot run", async () => {
    const input = {
      strategyVersionId,
      ...protocol.development,
      signals: { kind: "factor_score" as const, expr: "close", lang: "qlib_expr" as const },
    };
    await expect(
      backtestJobService.submit({ ...input, providerKey: "sma_legacy" })
    ).rejects.toThrow("builtin_event_driven");
    const job = await backtestJobService.submit(input);
    const attemptId = job.config.researchAttemptId;
    if (!attemptId) throw new Error("missing_attempt");
    await researchProgramService.cancel(attemptId);
    await expect(backtestJobService.run(job.id)).rejects.toThrow("not_pending");
    expect((await researchProgramService.getAttempt(attemptId)).status).toBe("cancelled");
    expect((await backtestJobService.get(job.id)).status).toBe("failed");
  });

  test("inline and composite future signals fail before a backtest job can be created", async () => {
    const before = await backtestJobService.list({ strategyVersionId });
    const signals = [
      { kind: "factor_score" as const, expr: "Ref(close, -1)", lang: "qlib_expr" as const },
      {
        kind: "factor_composite" as const,
        factors: [
          { factorId, expr: "close", lang: "qlib_expr" as const, weight: 0.5 },
          { factorId, expr: "Ref(close, -1)", lang: "qlib_expr" as const, weight: 0.5 },
        ],
      },
    ];
    for (const signal of signals) {
      const key = randomUUID();
      await expect(
        backtestJobService.submit({
          strategyVersionId,
          ...protocol.development,
          signals: signal,
          idempotencyKey: key,
        })
      ).rejects.toThrow("signal_data_integrity_failed");
      const attempt = (await researchProgramService.get(projectId)).attempts.find(
        (item) => item.idempotencyKey === key
      );
      expect(attempt?.status).toBe("failed");
    }
    expect(await backtestJobService.list({ strategyVersionId })).toHaveLength(before.length);
  });
});
