/**
 * FactorService — 因子层薄编排服务
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.1
 *
 * 职责：
 *   - 因子 CRUD（落 SQLite `factor_definition`）
 *   - 触发计算（走 ProviderResolver → FactorComputeProvider）
 *   - 触发评估（走 ProviderResolver → FactorEvaluationProvider，写 factor_evaluation 留痕）
 *   - 不直接 import qlib/python_inline 等具体实现；统一从 Provider 拿
 *
 * 强制约束：因子值（按 symbol×date×factor 高基数）由 DuckDB/Parquet 承载（P1 落地）。
 * P0 阶段：compute 直接返回 Provider 给的 in-memory rows，不持久化时序数据；evaluate 把汇总指标写入 SQLite。
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  factorDefinition as factorDefTable,
  factorEvaluation as factorEvalTable,
} from "../../db/sqlite/schema";
import { providerResolver } from "../provider/resolver";
import type {
  FactorComputeProvider,
  FactorComputeResult,
  FactorComputeRow,
  FactorEvalResult,
  FactorEvaluationProvider,
  ProviderScope,
} from "../provider/types";
import { factorValueStore } from "./factor-value-store";
import { queryBarsRange } from "../market/klines-query";
import {
  parseQlibExpr,
  evalQlibExpr,
  type PriceSeries,
} from "../provider";
import { generateGbmTicks } from "../../util/synthesize-gbm";

// ─── 类型 ───────────────────────────────────────────────────────────────────

export type FactorCategory = "value" | "momentum" | "volatility" | "news" | "quality" | "macro";
export type FactorLang = "qlib_expr" | "python" | "sql" | "jsonlogic";
export type FactorStatus = "draft" | "active" | "archived";

export interface FactorRegisterInput {
  projectId: string;
  name: string;
  category: FactorCategory;
  expr: string;
  lang?: FactorLang;
  universe?: string;
  horizon?: number;
  status?: FactorStatus;
  providerKey?: string;
  /**
   * 产出该 factor 的 workflow_run.id；走 builtin tool / discovery 链路时由 act 节点
   * 透传 ctx.workflowId。IDE / REST 直接调用可不传（会落 NULL）。
   * 落库后用于研究产出侧栏严格按"本工作流"过滤，避免历史 / manual 产物串栏。
   */
  workflowRunId?: string | null;
  /**
   * F-P0-10（2026-06-05 eval batch 3 / case 2 observability 修复）：
   *
   * 用于把"另一个 builtin tool 内部调到的 factorService.register"标识为"side-effect 注册"，
   * 让我们在 research_team_interaction 里 emit 一条 tool_call 记录，避免出现"DB 有
   * factor 但 team-graph 里只看到上层工具调用、看不到注册事件"的观测盲区。
   *
   * 约定值（也允许任意字符串以便后续扩展）：
   *   - "factor.autoEvaluate" — 旧 run_experiment 风格被 builtin 内部自动补 register
   *   - "discovery.promote"   — discovery 命中后 promote 到 factor pool
   *   - "factor.mine.llm"     — LLM 挖掘工具一次性 batch register
   *
   * 留空（默认）= 调用方是显式的 factor.register builtin 或直接走 service，对应的
   * tool_call 已经由 act 节点写过 → 不重复写。
   */
  autoRegisteredVia?: string;
  /**
   * F-P0-10：触发本次 side-effect 注册的 agent 角色，用于让 interaction log 的
   * fromRole 准确归位。仅当 `autoRegisteredVia` 也传时才会被使用。
   */
  agentRole?: string;
  /** 任意补充元数据（写入 definition_json） */
  definition?: Record<string, unknown>;
  /**
   * 产物 lineage（migration 0080）：
   *   - createdBy：'user'（默认）/ 'agent' / 'discovery_promote' / 'system'
   *   - agentInstanceId：发起注册的 agent_instance.id
   *   - sourceJobId：discovery promote 时记录上游 discovery_job.id
   *
   * 与 `workflowRunId` 解耦：workflow 跑 builtin tool 时这三者通常一起写；
   * IDE / REST 走默认值 'user'。
   */
  createdBy?: "user" | "agent" | "discovery_promote" | "system" | string;
  agentInstanceId?: string | null;
  sourceJobId?: string | null;
  /**
   * P0-2: 注册前 dry-run 闸门（详见 AGENT_STABILITY_REVIEW.md §四-P0-2）
   *
   * - `false` / 未传：跳过 dry-run（向后兼容；脚本/API/IDE 路径默认行为）
   * - `true` 或对象：注册前在合成 GBM 数据上跑一遍表达式，
   *   - 抛错 / 返回行 < `minRows`（默认 10）/ 全 NaN / 方差 < `minVariance`（默认 1e-12）
   *     → 拒绝注册（抛 validation_failed）
   *   - 通过：注册成功；除非显式传 `status`，否则**强制**为 `draft`，由后续 evaluate 决定是否 active
   *
   * Agent 触发的注册（`builtin-tools.factor.register`）默认开启，避免无效因子污染 `factor_definition` 表。
   *
   * **注意**：dry-run 当前仅对 `lang='qlib_expr'` 真正执行；其他 lang 的 dry-run 会被跳过并写一条 warning 元数据。
   */
  dryRun?: boolean | { minRows?: number; minVariance?: number };
}

