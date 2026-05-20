/**
 * StrategyComposer — 把因子 + 规则组装成可执行/可回测的策略组合
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.3
 *
 * 支持三种 kind：
 *   - factor_score：用 N 个 factor 算分（equal / rank_ic / ic_ir / manual 权重），按分排序
 *   - rule        ：用 M 条规则做 select/filter/score（取交集 + 加权）
 *   - hybrid      ：先用 rule 过滤候选池，再用 factor_score 排序
 *
 * P0 阶段不直接调回测，而是产出"组合执行结果"：候选 symbol + 分数 + 解释，
 * 由上层 backtest provider / live ems 接走。
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  strategyComposition as compositionTable,
  strategyVersion as strategyVersionTable,
} from "../../db/sqlite/schema";
import { factorService } from "../factor/factor-service";
import { ruleService } from "../rule/rule-service";
import type { FactorComputeRow, RuleEvalContext } from "../provider/types";

// ─── 类型 ───────────────────────────────────────────────────────────────────

export type StrategyKind = "factor_score" | "rule" | "hybrid" | "script";
export type WeightMethod = "equal" | "rank_ic_weighted" | "ic_ir_weighted" | "manual";

export interface CompositionDefineInput {
  strategyVersionId: string;
  kind: StrategyKind;
  factorIds?: string[];
  ruleIds?: string[];
  weightMethod?: WeightMethod;
  /** manual 模式下的 factor → weight 映射 */
  factorWeights?: Record<string, number>;
  rebalanceFreq?: string;
  universe?: string;
  params?: Record<string, unknown>;
}

