/**
 * RuleService — 规则层薄编排服务
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.2
 *
 * 职责：
 *   - 规则 CRUD（落 SQLite `rule_definition`）
 *   - 注册时调 Provider.parse 做语法校验
 *   - 执行时调 Provider.evaluate；输出与采样大小写入 rule_evaluation_log 留痕
 *
 * 强制约束：不直接 import jsonlogic / python；统一从 ProviderResolver 拿。
 */

import { randomUUID, createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  ruleDefinition as ruleDefTable,
  ruleEvaluationLog as ruleLogTable,
} from "../../db/sqlite/schema";
import { providerResolver } from "../provider/resolver";
import type {
  ProviderScope,
  RuleEngineProvider,
  RuleEvalContext,
  RuleEvalResult,
} from "../provider/types";

// ─── 类型 ───────────────────────────────────────────────────────────────────

export type RuleAppliesTo = "select" | "filter" | "score" | "order" | "risk";
export type RuleLang = "jsonlogic" | "python";
export type RuleStatus = "draft" | "active" | "archived";

export interface RuleRegisterInput {
  projectId: string;
  name: string;
  description?: string;
  appliesTo?: RuleAppliesTo;
  lang?: RuleLang;
  dsl: unknown;
  status?: RuleStatus;
  providerKey?: string;
}

export interface RuleRecord {
  id: string;
  projectId: string;
  name: string;
  description: string;
  appliesTo: RuleAppliesTo;
  lang: RuleLang;
  dsl: unknown;
  status: RuleStatus;
  providerKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuleEvaluateInput {
  ruleId: string;
  context: RuleEvalContext;
  /** 显式指定 Provider */
  providerKey?: string;
  scope?: ProviderScope;
}

export class RuleServiceError extends Error {
  constructor(
    public code:
      | "rule_not_found"
      | "validation_failed"
      | "provider_failed"
      | "parse_failed"
      | "duplicate_name",
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "RuleServiceError";
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class RuleService {
  async register(input: RuleRegisterInput): Promise<RuleRecord> {
    if (!input.name?.trim()) throw new RuleServiceError("validation_failed", "name_required");
    if (input.dsl === undefined || input.dsl === null) {
      throw new RuleServiceError("validation_failed", "dsl_required");
    }

    const lang: RuleLang = input.lang ?? "jsonlogic";
    const providerKey = input.providerKey ?? lang;
    const appliesTo: RuleAppliesTo = input.appliesTo ?? "score";

    const db = await getDb();
    const dup = await db
      .select({ id: ruleDefTable.id })
      .from(ruleDefTable)
      .where(and(eq(ruleDefTable.projectId, input.projectId), eq(ruleDefTable.name, input.name)))
      .limit(1);
    if (dup[0]) {
      throw new RuleServiceError("duplicate_name", `rule_name_already_exists: ${input.name}`);
    }

    // Provider.parse 强制：解析失败 → 拒绝注册（避免脏数据）
    const provider = await this.resolveProvider(providerKey, {});
    const parsed = await provider.parse(input.dsl, lang);
    if (!parsed.ok) {
      throw new RuleServiceError(
        "parse_failed",
        `dsl_parse_failed: ${parsed.error ?? "unknown"}`,
        { ruleName: input.name }
      );
    }

    const id = randomUUID();
    await db.insert(ruleDefTable).values({
      id,
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? "",
      appliesTo,
      lang,
      dslJson: input.dsl as never,
      status: input.status ?? "draft",
      providerKey,
    });
    return this.get(id);
  }

  async get(id: string): Promise<RuleRecord> {
    const db = await getDb();
    const rows = await db.select().from(ruleDefTable).where(eq(ruleDefTable.id, id)).limit(1);
    const r = rows[0];
    if (!r) throw new RuleServiceError("rule_not_found", `rule_not_found: ${id}`);
    return this.rowToRecord(r);
  }

  async list(
    filter: {
      projectId?: string;
      appliesTo?: RuleAppliesTo;
      status?: RuleStatus;
    } = {}
  ): Promise<RuleRecord[]> {
    const db = await getDb();
    const conds = [];
    if (filter.projectId) conds.push(eq(ruleDefTable.projectId, filter.projectId));
    if (filter.appliesTo) conds.push(eq(ruleDefTable.appliesTo, filter.appliesTo));
    if (filter.status) conds.push(eq(ruleDefTable.status, filter.status));
    const rows = conds.length
      ? await db
          .select()
          .from(ruleDefTable)
          .where(and(...conds))
          .orderBy(desc(ruleDefTable.createdAt))
      : await db.select().from(ruleDefTable).orderBy(desc(ruleDefTable.createdAt));
    return rows.map((r) => this.rowToRecord(r));
  }

  async setStatus(id: string, status: RuleStatus): Promise<void> {
    const db = await getDb();
    await db
      .update(ruleDefTable)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(ruleDefTable.id, id));
  }

  async evaluate(input: RuleEvaluateInput): Promise<RuleEvalResult & { evaluationId: string }> {
    const r = await this.get(input.ruleId);
    const provider = await this.resolveProvider(r.providerKey, input.scope ?? {}, input.providerKey);

    let result: RuleEvalResult;
    try {
      result = await provider.evaluate(
        { id: r.id, lang: r.lang, appliesTo: r.appliesTo, dsl: r.dsl },
        input.context
      );
    } catch (e) {
      throw new RuleServiceError(
        "provider_failed",
        `rule_evaluate_failed: ${(e as Error).message}`,
        { ruleId: r.id }
      );
    }

    const db = await getDb();
    const evaluationId = randomUUID();
    const inputHash = createHash("sha1")
      .update(JSON.stringify(input.context.factorContext ?? {}))
      .digest("hex")
      .slice(0, 16);
    await db.insert(ruleLogTable).values({
      id: evaluationId,
      ruleId: r.id,
      asof: input.context.asof,
      inputHash,
      outputJson: { symbols: result.symbols } as never,
      sampleSize: result.metrics.sampleSize,
      latencyMs: result.metrics.latencyMs,
      error: result.error ?? null,
    });

    return { ...result, evaluationId };
  }

  /** 查某规则历史评估日志 */
  async listEvaluationLogs(ruleId: string, limit = 50) {
    const db = await getDb();
    return db
      .select()
      .from(ruleLogTable)
      .where(eq(ruleLogTable.ruleId, ruleId))
      .orderBy(desc(ruleLogTable.asof))
      .limit(limit);
  }

  // ── private ──

  private async resolveProvider(
    ruleProviderKey: string,
    scope: ProviderScope,
    explicitKey?: string
  ): Promise<RuleEngineProvider> {
    const key = explicitKey ?? ruleProviderKey;
    return providerResolver.resolve<"rule_engine">("rule_engine", scope, { providerKey: key });
  }

  private rowToRecord(r: typeof ruleDefTable.$inferSelect): RuleRecord {
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      description: r.description,
      appliesTo: r.appliesTo,
      lang: r.lang,
      dsl: r.dslJson,
      status: r.status,
      providerKey: r.providerKey,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

export const ruleService = new RuleService();
