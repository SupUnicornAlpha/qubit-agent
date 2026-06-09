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

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  strategy as strategyTable,
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
  /** UI 展示用元信息（migration 0080） */
  name?: string;
  description?: string;
  /** 产物 lineage（migration 0080） */
  workflowRunId?: string | null;
  createdBy?: "user" | "agent" | "clone" | "system" | string;
  agentInstanceId?: string | null;
  /** 克隆来源（migration 0080） */
  parentCompositionId?: string | null;
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
  name: string;
  description: string;
  /** 产物 lineage（migration 0080） */
  workflowRunId: string | null;
  createdBy: string;
  agentInstanceId: string | null;
  parentCompositionId: string | null;
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

/**
 * `createStrategyVersion` 的入参 —— 既允许显式指定 strategyId（挂在已有 strategy 下），
 * 也允许只给 strategyName（自动建一个新的 strategy 父对象）。
 */
export interface StrategyVersionCreateInput {
  projectId: string;
  /** 已有 strategy.id；与 strategyName 二选一 */
  strategyId?: string;
  /** 自动新建 strategy 时使用；默认 "user-strategy" */
  strategyName?: string;
  /** strategy.style；默认 "low_freq" */
  strategyStyle?: "low_freq" | "high_freq" | "mid_freq";
  versionTag?: string;
  params?: Record<string, unknown>;
  /** 可选 hash 源；默认用 params + Date.now() 算 16 位短 hash 占位 */
  hashSeed?: string;
  workflowRunId?: string | null;
}

export interface StrategyVersionRecord {
  id: string;
  strategyId: string;
  versionTag: string;
  logicHash: string;
  workflowRunId: string | null;
  createdAt: string;
}

export class StrategyComposer {
  /**
   * 创建（或挂载）一个 strategy_version。
   *
   * 用途：Composer UI 自洽 —— 此前 strategy_version 只能由 research agent / strategy
   * IDE / reia-bridge 三条非 UI 路径写入，导致用户在 Composer 里看到「暂无 version」
   * 死锁。现在前端可直接 `POST /api/v1/strategies/versions` 兜底建一个。
   *
   * 实现要点：
   *  - 若给了 strategyId 就挂在已有 strategy 下；否则自动建一个新的 strategy（projectId 必填）
   *  - versionTag 默认 "v1"；同名 tag 不去重（业务层允许）
   *  - logicHash 取 sha256(params || Date.now()) 前 16 位作为占位，与 native-research 同款
   */
  async createVersion(input: StrategyVersionCreateInput): Promise<StrategyVersionRecord> {
    const projectId = input.projectId.trim();
    if (!projectId) {
      throw new StrategyComposerError("validation_failed", "projectId_required");
    }
    const db = await getDb();
    let strategyId = input.strategyId?.trim() || null;
    if (strategyId) {
      const exists = await db
        .select()
        .from(strategyTable)
        .where(eq(strategyTable.id, strategyId))
        .limit(1);
      if (!exists[0]) {
        throw new StrategyComposerError(
          "validation_failed",
          `strategy_not_found: ${strategyId}`
        );
      }
    } else {
      strategyId = randomUUID();
      await db.insert(strategyTable).values({
        id: strategyId,
        projectId,
        name: (input.strategyName ?? "user-strategy").trim() || "user-strategy",
        style: input.strategyStyle ?? "low_freq",
        description: "Created from Quant Workbench composer",
      });
    }
    const logicHash = createHash("sha256")
      .update((input.hashSeed ?? "") + JSON.stringify(input.params ?? {}) + Date.now())
      .digest("hex")
      .slice(0, 16);
    const versionId = randomUUID();
    await db.insert(strategyVersionTable).values({
      id: versionId,
      strategyId,
      versionTag: (input.versionTag ?? "v1").trim() || "v1",
      logicHash,
      paramSchemaJson: (input.params ?? {}) as never,
      workflowRunId: input.workflowRunId ?? null,
    });
    const row = await db
      .select()
      .from(strategyVersionTable)
      .where(eq(strategyVersionTable.id, versionId))
      .limit(1);
    const v = row[0]!;
    return {
      id: v.id,
      strategyId: v.strategyId,
      versionTag: v.versionTag,
      logicHash: v.logicHash,
      workflowRunId: v.workflowRunId,
      createdAt: v.createdAt,
    };
  }