export interface CompositionRecord {
  id: string;
  strategyVersionId: string;
  kind: StrategyKind;
  factorIds: string[];
  ruleIds: string[];
  weightMethod: WeightMethod;
  rebalanceFreq: string;
  universe: string;
  params: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CompositionExecuteInput {
  compositionId: string;
  asof: string;
  startDate: string;
  endDate: string;
  symbols?: string[];
  extraContext?: Record<string, unknown>;
}

export interface CompositionPick {
  symbol: string;
  score: number;
  rank: number;
  reasoning: {
    factorContribution: Record<string, number>;
    rulePass: Record<string, boolean>;
  };
}

export interface CompositionExecuteResult {
  compositionId: string;
  kind: StrategyKind;
  picks: CompositionPick[];
  meta: {
    sampleSize: number;
    latencyMs: number;
    universe: string;
    asof: string;
  };
}

export class StrategyComposerError extends Error {
  constructor(
    public code:
      | "composition_not_found"
      | "factor_value_missing"
      | "validation_failed"
      | "execute_failed",
    message: string
  ) {
    super(message);
    this.name = "StrategyComposerError";
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class StrategyComposer {
  /** 定义策略组合（落 SQLite `strategy_composition`） */
  async define(input: CompositionDefineInput): Promise<CompositionRecord> {
    // 必须存在的 strategy_version
    const db = await getDb();
    const sv = await db
      .select()
      .from(strategyVersionTable)
      .where(eq(strategyVersionTable.id, input.strategyVersionId))
      .limit(1);
    if (!sv[0]) {
      throw new StrategyComposerError(
        "validation_failed",
        `strategy_version_not_found: ${input.strategyVersionId}`
      );
    }

    const factorIds = input.factorIds ?? [];
    const ruleIds = input.ruleIds ?? [];
    if (input.kind === "factor_score" && factorIds.length === 0) {
      throw new StrategyComposerError("validation_failed", "factor_score_requires_factor_ids");
    }
    if (input.kind === "rule" && ruleIds.length === 0) {
      throw new StrategyComposerError("validation_failed", "rule_kind_requires_rule_ids");
    }
    if (input.kind === "hybrid" && (factorIds.length === 0 || ruleIds.length === 0)) {
      throw new StrategyComposerError(
        "validation_failed",
        "hybrid_requires_both_factors_and_rules"
      );
    }

    const id = randomUUID();
    await db.insert(compositionTable).values({
      id,
      strategyVersionId: input.strategyVersionId,
      kind: input.kind,
      factorIdsJson: factorIds as never,
      ruleIdsJson: ruleIds as never,
      weightMethod: input.weightMethod ?? "equal",
      rebalanceFreq: input.rebalanceFreq ?? "1d",
      universe: input.universe ?? "CN-A",
      paramsJson: {
        ...(input.params ?? {}),
        ...(input.factorWeights ? { factorWeights: input.factorWeights } : {}),
      } as never,
    });
    return this.get(id);
  }

  async get(id: string): Promise<CompositionRecord> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(compositionTable)
      .where(eq(compositionTable.id, id))
      .limit(1);
    const r = rows[0];
    if (!r) {
      throw new StrategyComposerError("composition_not_found", `composition_not_found: ${id}`);
    }
    return this.rowToRecord(r);
  }

  async listByVersion(strategyVersionId: string): Promise<CompositionRecord[]> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(compositionTable)
      .where(eq(compositionTable.strategyVersionId, strategyVersionId));
    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * 执行组合：拉因子值、跑规则、出 picks
   * 注意：P0 阶段使用 in-memory factor compute；时序持久化留给 P1
   */
  async execute(input: CompositionExecuteInput): Promise<CompositionExecuteResult> {
    const t0 = Date.now();
    const comp = await this.get(input.compositionId);

    // 1. 拉所有因子值 → 按 symbol 聚合成 factorContext
    const factorContext: Record<string, Record<string, number | null>> = {};
    const factorMeta = new Map<string, { name: string; weight: number }>();
    for (const fid of comp.factorIds) {
      const factor = await factorService.get(fid);
      const res = await factorService.compute({
        factorId: fid,
        startDate: input.startDate,
        endDate: input.endDate,
        ...(input.symbols ? { symbols: input.symbols } : {}),
      });
      // 只取最新一行：以 (symbol, max date)
      const latestPerSymbol = pickLatestPerSymbol(res.rows);
      for (const row of latestPerSymbol) {
        factorContext[row.symbol] ??= {};
        factorContext[row.symbol]![factor.name] = row.value;
      }
      factorMeta.set(fid, { name: factor.name, weight: 1 });
    }

    // 用户指定 symbols 即使因子无值也要纳入候选（便于排查）
    if (input.symbols) {
      for (const s of input.symbols) factorContext[s] ??= {};
    }

    // 2. 决定权重
    const weights = this.computeWeights(comp, factorMeta);

    // 3. 跑规则：拿到每个规则的 per-symbol 结果
    const ruleByName = new Map<string, Record<string, { passed: boolean; score?: number }>>();
    for (const rid of comp.ruleIds) {
      const rule = await ruleService.get(rid);
      const ctx: RuleEvalContext = {
        asof: input.asof,
        universe: comp.universe,
        factorContext,
        ...(input.extraContext ? { extraContext: input.extraContext } : {}),
      };
      const result = await ruleService.evaluate({ ruleId: rid, context: ctx });
      const m: Record<string, { passed: boolean; score?: number }> = {};
      for (const s of result.symbols) {
        m[s.symbol] = s.score !== undefined
          ? { passed: s.passed, score: s.score }
          : { passed: s.passed };
      }
      ruleByName.set(rule.name, m);
    }

    // 4. 组装 picks
    const candidates = Object.keys(factorContext);
    const picks: CompositionPick[] = [];
    for (const sym of candidates) {
      const facCtx = factorContext[sym]!;

      // 4.1 过滤
      let passedAllRules = true;
      const rulePass: Record<string, boolean> = {};
      for (const [ruleName, perSym] of ruleByName) {
        const v = perSym[sym] ?? { passed: false };
        rulePass[ruleName] = v.passed;
        if (!v.passed) passedAllRules = false;
      }

      if (comp.kind === "rule" || comp.kind === "hybrid") {
        if (!passedAllRules) continue;
      }

      // 4.2 打分
      let score = 0;
      const factorContribution: Record<string, number> = {};
      if (comp.kind === "factor_score" || comp.kind === "hybrid") {
        for (const fid of comp.factorIds) {
          const meta = factorMeta.get(fid)!;
          const w = weights[fid] ?? 0;
          const v = facCtx[meta.name];
          if (v == null || !Number.isFinite(v)) continue;
          const contrib = v * w;
          factorContribution[meta.name] = contrib;
          score += contrib;
        }
      } else if (comp.kind === "rule") {
        // rule 模式：用规则平均分作为得分（没分则给 1）
        let acc = 0;
        let c = 0;
        for (const perSym of ruleByName.values()) {
          const v = perSym[sym];
          if (v?.score !== undefined) {
            acc += v.score;
            c += 1;
          }
        }
        score = c > 0 ? acc / c : 1;
      }

      picks.push({
        symbol: sym,
        score: Number(score.toFixed(6)),
        rank: 0,
        reasoning: { factorContribution, rulePass },
      });
    }

    // 5. 排序 + 赋 rank
    picks.sort((a, b) => b.score - a.score);
    picks.forEach((p, i) => (p.rank = i + 1));

    return {
      compositionId: comp.id,
      kind: comp.kind,
      picks,
      meta: {
        sampleSize: candidates.length,
        latencyMs: Date.now() - t0,
        universe: comp.universe,
        asof: input.asof,
      },
    };
  }

  // ── private ──

  private computeWeights(
    comp: CompositionRecord,
    factorMeta: Map<string, { name: string; weight: number }>
  ): Record<string, number> {
    const out: Record<string, number> = {};
    const ids = comp.factorIds;
    if (ids.length === 0) return out;

    if (comp.weightMethod === "manual") {
      const manual = (comp.params["factorWeights"] as Record<string, number>) ?? {};
      let total = 0;
      for (const fid of ids) {
        const meta = factorMeta.get(fid);
        const w = (meta && manual[meta.name]) ?? manual[fid] ?? 0;
        out[fid] = w;
        total += Math.abs(w);
      }
      if (total > 0) {
        for (const fid of ids) out[fid] = (out[fid] ?? 0) / total;
      }
      return out;
    }

    // P0 阶段：rank_ic_weighted / ic_ir_weighted 暂回退到 equal（待 P1 接 factor_evaluation 自动权重）
    const equal = 1 / ids.length;
    for (const fid of ids) out[fid] = equal;
    return out;
  }

  private rowToRecord(r: typeof compositionTable.$inferSelect): CompositionRecord {
    return {
      id: r.id,
      strategyVersionId: r.strategyVersionId,
      kind: r.kind,
      factorIds: (r.factorIdsJson as string[]) ?? [],
      ruleIds: (r.ruleIdsJson as string[]) ?? [],
      weightMethod: r.weightMethod,
      rebalanceFreq: r.rebalanceFreq,
      universe: r.universe,
      params: (r.paramsJson as Record<string, unknown>) ?? {},
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

function pickLatestPerSymbol(rows: FactorComputeRow[]): FactorComputeRow[] {
  const best = new Map<string, FactorComputeRow>();
  for (const r of rows) {
    const prev = best.get(r.symbol);
    if (!prev || r.date > prev.date) best.set(r.symbol, r);
  }
  return [...best.values()];
}

// 让上面 `and` import 静音（保留以便后续扩展 listByProject）
void and;

export const strategyComposer = new StrategyComposer();