export interface FactorRecord {
  id: string;
  projectId: string;
  name: string;
  category: FactorCategory;
  expr: string;
  lang: FactorLang;
  universe: string;
  horizon: number;
  status: FactorStatus;
  providerKey: string;
  /** 来源 workflow_run.id；NULL = IDE / REST / 历史数据 */
  workflowRunId: string | null;
  /** 产物 lineage（migration 0080） */
  createdBy: string;
  agentInstanceId: string | null;
  sourceJobId: string | null;
  definition: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface FactorComputeInput {
  factorId: string;
  startDate: string;
  endDate: string;
  symbols?: string[];
  /** 显式指定 Provider；不传走 ProviderResolver */
  providerKey?: string;
  scope?: ProviderScope;
  /** 是否将结果写入 factor_value（DuckDB）；默认 true */
  persist?: boolean;
}

export interface FactorValueQueryInput {
  factorId: string;
  symbols?: string[];
  startDate?: string;
  endDate?: string;
  latestN?: number;
}

export interface FactorEvaluateInput {
  factorId: string;
  values: FactorComputeRow[];
  futureReturns?: FactorComputeRow[];
  futureReturnsByHorizon?: Record<number, FactorComputeRow[]>;
  groupCount?: number;
  asof?: string;
  /** 显式指定 Provider；不传走 ProviderResolver */
  providerKey?: string;
  scope?: ProviderScope;
}

export interface FactorAutoEvaluateInput {
  factorId: string;
  startDate: string;
  endDate: string;
  symbols?: string[];
  /** 主 horizon；默认从 factor.horizon 取 */
  horizonDays?: number;
  /** 多期 horizon → decay curve；默认 [1,3,5,10,20] */
  decayHorizons?: number[];
  /** 分组数；默认 5 */
  groupCount?: number;
  /** 显式 evaluator Provider */
  providerKey?: string;
  scope?: ProviderScope;
}

export class FactorServiceError extends Error {
  constructor(
    public code: "factor_not_found" | "provider_failed" | "validation_failed" | "duplicate_name",
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "FactorServiceError";
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class FactorService {
  /** 注册因子（落 SQLite + 调 Provider.validateExpr） */
  async register(input: FactorRegisterInput): Promise<FactorRecord> {
    if (!input.name?.trim()) {
      throw new FactorServiceError("validation_failed", "name_required");
    }
    if (!input.expr?.trim()) {
      throw new FactorServiceError("validation_failed", "expr_required");
    }

    const lang: FactorLang = input.lang ?? "python";
    const providerKey = input.providerKey ?? this.defaultProviderKeyForLang(lang);

    // 同 project 内名字不可重复
    const db = await getDb();
    const dup = await db
      .select({ id: factorDefTable.id })
      .from(factorDefTable)
      .where(
        and(eq(factorDefTable.projectId, input.projectId), eq(factorDefTable.name, input.name))
      )
      .limit(1);
    if (dup[0]) {
      throw new FactorServiceError("duplicate_name", `factor_name_already_exists: ${input.name}`);
    }

    // 让 Provider 做 syntax 校验（best effort，不打断 draft 注册）
    let providerHint: { ok: boolean; error?: string } = { ok: true };
    try {
      const provider = await providerResolver.resolve<"factor_compute">(
        "factor_compute",
        {},
        { providerKey }
      );
      providerHint = await provider.validateExpr(input.expr, lang);
    } catch {
      // Provider 不可达不阻塞注册：保留 draft 让 UI 提示
    }

    // P0-2: 强制 dry-run 闸门
    let dryRunMeta: Record<string, unknown> | undefined;
    if (input.dryRun) {
      const opts =
        typeof input.dryRun === "object"
          ? input.dryRun
          : ({} as { minRows?: number; minVariance?: number });
      const dryRunResult = await this.runRegistrationDryRun(input.expr, lang, opts);
      if (!dryRunResult.ok) {
        throw new FactorServiceError(
          "validation_failed",
          `dry_run_failed: ${dryRunResult.reason}`,
          { expr: input.expr, lang, ...dryRunResult.detail }
        );
      }
      dryRunMeta = {
        dryRun: {
          ok: true,
          ...dryRunResult.detail,
        },
      };
    }

    const id = randomUUID();
    // 通过 dry-run 后默认进入 draft 池（让上游评估器决定何时 promote 到 active）；
    // 用户显式传 status 时尊重用户输入
    const status: FactorStatus = input.status ?? "draft";
    const workflowRunId = input.workflowRunId?.trim() || null;
    const createdBy = input.createdBy ?? "user";
    const agentInstanceId = input.agentInstanceId?.trim?.() || input.agentInstanceId || null;
    const sourceJobId = input.sourceJobId?.trim?.() || input.sourceJobId || null;
    await db.insert(factorDefTable).values({
      id,
      projectId: input.projectId,
      name: input.name,
      category: input.category,
      definitionJson: {
        ...(input.definition ?? {}),
        ...(providerHint.error ? { providerValidationWarning: providerHint.error } : {}),
        ...(dryRunMeta ?? {}),
      },
      expr: input.expr,
      lang,
      universe: input.universe ?? "CN-A",
      horizon: input.horizon ?? 5,
      status,
      providerKey,
      workflowRunId,
      createdBy,
      agentInstanceId,
      sourceJobId,
    });

    /**
     * F-P0-10：side-effect 注册的可观测性补丁。
     *
     * 直接调 factor.register builtin 时，act 节点会自动写一条 tool_call interaction，
     * 不需要在这里再写一遍。但如果是被另一个 builtin（factor.autoEvaluate 内部、
     * discovery.promote、factor.mine.llm 批量等）副作用调到的，act 节点对应的
     * 上层工具调用记录的是上层 tool_name（如 "factor.autoEvaluate"），DB 里出现了一条
     * factor row 但 team-graph 看不到 "factor.register" → 让人误以为因子凭空出现。
     *
     * 仅当 autoRegisteredVia + workflowRunId 都齐时才 emit；不阻塞主路径，错误吞掉。
     */
    if (input.autoRegisteredVia && workflowRunId) {
      void (async () => {
        try {
          const { logResearchTeamInteraction } = await import(
            "../research-team/interaction-log"
          );
          await logResearchTeamInteraction({
            workflowRunId,
            fromRole: (input.agentRole ?? "research") as never,
            toRole: "__tools__" as never,
            kind: "tool_call",
            toolName: `factor.register (auto via ${input.autoRegisteredVia})`,
            contentText: `✓ factor.register (auto via ${input.autoRegisteredVia}) — ${input.name}[${status}]`,
            payloadJson: {
              factorId: id,
              factorName: input.name,
              autoRegisteredVia: input.autoRegisteredVia,
              status,
              expr: input.expr.slice(0, 200),
            },
          });
        } catch {
          /** observability 补丁，不影响主路径 */
        }
      })();
    }

    return this.get(id);
  }

  /**
   * 注册前 dry-run：在合成 GBM 序列上跑一遍表达式，验证可执行性 + 区分度
   *
   * 评估报告 P3-1：之前 `lang !== "qlib_expr"` 一律跳过（写 skipped:true），导致
   * LLM 写错的 python 因子（语法 / NameError / 全常数）**无声落库** → 后续
   * factor.compute 返回空 → autoEvaluate 以 `no_factor_values` 误报，定位难。
   * 现在 python 路径也走完整 4 项检查（用 runPythonSandbox 跑用户代码）。
   *
   * 支持矩阵：
   *   - `qlib_expr`：内置 parser+evaluator 真跑（同步，零依赖）
   *   - `python`   ：spawn `code_sandbox_runner.py` 跑用户代码，contract 要求
   *                  用户代码设置全局变量 `factor_values: list[float | None]`
   *   - 其他 lang（sql / jsonlogic）：暂仍跳过（在 detail 里写 lang_unsupported）
   *
   * 检查项（按顺序短路，所有 lang 共用）：
   *   1. 语法解析 / sandbox spawn 失败 → `parse_error` / `sandbox_unavailable`
   *   2. 评估抛错（包含用户代码运行时错）→ `eval_error`
   *   3. 有限值行数 < `minRows`（默认 10）→ `insufficient_values`
   *   4. 全常数（方差 < `minVariance`，默认 1e-12）→ `degenerate_constant`
   */
  private async runRegistrationDryRun(
    expr: string,
    lang: FactorLang,
    opts: { minRows?: number; minVariance?: number }
  ): Promise<
    | { ok: true; detail: Record<string, unknown> }
    | { ok: false; reason: string; detail?: Record<string, unknown> }
  > {
    const minRows = opts.minRows ?? 10;
    const minVariance = opts.minVariance ?? 1e-12;

    if (lang === "qlib_expr") {
      return runQlibExprDryRun(expr, minRows, minVariance);
    }
    if (lang === "python") {
      return runPythonExprDryRun(expr, minRows, minVariance);
    }

    return {
      ok: true,
      detail: { skipped: true, reason: `lang_unsupported_for_dry_run:${lang}` },
    };
  }

  async get(id: string): Promise<FactorRecord> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(factorDefTable)
      .where(eq(factorDefTable.id, id))
      .limit(1);
    const r = rows[0];
    if (!r) throw new FactorServiceError("factor_not_found", `factor_not_found: ${id}`);
    return this.rowToRecord(r);
  }

  /**
   * 2026-06-05 P1 修复（监控复盘 #3 / factor.autoEvaluate idempotent 配套）：
   *
   * autoEvaluate 的 auto-register fallback 在 LLM retry 同 name 时会被
   * `factor_name_already_exists` 拒掉（factor 表 (project_id, name) 唯一约束）。
   * 没有原生 findByName 时只能 list().filter()，浪费 SQL 全表扫；用单查复用
   * (project_id, name) 复合索引，常数级返回。
   */
  async findByProjectAndName(projectId: string, name: string): Promise<FactorRecord | null> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(factorDefTable)
      .where(and(eq(factorDefTable.projectId, projectId), eq(factorDefTable.name, name)))
      .limit(1);
    return rows[0] ? this.rowToRecord(rows[0]) : null;
  }

