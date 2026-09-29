import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import {
  project,
  researchAttempt,
  researchEvaluationBudget,
  researchProtocol,
  workspace,
} from "../../db/sqlite/schema";
import { ResearchProgramService, researchProgramService as service } from "./service";
import {
  type ResearchProtocolSpec,
  type ReserveResearchAttemptInput,
  researchProtocolSpecSchema,
} from "./types";

const workspaceId = randomUUID();
beforeAll(async () => {
  await runMigrations();
  (await getDb())
    .insert(workspace)
    .values({ id: workspaceId, name: "Research tests", owner: "test" })
    .run();
});

function spec(budget = { maxAttempts: 5, maxEvaluations: 2 }): ResearchProtocolSpec {
  return {
    hypothesis: "Short-horizon momentum has incremental predictive value",
    benchmark: "equal_weight_universe",
    stoppingRule: "Stop at the registered attempt budget",
    development: {
      datasetSnapshotId: "mkt_snapshot_0123456789abcdef01234567",
      symbols: ["AAPL", "MSFT", "NVDA"],
      startDate: "2026-01-01",
      endDate: "2026-06-30",
    },
    evaluation: {
      method: "factor_rank_ic_v1",
      horizonDays: 5,
      groupCount: 3,
      sealedDatasetId: "sealed-us-2026",
    },
    budget,
  };
}

async function createProject(): Promise<string> {
  const id = randomUUID();
  (await getDb())
    .insert(project)
    .values({ id, workspaceId, name: "Research project", marketScope: "US" })
    .run();
  return id;
}

async function createProgram(budget?: ResearchProtocolSpec["budget"]): Promise<string> {
  const projectId = await createProject();
  await service.createProtocol({ projectId, spec: spec(budget) });
  return projectId;
}

function request(projectId: string, key = randomUUID()): ReserveResearchAttemptInput {
  return {
    projectId,
    kind: "factor_compute",
    candidateId: "momentum-v1",
    candidateJson: { expr: "$close / Ref($close, 5)" },
    requestJson: { symbols: ["AAPL", "MSFT", "NVDA"] },
    idempotencyKey: key,
  };
}

