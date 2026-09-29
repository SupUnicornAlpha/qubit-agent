import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import {
  project,
  researchAttempt,
  researchEvaluationBudget,
  researchProgram,
  researchProtocol,
} from "../../db/sqlite/schema";
import {
  type ResearchAttempt,
  type ResearchProgram,
  type ResearchProgramDetail,
  ResearchProgramError,
  type ResearchProgramStatus,
  type ResearchProtocol,
  type ResearchProtocolSpec,
  type ReserveResearchAttemptInput,
  researchProtocolSpecSchema,
} from "./types";

export const RESEARCH_ATTEMPT_TIMEOUT_MS = 120_000;
const openStatuses = ["pending", "running"] as const;
const kinds = new Set(["factor_compute", "factor_evaluate", "backtest", "sealed_factor"]);
type ReadDb = Pick<DbClient, "select">;

function identifier(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    throw new ResearchProgramError("research_input_invalid", 400, `${field}_invalid`);
  }
  return value.trim();
}

/** Fingerprints ignore key order, but never silently coerce non-finite or non-JSON values. */
function canonicalJson(value: unknown, seen = new Set<object>(), depth = 0): string {
  if (depth > 64) throw new ResearchProgramError("research_json_invalid", 400);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw new ResearchProgramError("research_json_invalid", 400);
  }
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonicalJson(item, seen, depth + 1)).join(",")}]`;
  } else {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new ResearchProgramError("research_json_invalid", 400);
    }
    const record = value as Record<string, unknown>;
    result = `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen, depth + 1)}`)
      .join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function jsonObject(value: Record<string, unknown>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchProgramError("research_json_object_required", 400);
  }
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
}

function toProtocol(row: typeof researchProtocol.$inferSelect): ResearchProtocol {
  return {
    id: row.id,
    projectId: row.projectId,
    version: row.version,
    fingerprint: row.fingerprint,
    spec: researchProtocolSpecSchema.parse(row.specJson),
    createdAt: row.createdAt,
  };
}

function toAttempt(row: typeof researchAttempt.$inferSelect): ResearchAttempt {
  return {
    ...row,
    candidateJson: row.candidateJson as Record<string, unknown>,
    requestJson: row.requestJson as Record<string, unknown>,
  };
}

function requireAttempt(db: ReadDb, id: string): typeof researchAttempt.$inferSelect {
  const row = db.select().from(researchAttempt).where(eq(researchAttempt.id, id)).get();
  if (!row) throw new ResearchProgramError("research_attempt_not_found", 404);
  return row;
}

function requireProgram(db: ReadDb, projectId: string): typeof researchProgram.$inferSelect {
  const row = db
    .select()
    .from(researchProgram)
    .where(eq(researchProgram.projectId, projectId))
    .get();
  if (!row) throw new ResearchProgramError("research_program_not_found", 404);
  return row;
}

export class ResearchProgramService {
  async createProtocol(input: {
    projectId: string;
    spec: ResearchProtocolSpec;
  }): Promise<ResearchProtocol> {
    const projectId = identifier(input.projectId, "project_id");
    const parsed = researchProtocolSpecSchema.safeParse(input.spec);
    if (!parsed.success) {
      throw new ResearchProgramError("research_protocol_invalid", 400, parsed.error.message);
    }
    const spec = parsed.data;
    await this.recoverExpired();
    const db = await getDb();
    // Bun SQLite transactions are synchronous. No async callback or await is
    // permitted inside this block: quota and history changes commit together.
    return db.transaction(
      (tx) => {
        if (!tx.select({ id: project.id }).from(project).where(eq(project.id, projectId)).get()) {
          throw new ResearchProgramError("project_not_found", 404);
        }
        const program = tx
          .select()
          .from(researchProgram)
          .where(eq(researchProgram.projectId, projectId))
          .get();
        if (
          program &&
          (program.maxAttempts !== spec.budget.maxAttempts ||
            program.maxEvaluations !== spec.budget.maxEvaluations)
        ) {
          throw new ResearchProgramError("research_budget_immutable", 409);
        }
        const busy = tx
          .select({ id: researchAttempt.id })
          .from(researchAttempt)
          .where(
            and(
              eq(researchAttempt.projectId, projectId),
              inArray(researchAttempt.status, [...openStatuses])
            )
          )
          .limit(1)
          .get();
        if (busy) throw new ResearchProgramError("research_protocol_has_active_attempts", 409);
        const latest = tx
          .select({ version: researchProtocol.version })
          .from(researchProtocol)
          .where(eq(researchProtocol.projectId, projectId))
          .orderBy(desc(researchProtocol.version))
          .limit(1)
          .get();
        const now = new Date().toISOString();
        const protocol: ResearchProtocol = {
          id: randomUUID(),
          projectId,
          version: (latest?.version ?? 0) + 1,
          fingerprint: digest(spec),
          spec,
          createdAt: now,
        };
        tx.insert(researchProtocol)
          .values({
            id: protocol.id,
            projectId,
            version: protocol.version,
            fingerprint: protocol.fingerprint,
            specJson: spec,
            createdAt: now,
          })
          .run();
        if (program) {
          tx.update(researchProgram)
            .set({ activeProtocolId: protocol.id, updatedAt: now })
            .where(eq(researchProgram.projectId, projectId))
            .run();
        } else {
          tx.insert(researchProgram)
            .values({
              projectId,
              activeProtocolId: protocol.id,
              status: "active",
              ...spec.budget,
              usedAttempts: 0,
              usedEvaluations: 0,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
        return protocol;
      },
      { behavior: "immediate" }
    );
  }

  async get(projectId: string): Promise<ResearchProgramDetail> {
    await this.recoverExpired();
    const db = await getDb();
    return db.transaction((tx) => {
      const program = tx
        .select()
        .from(researchProgram)
        .where(eq(researchProgram.projectId, projectId))
        .get();
      if (!program) return { program: null, protocols: [], attempts: [] };
      return {
        program,
        protocols: tx
          .select()
          .from(researchProtocol)
          .where(eq(researchProtocol.projectId, projectId))
          .orderBy(asc(researchProtocol.version))
          .all()
          .map(toProtocol),
        attempts: tx
          .select()
          .from(researchAttempt)
          .where(eq(researchAttempt.projectId, projectId))
          .orderBy(desc(researchAttempt.createdAt), desc(researchAttempt.id))
          .all()
          .map(toAttempt),
      };
    });
  }

  async getProtocol(id: string): Promise<ResearchProtocol> {
    const db = await getDb();
    const row = db.select().from(researchProtocol).where(eq(researchProtocol.id, id)).get();
    if (!row) throw new ResearchProgramError("research_protocol_not_found", 404);
    return toProtocol(row);
  }

  async setStatus(projectId: string, status: ResearchProgramStatus): Promise<ResearchProgram> {
    if (status !== "active" && status !== "paused")
      throw new ResearchProgramError("research_status_invalid", 400);
    const db = await getDb();
    return db.transaction(
      (tx) => {
        requireProgram(tx, projectId);
        tx.update(researchProgram)
          .set({ status, updatedAt: new Date().toISOString() })
          .where(eq(researchProgram.projectId, projectId))
          .run();
        return requireProgram(tx, projectId);
      },
      { behavior: "immediate" }
    );
  }

  async reserve(input: ReserveResearchAttemptInput): Promise<ResearchAttempt> {
    const projectId = identifier(input.projectId, "project_id");
    const candidateId = identifier(input.candidateId, "candidate_id");
    const idempotencyKey = identifier(input.idempotencyKey, "idempotency_key");
    const candidateJson = jsonObject(input.candidateJson);
    const requestJson = jsonObject(input.requestJson);
    if (!kinds.has(input.kind))
      throw new ResearchProgramError("research_attempt_kind_invalid", 400);
    const sealed = input.kind === "sealed_factor";
    if (sealed !== Boolean(input.evaluationBudget)) {
      throw new ResearchProgramError("research_evaluation_budget_required", 400);
    }
    const evaluationBudget = input.evaluationBudget
      ? {
          key: identifier(input.evaluationBudget.key, "evaluation_budget_key"),
          limit: input.evaluationBudget.limit,
        }
      : null;
    if (
      evaluationBudget &&
      (!Number.isInteger(evaluationBudget.limit) ||
        evaluationBudget.limit < 1 ||
        evaluationBudget.limit > 100_000)
    ) {
      throw new ResearchProgramError("research_evaluation_budget_invalid", 400);
    }
    const db = await getDb();
    return db.transaction(
      (tx) => {
        const program = requireProgram(tx, projectId);
        const existing = tx
          .select()
          .from(researchAttempt)
          .where(
            and(
              eq(researchAttempt.projectId, projectId),
              eq(researchAttempt.idempotencyKey, idempotencyKey)
            )
          )
          .get();
        // A retry without an explicit protocol ID still belongs to its original
        // protocol, even after the project activates a later immutable version.
        const protocolId = input.protocolId ?? existing?.protocolId ?? program.activeProtocolId;
        const requestFingerprint = digest({
          protocolId,
          kind: input.kind,
          candidateId,
          candidateJson,
          requestJson,
          evaluationBudget,
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new ResearchProgramError("research_idempotency_conflict", 409);
          return toAttempt(existing);
        }
        if (program.status !== "active")
          throw new ResearchProgramError("research_program_paused", 409);
        if (protocolId !== program.activeProtocolId)
          throw new ResearchProgramError("research_protocol_not_active", 409);
        const protocol = tx
          .select()
          .from(researchProtocol)
          .where(eq(researchProtocol.id, protocolId))
          .get();
        if (!protocol || protocol.projectId !== projectId)
          throw new ResearchProgramError("research_protocol_not_found", 404);
        if (sealed && !toProtocol(protocol).spec.evaluation.sealedDatasetId) {
          throw new ResearchProgramError("research_sealed_dataset_not_configured", 409);
        }
        if (program.usedAttempts >= program.maxAttempts)
          throw new ResearchProgramError("research_attempt_budget_exhausted", 409);
        if (sealed && program.usedEvaluations >= program.maxEvaluations)
          throw new ResearchProgramError("research_evaluation_budget_exhausted", 409);
        if (evaluationBudget) {
          const quota = tx
            .select()
            .from(researchEvaluationBudget)
            .where(eq(researchEvaluationBudget.key, evaluationBudget.key))
            .get();
          if (quota && quota.limit !== evaluationBudget.limit)
            throw new ResearchProgramError("research_global_budget_immutable", 409);
          if (quota && quota.used >= quota.limit)
            throw new ResearchProgramError("research_global_budget_exhausted", 409);
          if (!quota)
            tx.insert(researchEvaluationBudget)
              .values({ key: evaluationBudget.key, limit: evaluationBudget.limit, used: 0 })
              .run();
          tx.update(researchEvaluationBudget)
            .set({ used: sql`${researchEvaluationBudget.used} + 1` })
            .where(eq(researchEvaluationBudget.key, evaluationBudget.key))
            .run();
        }
        const now = new Date();
        const id = randomUUID();
        tx.update(researchProgram)
          .set({
            usedAttempts: program.usedAttempts + 1,
            usedEvaluations: program.usedEvaluations + (sealed ? 1 : 0),
            updatedAt: now.toISOString(),
          })
          .where(eq(researchProgram.projectId, projectId))
          .run();
        tx.insert(researchAttempt)
          .values({
            id,
            projectId,
            protocolId,
            kind: input.kind,
            candidateId,
            candidateJson,
            requestJson,
            requestFingerprint,
            idempotencyKey,
            evaluationBudgetKey: evaluationBudget?.key ?? null,
            status: "pending",
            resultJson: null,
            error: null,
            createdAt: now.toISOString(),
            startedAt: null,
            endedAt: null,
            deadlineAt: new Date(now.getTime() + RESEARCH_ATTEMPT_TIMEOUT_MS).toISOString(),
          })
          .run();
        return toAttempt(requireAttempt(tx, id));
      },
      { behavior: "immediate" }
    );
  }

  async getAttempt(id: string): Promise<ResearchAttempt> {
    await this.recoverExpired();
    return toAttempt(requireAttempt(await getDb(), id));
  }

  async claim(id: string): Promise<ResearchAttempt | null> {
    const db = await getDb();
    return db.transaction(
      (tx) => {
        const attempt = requireAttempt(tx, id);
        if (attempt.status !== "pending") return null;
        const now = new Date().toISOString();
        if (attempt.deadlineAt <= now) {
          tx.update(researchAttempt)
            .set({ status: "timed_out", endedAt: now, error: "research_attempt_deadline_exceeded" })
            .where(and(eq(researchAttempt.id, id), eq(researchAttempt.status, "pending")))
            .run();
          return null;
        }
        if (requireProgram(tx, attempt.projectId).status !== "active") return null;
        const claimed = tx
          .update(researchAttempt)
          .set({ status: "running", startedAt: now })
          .where(and(eq(researchAttempt.id, id), eq(researchAttempt.status, "pending")))
          .returning({ id: researchAttempt.id })
          .all();
        return claimed.length === 1 ? toAttempt(requireAttempt(tx, id)) : null;
      },
      { behavior: "immediate" }
    );
  }

  async finish(
    id: string,
    input: { status: "completed" | "failed" | "timed_out"; resultJson?: unknown; error?: string }
  ): Promise<ResearchAttempt> {
    if (!["completed", "failed", "timed_out"].includes(input.status))
      throw new ResearchProgramError("research_attempt_status_invalid", 400);
    const resultJson =
      input.resultJson === undefined ? null : JSON.parse(canonicalJson(input.resultJson));
    const db = await getDb();
    return db.transaction(
      (tx) => {
        const attempt = requireAttempt(tx, id);
        if (attempt.status !== "running") return toAttempt(attempt);
        const now = new Date().toISOString();
        const expired = attempt.deadlineAt <= now;
        tx.update(researchAttempt)
          .set({
            status: expired ? "timed_out" : input.status,
            resultJson: expired ? null : resultJson,
            error: expired ? "research_attempt_deadline_exceeded" : (input.error ?? null),
            endedAt: now,
          })
          .where(and(eq(researchAttempt.id, id), eq(researchAttempt.status, "running")))
          .run();
        return toAttempt(requireAttempt(tx, id));
      },
      { behavior: "immediate" }
    );
  }

  async cancel(id: string): Promise<ResearchAttempt> {
    const db = await getDb();
    return db.transaction(
      (tx) => {
        requireAttempt(tx, id);
        tx.update(researchAttempt)
          .set({
            status: "cancelled",
            endedAt: new Date().toISOString(),
            error: "research_attempt_cancelled",
          })
          .where(
            and(eq(researchAttempt.id, id), inArray(researchAttempt.status, [...openStatuses]))
          )
          .run();
        return toAttempt(requireAttempt(tx, id));
      },
      { behavior: "immediate" }
    );
  }

  /** Safe after restart: expired work becomes terminal; reservations are never refunded. */
  async recoverExpired(): Promise<number> {
    const db = await getDb();
    const now = new Date().toISOString();
    return db
      .update(researchAttempt)
      .set({ status: "timed_out", endedAt: now, error: "research_attempt_deadline_exceeded" })
      .where(
        and(
          inArray(researchAttempt.status, [...openStatuses]),
          lte(researchAttempt.deadlineAt, now)
        )
      )
      .returning({ id: researchAttempt.id })
      .all().length;
  }
}

export const researchProgramService = new ResearchProgramService();