  async list(
    filter: {
      projectId?: string;
      category?: FactorCategory;
      status?: FactorStatus;
      /** 严格按工作流过滤；命中 (project_id, workflow_run_id) 索引，详见 migration 0047 */
      workflowRunId?: string;
      /** lineage 过滤（migration 0080）：按来源筛 user / agent / discovery_promote */
      createdBy?: string;
      agentInstanceId?: string;
    } = {}
  ): Promise<FactorRecord[]> {
    const db = await getDb();
    const conds = [];
    if (filter.projectId) conds.push(eq(factorDefTable.projectId, filter.projectId));
    if (filter.category) conds.push(eq(factorDefTable.category, filter.category));
    if (filter.status) conds.push(eq(factorDefTable.status, filter.status));
    if (filter.workflowRunId)
      conds.push(eq(factorDefTable.workflowRunId, filter.workflowRunId));
    if (filter.createdBy) conds.push(eq(factorDefTable.createdBy, filter.createdBy));
    if (filter.agentInstanceId)
      conds.push(eq(factorDefTable.agentInstanceId, filter.agentInstanceId));

    const rows = conds.length
      ? await db
          .select()
          .from(factorDefTable)
          .where(and(...conds))
          .orderBy(desc(factorDefTable.createdAt))
      : await db.select().from(factorDefTable).orderBy(desc(factorDefTable.createdAt));
    return rows.map((r) => this.rowToRecord(r));
  }