  /**
   * 兜底：如果当前 project 一个 strategy_version 都没有，自动建一个默认 v1。
   * Composer `submit` 入口在 strategyVersionId 为空时会调用，避免 chicken-and-egg。
   * 已有 version 时返回最近一条，不重复建。
   */
  async ensureDefaultVersion(projectId: string): Promise<StrategyVersionRecord> {
    const db = await getDb();
    const existing = await db
      .select({
        id: strategyVersionTable.id,
        strategyId: strategyVersionTable.strategyId,
        versionTag: strategyVersionTable.versionTag,
        logicHash: strategyVersionTable.logicHash,
        workflowRunId: strategyVersionTable.workflowRunId,
        createdAt: strategyVersionTable.createdAt,
      })
      .from(strategyVersionTable)
      .innerJoin(strategyTable, eq(strategyTable.id, strategyVersionTable.strategyId))
      .where(eq(strategyTable.projectId, projectId))
      .orderBy(desc(strategyVersionTable.createdAt))
      .limit(1);
    if (existing[0]) return existing[0];
    return this.createVersion({
      projectId,
      strategyName: "default-composer-strategy",
      versionTag: "v1",
    });
  }

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
      name: input.name ?? "",
      description: input.description ?? "",
      createdBy: input.createdBy ?? "user",
      workflowRunId: input.workflowRunId ?? null,
      agentInstanceId: input.agentInstanceId ?? null,
      parentCompositionId: input.parentCompositionId ?? null,
    });
    return this.get(id);
  }

  /**
   * 克隆已有 composition：复用 factor/rule/权重等内核配置，把 lineage 标记为 `clone`
   * 并记录 `parentCompositionId`。前端「组合工坊」的克隆按钮直接走这里。
   *
   * 注意：克隆默认延用源 composition 的 strategyVersion；用户也可显式 override。
   */
  async clone(
    sourceId: string,
    override?: Partial<CompositionDefineInput>
  ): Promise<CompositionRecord> {
    const src = await this.get(sourceId);
    const defineInput: CompositionDefineInput = {
      strategyVersionId: override?.strategyVersionId ?? src.strategyVersionId,
      kind: override?.kind ?? src.kind,
      factorIds: override?.factorIds ?? src.factorIds,
      ruleIds: override?.ruleIds ?? src.ruleIds,
      weightMethod: override?.weightMethod ?? src.weightMethod,
      ...(override?.factorWeights
        ? { factorWeights: override.factorWeights }
        : src.params["factorWeights"]
          ? { factorWeights: src.params["factorWeights"] as Record<string, number> }
          : {}),
      rebalanceFreq: override?.rebalanceFreq ?? src.rebalanceFreq,
      universe: override?.universe ?? src.universe,
      params: override?.params ?? src.params,
      name: override?.name ?? (src.name ? `${src.name} (clone)` : `Clone of ${src.id.slice(0, 8)}`),
      description: override?.description ?? src.description,
      createdBy: override?.createdBy ?? "clone",
      workflowRunId: override?.workflowRunId ?? null,
      agentInstanceId: override?.agentInstanceId ?? null,
      parentCompositionId: sourceId,
    };
    return this.define(defineInput);
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

    // 2. 决定权重（rank_ic_weighted / ic_ir_weighted 会真查 factor_evaluation）
    const weights = await this.computeWeights(comp, factorMeta);

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

  /**
   * 计算因子权重。支持四种 `weightMethod`：
   *   - `equal`：等权
   *   - `manual`：用户在 `params.factorWeights` 指定，按绝对值归一化
   *   - `rank_ic_weighted`：从 `factor_evaluation` 取每个因子最近一次的 `rank_ic`，按 |rank_ic| 归一化
   *   - `ic_ir_weighted`：同上，但用 `ir`
   *
   * 重要：当 `rank_ic_weighted` / `ic_ir_weighted` 时——
   *   - **所有因子都没评估记录** → 抛 `validation_failed`（之前会 silently 退到 equal，导致 Agent
   *     声明"我用 IC 加权"但实际行为完全等同 equal，不可复现）
   *   - 部分因子缺评估 → 缺值按 0；只用有评估的因子做权重分配
   *   - 全部评估都为 0 → 退到 equal，并 console.warn 提示
   */
  private async computeWeights(
    comp: CompositionRecord,
    factorMeta: Map<string, { name: string; weight: number }>
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const ids = comp.factorIds;
    if (ids.length === 0) return out;

    const method = comp.weightMethod;

    if (method === "manual") {
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

    if (method === "rank_ic_weighted" || method === "ic_ir_weighted") {
      return this.computeIcWeights(ids, method);
    }

    if (method === "equal") {
      const equal = 1 / ids.length;
      for (const fid of ids) out[fid] = equal;
      return out;
    }

    throw new StrategyComposerError(
      "validation_failed",
      `unknown_weight_method: ${method as string}; 支持 equal / manual / rank_ic_weighted / ic_ir_weighted`
    );
  }

  /**
   * 从 factorService 拉每个因子最近一次的指标，按 |metric| 归一化。
   *
   * 不直接读 `factor_evaluation` 表（之前 P0 阶段为了赶进度跨域 SELECT，破坏了
   * "strategy 不应直接读 factor 数据表"的边界约束）。
   */
  private async computeIcWeights(
    ids: string[],
    method: "rank_ic_weighted" | "ic_ir_weighted"
  ): Promise<Record<string, number>> {
    const metricKey = method === "rank_ic_weighted" ? "rankIc" : "ir";
    const latestRaw = await factorService.getLatestEvaluationMetric(ids, metricKey);

    if (latestRaw.size === 0) {
      throw new StrategyComposerError(
        "validation_failed",
        `${method}_no_factor_evaluation: 所有因子都没有 factor_evaluation 留痕，无法用 IC 权重；` +
          `请先调 factor.evaluate / factor.autoEvaluate，或切回 weight_method=equal`
      );
    }

    const out: Record<string, number> = {};
    let total = 0;
    for (const id of ids) {
      const w = Math.abs(latestRaw.get(id) ?? 0);
      out[id] = w;
      total += w;
    }

    if (total > 0) {
      for (const id of ids) out[id] = (out[id] ?? 0) / total;
      return out;
    }

    // 全部为 0：退到 equal 并发警告，便于 Agent 监控
    console.warn(
      `[StrategyComposer] weight_method=${method} 但所有因子最近一次评估指标都为 0；退到 equal 权重`
    );
    const equal = 1 / ids.length;
    for (const id of ids) out[id] = equal;
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
      name: r.name ?? "",
      description: r.description ?? "",
      workflowRunId: r.workflowRunId ?? null,
      createdBy: r.createdBy ?? "user",
      agentInstanceId: r.agentInstanceId ?? null,
      parentCompositionId: r.parentCompositionId ?? null,
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