describe("durable research protocols and attempts", () => {
  test("missing program has a stable empty overview", async () => {
    expect(await service.get(await createProject())).toEqual({
      program: null,
      protocols: [],
      attempts: [],
    });
  });

  test("protocol schema rejects impossible dates, duplicate symbols and unknown fields", () => {
    const original = spec();
    expect(researchProtocolSpecSchema.safeParse({ ...original, extra: true }).success).toBe(false);
    expect(
      researchProtocolSpecSchema.safeParse({
        ...original,
        development: { ...original.development, startDate: "2026-02-30" },
      }).success
    ).toBe(false);
    expect(
      researchProtocolSpecSchema.safeParse({
        ...original,
        development: { ...original.development, startDate: "2026-07-01" },
      }).success
    ).toBe(false);
    expect(
      researchProtocolSpecSchema.safeParse({
        ...original,
        development: { ...original.development, symbols: ["AAPL", "aapl", "MSFT"] },
      }).success
    ).toBe(false);
    expect(
      researchProtocolSpecSchema.safeParse({
        ...original,
        budget: { maxAttempts: 1, maxEvaluations: 2 },
      }).success
    ).toBe(false);
  });

  test("parallel reservations cannot exceed the shared attempt budget", async () => {
    const projectId = await createProgram({ maxAttempts: 3, maxEvaluations: 0 });
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () => service.reserve(request(projectId)))
    );
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(3);
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(9);
    const overview = await service.get(projectId);
    expect(overview.program?.usedAttempts).toBe(3);
    expect(overview.attempts).toHaveLength(3);
  });

  test("parallel idempotent retries reserve once and reject changed candidate or request", async () => {
    const projectId = await createProgram({ maxAttempts: 1, maxEvaluations: 0 });
    const input = request(projectId);
    const attempts = await Promise.all(Array.from({ length: 8 }, () => service.reserve(input)));
    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(1);
    expect((await service.get(projectId)).program?.usedAttempts).toBe(1);
    await expect(service.reserve({ ...input, candidateId: "renamed" })).rejects.toThrow(
      "research_idempotency_conflict"
    );
    await expect(service.reserve({ ...input, requestJson: { symbols: ["AAPL"] } })).rejects.toThrow(
      "research_idempotency_conflict"
    );
  });

  test("candidate and request snapshots detach from mutable caller input", async () => {
    const projectId = await createProgram();
    const input = request(projectId);
    const reserved = await service.reserve(input);
    input.candidateJson.expr = "$volume";
    reserved.requestJson.symbols = [];
    const stored = await service.getAttempt(reserved.id);
    expect(stored.candidateJson.expr).toBe("$close / Ref($close, 5)");
    expect(stored.requestJson.symbols).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  test("new protocol versions preserve old evidence, budgets and idempotent retries", async () => {
    const projectId = await createProgram();
    const input = request(projectId);
    const reserved = await service.reserve(input);
    await expect(service.createProtocol({ projectId, spec: spec() })).rejects.toThrow(
      "research_protocol_has_active_attempts"
    );
    await service.claim(reserved.id);
    await service.finish(reserved.id, { status: "failed", error: "no predictive value" });
    const next = await service.createProtocol({
      projectId,
      spec: { ...spec(), hypothesis: "A revised mechanism" },
    });
    expect(next.version).toBe(2);
    expect((await service.getProtocol(reserved.protocolId)).spec.hypothesis).toBe(
      spec().hypothesis
    );
    expect((await service.get(projectId)).program?.usedAttempts).toBe(1);
    expect((await service.reserve(input)).id).toBe(reserved.id);
    await expect(
      service.reserve({ ...request(projectId), protocolId: reserved.protocolId })
    ).rejects.toThrow("research_protocol_not_active");
    await expect(
      service.createProtocol({ projectId, spec: spec({ maxAttempts: 6, maxEvaluations: 2 }) })
    ).rejects.toThrow("research_budget_immutable");
    expect((await service.get(projectId)).protocols).toHaveLength(2);
  });

  test("only one caller claims a pending attempt and cancellation rejects late completion", async () => {
    const projectId = await createProgram();
    const attempt = await service.reserve(request(projectId));
    const claims = await Promise.all(Array.from({ length: 8 }, () => service.claim(attempt.id)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await service.cancel(attempt.id);
    const late = await service.finish(attempt.id, {
      status: "completed",
      resultJson: { score: 1 },
    });
    expect(late.status).toBe("cancelled");
    expect(late.resultJson).toBeNull();
    expect((await service.get(projectId)).program?.usedAttempts).toBe(1);
  });

  test("cancelled pending work cannot run or refund a search attempt", async () => {
    const projectId = await createProgram({ maxAttempts: 1, maxEvaluations: 0 });
    const attempt = await service.reserve(request(projectId));
    expect((await service.cancel(attempt.id)).status).toBe("cancelled");
    expect(await service.claim(attempt.id)).toBeNull();
    await expect(service.reserve(request(projectId))).rejects.toThrow(
      "research_attempt_budget_exhausted"
    );
  });

  test("recovery after a new service instance retains expired pending and running work", async () => {
    const projectId = await createProgram();
    const pending = await service.reserve(request(projectId));
    const running = await service.reserve(request(projectId));
    await service.claim(running.id);
    const db = await getDb();
    for (const attempt of [pending, running]) {
      db.update(researchAttempt)
        .set({ deadlineAt: "2020-01-01T00:00:00.000Z" })
        .where(eq(researchAttempt.id, attempt.id))
        .run();
    }
    const restored = new ResearchProgramService();
    expect(await restored.recoverExpired()).toBe(2);
    expect(await restored.recoverExpired()).toBe(0);
    expect((await restored.getAttempt(pending.id)).status).toBe("timed_out");
    expect(
      (await restored.finish(running.id, { status: "completed", resultJson: { score: 1 } })).status
    ).toBe("timed_out");
    expect((await restored.get(projectId)).program?.usedAttempts).toBe(2);
  });

  test("finish enforces the persisted deadline even before the recovery sweep", async () => {
    const projectId = await createProgram();
    const attempt = await service.reserve(request(projectId));
    await service.claim(attempt.id);
    (await getDb())
      .update(researchAttempt)
      .set({ deadlineAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(researchAttempt.id, attempt.id))
      .run();
    const finished = await service.finish(attempt.id, {
      status: "completed",
      resultJson: { score: 1 },
    });
    expect(finished.status).toBe("timed_out");
    expect(finished.resultJson).toBeNull();
  });

  test("ordinary reads after restart expire abandoned attempts without a background timer", async () => {
    const projectId = await createProgram();
    const first = await service.reserve(request(projectId));
    const second = await service.reserve(request(projectId));
    const db = await getDb();
    db.update(researchAttempt)
      .set({ deadlineAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(researchAttempt.id, first.id))
      .run();
    const restarted = new ResearchProgramService();
    expect((await restarted.getAttempt(first.id)).status).toBe("timed_out");
    db.update(researchAttempt)
      .set({ deadlineAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(researchAttempt.id, second.id))
      .run();
    const overview = await restarted.get(projectId);
    expect(overview.attempts.every((attempt) => attempt.status === "timed_out")).toBe(true);
    expect(overview.program?.usedAttempts).toBe(2);
  });

  test("pausing blocks new work while keeping old evidence readable", async () => {
    const projectId = await createProgram();
    const input = request(projectId);
    const pending = await service.reserve(input);
    await service.setStatus(projectId, "paused");
    await expect(service.reserve(request(projectId))).rejects.toThrow("research_program_paused");
    expect((await service.reserve(input)).id).toBe(pending.id);
    expect(await service.claim(pending.id)).toBeNull();
    await service.setStatus(projectId, "active");
    expect((await service.claim(pending.id))?.status).toBe("running");
  });

  test("sealed evaluations share one immutable dataset allowance across projects", async () => {
    const firstProject = await createProgram();
    const secondProject = await createProgram();
    const key = `sealed-budget-${randomUUID()}`;
    const first = {
      ...request(firstProject),
      kind: "sealed_factor" as const,
      evaluationBudget: { key, limit: 1 },
    };
    const second = {
      ...request(secondProject),
      kind: "sealed_factor" as const,
      evaluationBudget: { key, limit: 1 },
    };
    const results = await Promise.allSettled([service.reserve(first), service.reserve(second)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const success = results.find((result) => result.status === "fulfilled");
    if (!success || success.status !== "fulfilled") throw new Error("missing_reserved_attempt");
    await service.cancel(success.value.id);
    const other = success.value.projectId === firstProject ? second : first;
    await expect(service.reserve(other)).rejects.toThrow("research_global_budget_exhausted");
    await expect(
      service.reserve({ ...other, evaluationBudget: { key, limit: 2 } })
    ).rejects.toThrow("research_global_budget_immutable");
    expect((await service.get(success.value.projectId)).program?.usedEvaluations).toBe(1);
    expect((await service.get(other.projectId)).program?.usedAttempts).toBe(0);
    expect(
      (await getDb())
        .select()
        .from(researchEvaluationBudget)
        .where(eq(researchEvaluationBudget.key, key))
        .get()?.used
    ).toBe(1);
  });

  test("sealed work consumes both budgets but development evaluations consume only attempt budget", async () => {
    const projectId = await createProgram({ maxAttempts: 3, maxEvaluations: 1 });
    await service.reserve({ ...request(projectId), kind: "factor_evaluate" });
    await service.reserve({
      ...request(projectId),
      kind: "sealed_factor",
      evaluationBudget: { key: randomUUID(), limit: 10 },
    });
    expect((await service.get(projectId)).program).toMatchObject({
      usedAttempts: 2,
      usedEvaluations: 1,
    });
    await expect(
      service.reserve({
        ...request(projectId),
        kind: "sealed_factor",
        evaluationBudget: { key: randomUUID(), limit: 10 },
      })
    ).rejects.toThrow("research_evaluation_budget_exhausted");
  });

  test("protocol history is immutable and project deletion cannot erase its budgets", async () => {
    const projectId = await createProgram();
    const overview = await service.get(projectId);
    const protocol = overview.protocols[0];
    if (!protocol) throw new Error("missing_protocol");
    const db = await getDb();
    expect(() =>
      db
        .update(researchProtocol)
        .set({ fingerprint: "changed" })
        .where(eq(researchProtocol.id, protocol.id))
        .run()
    ).toThrow("research_protocol_is_immutable");
    expect(() =>
      db.delete(researchProtocol).where(eq(researchProtocol.id, protocol.id)).run()
    ).toThrow("research_protocol_history_is_retained");
    expect(() => db.delete(project).where(eq(project.id, projectId)).run()).toThrow();
  });
});