  async setStatus(id: string, status: FactorStatus): Promise<void> {
    const db = await getDb();
    await db
      .update(factorDefTable)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(factorDefTable.id, id));
  }

  /**
   * 调 Provider 计算因子值；默认写入 DuckDB `factor_value`，下游可 loadValues 取回。
   */
  async compute(input: FactorComputeInput): Promise<FactorComputeResult> {
    const f = await this.get(input.factorId);
    const provider = await this.resolveCompute(f.providerKey, input.providerKey, input.scope);

    let result: FactorComputeResult;
    try {
      result = await provider.compute({
        factorId: f.id,
        expr: f.expr,
        lang: f.lang,
        universe: f.universe,
        startDate: input.startDate,
        endDate: input.endDate,
        ...(input.symbols ? { symbols: input.symbols } : {}),
      });
    } catch (e) {
      throw new FactorServiceError(
        "provider_failed",
        `factor_compute_failed: ${(e as Error).message}`,
        { factorId: f.id, providerKey: f.providerKey }
      );
    }

    if ((input.persist ?? true) && result.rows.length > 0) {
      try {
        await factorValueStore.upsert({ factorId: f.id, rows: result.rows });
      } catch (e) {
        // 持久化失败不破坏返回结果（计算成功），但记录到 meta.error
        // eslint-disable-next-line no-console
        console.warn(
          `[FactorService] persist factor_value failed for ${f.id}: ${(e as Error).message}`
        );
      }
    }

    return result;
  }

  /** 直接从 DuckDB factor_value 表读取（不重新计算） */
  async loadValues(q: FactorValueQueryInput): Promise<FactorComputeRow[]> {
    const rows = await factorValueStore.query({
      factorId: q.factorId,
      ...(q.symbols ? { symbols: q.symbols } : {}),
      ...(q.startDate ? { startDate: q.startDate } : {}),
      ...(q.endDate ? { endDate: q.endDate } : {}),
      ...(q.latestN ? { latestN: q.latestN } : {}),
    });
    return rows.map((r) => ({ symbol: r.symbol, date: r.date, value: r.value }));
  }

  /** 因子值汇总统计（行数/symbol 数/区间） */
  async valuesStats(factorId: string) {
    return factorValueStore.stats(factorId);
  }

  /** 调 Provider 评估因子；汇总指标写入 factor_evaluation 留痕 */
  async evaluate(input: FactorEvaluateInput): Promise<FactorEvalResult & { evaluationId: string }> {
    const f = await this.get(input.factorId);
    const provider = await this.resolveEval(input.providerKey, input.scope);

    let result: FactorEvalResult;
    try {
      result = await provider.evaluate({
        factorId: f.id,
        universe: f.universe,
        values: input.values,
        ...(input.futureReturns ? { futureReturns: input.futureReturns } : {}),
        ...(input.futureReturnsByHorizon
          ? { futureReturnsByHorizon: input.futureReturnsByHorizon }
          : {}),
        ...(typeof input.groupCount === "number" ? { groupCount: input.groupCount } : {}),
        horizonDays: f.horizon,
      });
    } catch (e) {
      throw new FactorServiceError(
        "provider_failed",
        `factor_evaluate_failed: ${(e as Error).message}`,
        { factorId: f.id }
      );
    }

    const db = await getDb();
    const evaluationId = randomUUID();
    await db.insert(factorEvalTable).values({
      id: evaluationId,
      factorId: f.id,
      asof: input.asof ?? new Date().toISOString().slice(0, 10),
      universe: f.universe,
      providerId: null,
      ic: result.ic,
      rankIc: result.rankIc,
      ir: result.ir,
      turnover: result.turnover,
      decayCurveJson: result.decayCurve as never,
      groupReturnsJson: result.groupReturns as never,
      sampleSize: result.sampleSize,
      latencyMs: result.latencyMs,
      error: result.error ?? null,
    });

    return { ...result, evaluationId };
  }

  /**
   * 自动评估：从 DuckDB 拉因子值 + 从行情拉收盘 → 算 N 期未来收益 → 调 evaluator
   *
   * 与 evaluate 的差异：调用方只提供 factorId + 区间，service 负责拉所有数据。
   * 适合 Agent / CLI 一键评估场景。
   */
  async autoEvaluate(
    input: FactorAutoEvaluateInput
  ): Promise<FactorEvalResult & { evaluationId: string; meta: { horizonDays: number; decayHorizons: number[] } }> {
    const f = await this.get(input.factorId);
    const horizon = input.horizonDays ?? f.horizon ?? 5;
    const decayHorizons =
      input.decayHorizons && input.decayHorizons.length > 0
        ? Array.from(new Set([...input.decayHorizons, horizon])).sort((a, b) => a - b)
        : [1, 3, 5, 10, 20].includes(horizon)
          ? [1, 3, 5, 10, 20]
          : [1, 3, 5, 10, 20, horizon].sort((a, b) => a - b);

    // 1) 拉因子值
    const values = await this.loadValues({
      factorId: f.id,
      ...(input.symbols ? { symbols: input.symbols } : {}),
      startDate: input.startDate,
      endDate: input.endDate,
    });
    if (values.length === 0) {
      throw new FactorServiceError(
        "validation_failed",
        `no_factor_values: factor=${f.id}; 先跑 compute 写入 factor_value 后再评估`
      );
    }

    const symbolSet = new Set<string>();
    for (const v of values) symbolSet.add(v.symbol);
    const symbols = Array.from(symbolSet);

    /**
     * P0-3 修（Round 6 复盘）：IC/RankIC 是 **cross-section** 指标，每日横截面需要
     * ≥3 个 symbols 才能计算 Pearson/Spearman。
     *
     * Round 6 实测 LLM 用单个 AAPL + horizon=60 跑 autoEvaluate，loadValues 拿到 238 行
     * (单 symbol × 238 day)，下游 dailyIcSeries 第 145 行因 `p.xs.length < 3` 全跳过
     * → ics.length === 0 → provider 返回 `error: "sample_size_too_small"` + ic=0/rankIc=0/ir=0。
     *
     * 工具层（builtin-tools.ts）已经从入参 symbols 拦了一道，这里是**入参绕过 / Agent 复用
     * 旧 factor_id 没传 symbols** 时的最终防线 —— 提前抛出，避免脏 0 流入 factor_evaluation
     * 与下游 strategy.compose 的 IC-weighted 算法。
     */
    if (symbols.length < 3) {
      throw new FactorServiceError(
        "validation_failed",
        `cross_section_too_few_symbols: factor=${f.id} 当前 factor_value 只覆盖 ${symbols.length} 只 symbols (${symbols
          .slice(0, 5)
          .join(",")}); IC/RankIC 是横截面指标，至少需要 3 只 symbols（推荐 ≥ 10）。请重跑 factor.compute 并传入 ≥3 只 symbols（如 ["AAPL","MSFT","NVDA","GOOG","META"]）再评估。`
      );
    }

    // 2) 拉行情 → 算多期未来收益
    const closesBySymbol = new Map<string, { dates: string[]; closes: number[] }>();
    const maxHorizon = Math.max(horizon, ...decayHorizons);
    const endExtended = this.shiftDate(input.endDate, maxHorizon + 5);
    for (const sym of symbols) {
      try {
        const bars = await queryBarsRange({
          symbol: sym,
          exchange: "",
          period: "1d",
          startDate: input.startDate,
          endDate: endExtended,
        });
        if (bars.length === 0) continue;
        closesBySymbol.set(sym, {
          dates: bars.map((b) => b.timestamp.slice(0, 10)),
          closes: bars.map((b) => b.close),
        });
      } catch {
        // 单 symbol 缺数据不影响整体
      }
    }

    // 3) 构造 futureReturnsByHorizon
    const byHorizon: Record<number, FactorComputeRow[]> = {};
    for (const h of decayHorizons) {
      byHorizon[h] = this.computeFutureReturns(closesBySymbol, h);
    }
    const mainFutures = byHorizon[horizon] ?? [];

    // 4) 调 evaluate
    const result = await this.evaluate({
      factorId: f.id,
      values,
      futureReturns: mainFutures,
      futureReturnsByHorizon: byHorizon,
      ...(typeof input.groupCount === "number" ? { groupCount: input.groupCount } : {}),
      ...(input.providerKey ? { providerKey: input.providerKey } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    });

    /**
     * P0-3 修（Round 6 复盘）：当 provider 返回 result.error（如 sample_size_too_small / no_future_returns）
     * 时，旧实现把 `{ ic:0, rankIc:0, ir:0, error:"sample_size_too_small" }` 直接 return 给上层 builtin tool，
     * 而 tool 层把它包成 `{ result:"ok", builtinResult:{...} }`，LLM 看到 "ok" 顶层就以为评估成功，把 0
     * 当真实指标写进 strategy / signal —— 这是 Round 6 strategy 链路 IC=0 的根因。
     *
     * 修复：result.error 存在时 throw FactorServiceError，让 builtin tool dispatcher 把它当工具失败上报，
     * LLM 在下一轮 reason 时能看到清晰错误消息并改用更多 symbols 重试。
     *
     * 注意：evaluate() 已经把含 error 的行写进 factor_evaluation 表（保留审计痕迹），上层抛错不影响留痕。
     */
    if (result.error) {
      throw new FactorServiceError(
        "validation_failed",
        `factor_evaluation_invalid: ${result.error}; sample_size=${result.sampleSize}; horizon=${horizon}; ` +
          `symbols=${symbols.length} (${symbols.slice(0, 5).join(",")}); ` +
          (result.error === "sample_size_too_small"
            ? "IC/RankIC 是横截面指标，至少需要 3 只 symbols 才能计算（推荐 ≥ 10）。请改用更宽的 universe 重跑 factor.compute + factor.autoEvaluate。"
            : "请检查数据完整性、horizon 选择是否合理、symbols 数量是否足够。"),
        { factorId: f.id, evaluationId: result.evaluationId }
      );
    }

    return { ...result, meta: { horizonDays: horizon, decayHorizons } };
  }

  /** 查询某因子的历史评估记录 */
  async listEvaluations(factorId: string, limit = 20) {
    const db = await getDb();
    return db
      .select()
      .from(factorEvalTable)
      .where(eq(factorEvalTable.factorId, factorId))
      .orderBy(desc(factorEvalTable.asof))
      .limit(limit);
  }

  /**
   * 取一批因子各自"最近一次评估"中的某个指标，返回 `factorId → metric value` 的 Map。
   *
   * - `metric = 'rankIc' | 'ir'`：分别对应 `factor_evaluation.rankIc` / `ir`
   * - 未跑过评估的 factor 不会出现在 Map 里（caller 自行决定 default 行为）
   * - 指标若为 NaN / null / 非有限数，按 `0` 写入并保留键（让 caller 知道"评估过但无效"）
   *
   * 给 `strategy-composer.computeIcWeights` 等"按 IC 权重打分"的用法使用，
   * 让 strategy 层不必直接 import `factor_evaluation` 表。
   */
  async getLatestEvaluationMetric(
    factorIds: string[],
    metric: "rankIc" | "ir"
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (factorIds.length === 0) return out;
    const db = await getDb();
    const rows = await db
      .select({
        factorId: factorEvalTable.factorId,
        rankIc: factorEvalTable.rankIc,
        ir: factorEvalTable.ir,
        asof: factorEvalTable.asof,
      })
      .from(factorEvalTable)
      .where(inArray(factorEvalTable.factorId, factorIds))
      .orderBy(desc(factorEvalTable.asof));
    for (const r of rows) {
      if (out.has(r.factorId)) continue;
      const v = r[metric];
      out.set(r.factorId, typeof v === "number" && Number.isFinite(v) ? v : 0);
    }
    return out;
  }

  // ── private ──

  private defaultProviderKeyForLang(lang: FactorLang): string {
    if (lang === "qlib_expr") return "qlib_expr"; // M3 内置纯 TS 实现
    return "python_inline";
  }

  private async resolveCompute(
    factorProviderKey: string,
    explicitKey: string | undefined,
    scope: ProviderScope | undefined
  ): Promise<FactorComputeProvider> {
    const opts =
      explicitKey ?? factorProviderKey
        ? { providerKey: explicitKey ?? factorProviderKey }
        : undefined;
    return providerResolver.resolve<"factor_compute">(
      "factor_compute",
      scope ?? {},
      opts ?? {}
    );
  }

  private async resolveEval(
    explicitKey: string | undefined,
    scope: ProviderScope | undefined
  ): Promise<FactorEvaluationProvider> {
    return providerResolver.resolve<"factor_eval">(
      "factor_eval",
      scope ?? {},
      explicitKey ? { providerKey: explicitKey } : {}
    );
  }

  /** 把价格序列转为「t 日 → t+h 日 close/close - 1」的 FactorComputeRow */
  private computeFutureReturns(
    closesBySymbol: Map<string, { dates: string[]; closes: number[] }>,
    horizonDays: number
  ): FactorComputeRow[] {
    const out: FactorComputeRow[] = [];
    if (horizonDays < 1) return out;
    for (const [sym, ser] of closesBySymbol) {
      for (let i = 0; i + horizonDays < ser.closes.length; i++) {
        const a = ser.closes[i]!;
        const b = ser.closes[i + horizonDays]!;
        if (a > 0 && Number.isFinite(a) && Number.isFinite(b)) {
          out.push({ symbol: sym, date: ser.dates[i]!, value: b / a - 1 });
        }
      }
    }
    return out;
  }

  /** YYYY-MM-DD + days */
  private shiftDate(dateStr: string, days: number): string {
    const d = new Date(dateStr.slice(0, 10) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  private rowToRecord(r: typeof factorDefTable.$inferSelect): FactorRecord {
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      category: r.category,
      expr: r.expr,
      lang: r.lang,
      universe: r.universe,
      horizon: r.horizon,
      status: r.status,
      providerKey: r.providerKey,
      workflowRunId: r.workflowRunId ?? null,
      createdBy: r.createdBy ?? "user",
      agentInstanceId: r.agentInstanceId ?? null,
      sourceJobId: r.sourceJobId ?? null,
      definition: (r.definitionJson as Record<string, unknown>) ?? {},
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

export const factorService = new FactorService();

/**
 * 合成 GBM 价格序列（90 天默认），用于 register 时的 dry-run。
 * 与 discovery-service.synthesizeBars 共享 `util/synthesize-gbm`。
 * 仅产出 OHLCV 字段，不模拟停牌、涨跌停、复权。
 */
function synthGbmSeries(symbol: string, days: number): PriceSeries {
  const ticks = generateGbmTicks(symbol, days);
  return {
    length: ticks.length,
    fields: {
      open: ticks.map((t) => t.open),
      high: ticks.map((t) => t.high),
      low: ticks.map((t) => t.low),
      close: ticks.map((t) => t.close),
      volume: ticks.map((t) => t.volume),
      turnover: ticks.map((t) => t.turnover),
      vwap: ticks.map((t) => t.close),
    },
  };
}

const DRY_RUN_SYMBOLS = ["__DR_A__", "__DR_B__", "__DR_C__"] as const;

interface DryRunOk {
  ok: true;
  detail: Record<string, unknown>;
}
interface DryRunFail {
  ok: false;
  reason: string;
  detail?: Record<string, unknown>;
}
type DryRunResult = DryRunOk | DryRunFail;

/** 把多个 symbol 拉平成单一 finite list + per-symbol 统计，做最后的方差 / 计数判定 */
function summarizeDryRunValues(
  flatValues: number[],
  perSymbolFiniteCounts: number[],
  minRows: number,
  minVariance: number,
  extraDetail: Record<string, unknown> = {}
): DryRunResult {
  if (flatValues.length < minRows) {
    return {
      ok: false,
      reason: "insufficient_values",
      detail: {
        finiteValues: flatValues.length,
        minRows,
        perSymbol: perSymbolFiniteCounts,
        ...extraDetail,
      },
    };
  }
  let sum = 0;
  for (const v of flatValues) sum += v;
  const mean = sum / flatValues.length;
  let sse = 0;
  for (const v of flatValues) sse += (v - mean) * (v - mean);
  const variance = sse / flatValues.length;
  if (variance < minVariance) {
    return {
      ok: false,
      reason: "degenerate_constant",
      detail: { variance, minVariance, sampleSize: flatValues.length, ...extraDetail },
    };
  }
  return {
    ok: true,
    detail: {
      sampleSize: flatValues.length,
      variance: Number(variance.toFixed(8)),
      perSymbolFiniteCounts,
      ...extraDetail,
    },
  };
}

/**
 * qlib_expr dry-run：用内置 parser+evaluator 跑 3 个合成 GBM 序列。
 * 与历史行为完全一致（评估报告 P3-1 只迁移代码结构、不改 qlib 路径语义）。
 */
function runQlibExprDryRun(
  expr: string,
  minRows: number,
  minVariance: number
): DryRunResult {
  let ast;
  try {
    ast = parseQlibExpr(expr);
  } catch (e) {
    return { ok: false, reason: `parse_error: ${(e as Error).message}` };
  }

  const finiteCounts: number[] = [];
  const flatValues: number[] = [];
  for (const sym of DRY_RUN_SYMBOLS) {
    const series = synthGbmSeries(sym, 90);
    let factorSeries: Array<number | null>;
    try {
      factorSeries = evalQlibExpr(ast, series);
    } catch (e) {
      return {
        ok: false,
        reason: `eval_error: ${(e as Error).message}`,
        detail: { symbol: sym },
      };
    }
    let n = 0;
    for (const v of factorSeries) {
      if (typeof v === "number" && Number.isFinite(v)) {
        flatValues.push(v);
        n++;
      }
    }
    finiteCounts.push(n);
  }
  return summarizeDryRunValues(flatValues, finiteCounts, minRows, minVariance);
}

/**
 * python dry-run：spawn code_sandbox_runner.py 跑用户代码，对 3 个合成 GBM
 * symbol 各跑一次，拉回 `factor_values` 全局变量。
 *
 * Contract（写入 PROMPT_ANALYST_SENTIMENT 同步引导）：
 *   - 用户 expr 是一段 python 代码，**必须**在结尾设置全局变量
 *     `factor_values: list[float | None]`（每根 bar 一个值，None 表示缺失）
 *   - 可访问的 vars：close / open / high / low / volume / turnover / vwap
 *     （全是 list[float]，长度相同）+ numpy / pandas / math
 *   - 不要 import os / sys / subprocess（sandbox 会拒绝）
 *
 * 评估报告 P3-1 之前：lang='python' 走 skipped:true，错代码无声落库 →
 * factor.compute 返空 → autoEvaluate 误报 no_factor_values，定位难。
 */
/**
 * 抽出 sandbox runner 类型，便于 dry-run 测试做依赖注入（替代 mock.module，
 * 后者在 Bun 是**全局污染且无 restore**，会让 src/runtime/sandbox/__tests__
 * 全量跑时把 runPythonSandbox 替换成 dry-run 测试的 mock，引发误失败）。
 */
type PythonSandboxRunner = (req: {
  code: string;
  vars: Record<string, unknown>;
  returnVar?: string;
  timeoutSec?: number;
}) => Promise<{
  ok: boolean;
  stdout: string;
  result: unknown;
  elapsedMs: number;
  rowsInResult: number;
  error?: string;
  trace?: string;
}>;

let testSandboxRunner: PythonSandboxRunner | null = null;

/**
 * 测试专用：注入 sandbox runner mock；同进程其它代码不受影响。
 * 调用 `__testSetSandboxRunner(null)` 恢复真 runner。
 */
export function __testSetSandboxRunner(runner: PythonSandboxRunner | null): void {
  testSandboxRunner = runner;
}

export async function __testRunPythonExprDryRun(
  expr: string,
  minRows = 10,
  minVariance = 1e-12
): Promise<DryRunResult> {
  return runPythonExprDryRun(expr, minRows, minVariance);
}

async function runPythonExprDryRun(
  expr: string,
  minRows: number,
  minVariance: number
): Promise<DryRunResult> {
  if (!expr.trim()) {
    return { ok: false, reason: "parse_error: empty_python_expr" };
  }

  /**
   * 把用户表达式包装：
   *   - 如果代码里已经写了 `factor_values =`，直接 exec 原样
   *   - 否则当成单行 expression，wrap 成 `factor_values = list({expr})`
   *
   * 这样 LLM 写「`close[-1] / close[-21] - 1`」单行也能 dry-run；
   * 写多行 + 自己设 factor_values 也能 dry-run。
   */
  const code = /\bfactor_values\s*=/.test(expr)
    ? expr
    : `factor_values = list(${expr})`;

  const runPythonSandbox: PythonSandboxRunner =
    testSandboxRunner ?? (await import("../sandbox/python-sandbox")).runPythonSandbox;

  const finiteCounts: number[] = [];
  const flatValues: number[] = [];
  const errorsBySymbol: Record<string, string> = {};

  for (const sym of DRY_RUN_SYMBOLS) {
    const series = synthGbmSeries(sym, 90);
    const resp = await runPythonSandbox({
      code,
      vars: {
        close: series.fields.close,
        open: series.fields.open,
        high: series.fields.high,
        low: series.fields.low,
        volume: series.fields.volume,
        turnover: series.fields.turnover,
        vwap: series.fields.vwap,
        symbol: sym,
      },
      returnVar: "factor_values",
      timeoutSec: 15,
    });
    if (!resp.ok) {
      const tail = (resp.trace ?? "").trim().slice(-400);
      /**
       * sandbox 系统级不可用（python 未装 / 缺 pandas / 钱箱 wall timeout）
       * → **graceful skip dry-run** 而非 reject 注册。理由：
       *   1. 测试环境 / 刚 install 未 bootstrap 的开发机普遍无 pandas
       *   2. 这类故障不是「LLM 写的因子有问题」，不该让 register 失败
       *   3. detail 写明 reason，运维 + LLM 都能看到「dry-run 被跳过」与原因
       *
       * 真正的"用户代码错误"（NameError / ImportError 黑名单 / TypeError / 全局变量未定义）
       * → 仍走 eval_error 让 register 拒绝。
       */
      if (
        resp.error === "python_unavailable" ||
        resp.error === "python_deps_missing" ||
        resp.error === "wall_timeout"
      ) {
        return {
          ok: true,
          detail: {
            skipped: true,
            reason: `sandbox_unavailable:${resp.error}`,
            hint: (resp.trace ?? "").trim().slice(0, 400),
          },
        };
      }
      return {
        ok: false,
        reason: `eval_error: ${resp.error ?? "sandbox_error"}`,
        detail: { symbol: sym, trace: tail },
      };
    }

    const values = resp.result;
    if (!Array.isArray(values)) {
      errorsBySymbol[sym] = `factor_values_not_array: type=${typeof values}`;
      finiteCounts.push(0);
      continue;
    }
    let n = 0;
    for (const v of values) {
      /**
       * 显式过滤 null / undefined（Python 端把 NaN 序列化成 None → JSON null）。
       * 不能直接 `Number(v)`，因为 Number(null)=0 会让"全 NaN" 被误算成 0 series。
       */
      if (v === null || v === undefined) continue;
      const num = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(num)) {
        flatValues.push(num);
        n++;
      }
    }
    finiteCounts.push(n);
  }

  if (Object.keys(errorsBySymbol).length === DRY_RUN_SYMBOLS.length) {
    return {
      ok: false,
      reason: "eval_error: factor_values_invalid_for_all_symbols",
      detail: { errorsBySymbol },
    };
  }

  return summarizeDryRunValues(flatValues, finiteCounts, minRows, minVariance, {
    pythonSandbox: true,
    ...(Object.keys(errorsBySymbol).length > 0 ? { errorsBySymbol } : {}),
  });
}
