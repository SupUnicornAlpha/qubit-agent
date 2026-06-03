/**
 * Self-Evolving Agent P4b — PnlAttributor worker（策略层 PnL 计算与物化）。
 *
 * 数据流：
 *   fill ──join── broker_order ──join── order_intent.strategyRuntimeId
 *      → 按 runtime.market 把 fill.filledAt 映射成 trading_day
 *      → 与 prior snapshots（fromDay-1 的最新行）合并为 priorPositions
 *      → 调 calcPnlSeries 算 daily snapshots
 *      → 借 FeeCalculator 估算每 fill 的 fee（fill.fee 全 0 时回退）
 *      → 借 DailyMarkPriceFetcher.getClosesByDay 拉 markLookup
 *      → upsert 到 strategy_pnl_snapshot
 *
 * v0 不做的事：
 *   - 不写 agent_pnl_attribution / agent_skill_run.pnlDelta（P4b-6 单独实现）；
 *   - 不调 AnalystAccuracyWriter（P4b-7 单独连）；
 *   - 不 emit Bus 事件（P4b-8 metrics 时统一接入）。
 *
 * 单 runtime 失败不阻塞其他 runtime；汇总在 RunSummary.errors。
 */

import { randomUUID } from "node:crypto";
import { and, between, eq, inArray, lt, sql } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { runInTransaction } from "../../db/sqlite/client";
import { getExperienceBus, type ExperienceBus } from "../experience/experience-bus";
import {
  brokerOrder,
  fill as fillTable,
  orderIntent,
  strategyPnlSnapshot,
  strategyRuntime,
} from "../../db/sqlite/schema";
import type { FeeCalculator } from "./fee-calculator";
import { createFeeCalculator } from "./fee-calculator";
import type { DailyMarkPriceFetcher } from "./mark-price-fetcher";
import { createDailyMarkPriceFetcher } from "./mark-price-fetcher";
import {
  calcPnlSeries,
  type MarkPriceLookup,
  type PnlCalcResult,
  type PnlFill,
  type PositionState,
} from "./pnl-calc";
import {
  type AnalystAccuracyWriter,
  type EvaluatePendingResult,
  type SyncPlaceholdersResult,
  createAnalystAccuracyWriter,
} from "./analyst-accuracy-writer";
import {
  type SkillAttributor,
  type SkillAttributorSummary,
  createSkillAttributor,
} from "./skill-attributor";
import { dateToTradingDay, isoDateToDate } from "./time-util";

const SNAPSHOT_SOURCE = "pnl_attributor_v0";

export interface PnlAttributorRunOptions {
  /** 含端，ISO 'YYYY-MM-DD' */
  fromDay: string;
  toDay: string;
  /** 不传 = 所有 market；传则只跑 runtime.market 在列表内的 */
  marketScope?: string[];
  /** 不传 = 所有 runtime；传则只跑指定 runtime（cron 增量增删时用） */
  runtimeIds?: string[];
  /** dry-run：算但不 upsert；用于诊断 */
  dryRun?: boolean;
  /** 注入：可手写 fee provider 替代 FeeCalculator（单测注入） */
  feeCalculator?: FeeCalculator;
  /** 注入：可手写 mark fetcher（单测注入） */
  markPriceFetcher?: DailyMarkPriceFetcher;
  /** 注入：可手写 skill attributor（单测注入） */
  skillAttributor?: SkillAttributor;
  /** 默认 true：策略层 snapshot 写完后自动跑 skill 归因；P4b cron 默认开 */
  attributeSkills?: boolean;
  /** 注入：可手写 analyst accuracy writer（单测注入） */
  analystAccuracyWriter?: AnalystAccuracyWriter;
  /**
   * 默认 true：跑完 skill 归因后调 AnalystAccuracyWriter.syncPlaceholders + evaluatePending；
   * 接 analyst_signal → analyst_accuracy_log 闭环。
   */
  evaluateAnalystAccuracy?: boolean;
  /** 注入：ExperienceBus；默认走全局 bus。 */
  experienceBus?: ExperienceBus;
  /** 默认 true：跑完发 maintenance_run(kind=pnl_attributor/analyst_accuracy) 给 metrics */
  emitMetrics?: boolean;
}

export interface PnlAttributorRuntimeResult {
  strategyRuntimeId: string;
  market: string;
  symbolsTouched: string[];
  fillsScanned: number;
  snapshotsWritten: number;
  priorPositionsLoaded: number;
  markCacheHits: number;
  markCacheMisses: number;
  error?: string;
  /** 给 P4b-6 / P4b-7 后续 hook 读：每个 (workflow_run, trading_day) 当日 PnL 与 symbols */
  perRunDay: Array<{
    workflowRunIds: string[];
    tradingDay: string;
    pnlAttributed: number;
    symbols: string[];
  }>;
}

export interface PnlAttributorRunSummary {
  fromDay: string;
  toDay: string;
  runtimesScanned: number;
  runtimesProcessed: number;
  runtimesSkipped: number;
  fillsScanned: number;
  snapshotsWritten: number;
  results: PnlAttributorRuntimeResult[];
  errors: Array<{ strategyRuntimeId: string; reason: string }>;
  dryRun: boolean;
  startedAt: string;
  endedAt: string;
  /** skill 归因子任务汇总；attributeSkills=false 或 dryRun=true 时为 null */
  skillAttribution: SkillAttributorSummary | null;
  /** analyst accuracy 子任务；evaluateAnalystAccuracy=false 或 dryRun=true 时为 null */
  analystAccuracy: {
    sync: SyncPlaceholdersResult;
    evaluate: EvaluatePendingResult;
  } | null;
}

export class PnlAttributor {
  constructor(private readonly db: DbClient) {}

  async runOnce(opts: PnlAttributorRunOptions): Promise<PnlAttributorRunSummary> {
    const startedAt = new Date().toISOString();
    validateDayRange(opts.fromDay, opts.toDay);

    const feeCalculator = opts.feeCalculator ?? createFeeCalculator(this.db);
    const markFetcher = opts.markPriceFetcher ?? createDailyMarkPriceFetcher(this.db);
    const skillAttributor = opts.skillAttributor ?? createSkillAttributor(this.db);
    const attributeSkills = opts.attributeSkills ?? true;
    const analystAccuracyWriter =
      opts.analystAccuracyWriter ?? createAnalystAccuracyWriter(this.db);
    const evaluateAnalystAccuracy = opts.evaluateAnalystAccuracy ?? true;

    const runtimes = await this.listRuntimes(opts.marketScope, opts.runtimeIds);
    const summary: PnlAttributorRunSummary = {
      fromDay: opts.fromDay,
      toDay: opts.toDay,
      runtimesScanned: runtimes.length,
      runtimesProcessed: 0,
      runtimesSkipped: 0,
      fillsScanned: 0,
      snapshotsWritten: 0,
      results: [],
      errors: [],
      dryRun: opts.dryRun ?? false,
      startedAt,
      endedAt: startedAt,
      skillAttribution: null,
      analystAccuracy: null,
    };

    for (const rt of runtimes) {
      try {
        const r = await this.processRuntime(rt, opts, feeCalculator, markFetcher);
        summary.results.push(r);
        if (r.fillsScanned === 0 && r.priorPositionsLoaded === 0) {
          summary.runtimesSkipped += 1;
        } else {
          summary.runtimesProcessed += 1;
        }
        summary.fillsScanned += r.fillsScanned;
        summary.snapshotsWritten += r.snapshotsWritten;
      } catch (err) {
        summary.errors.push({
          strategyRuntimeId: rt.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 跑 skill 归因（dryRun 不动 DB；attributeSkills=false 显式关）
    if (attributeSkills && !opts.dryRun) {
      try {
        const items = flattenPerRunDayToSkillItems(summary.results);
        summary.skillAttribution = await skillAttributor.attribute({ items });
      } catch (err) {
        summary.errors.push({
          strategyRuntimeId: "<skill_attribution>",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 跑 analyst accuracy 两阶段（dryRun 不动 DB）
    if (evaluateAnalystAccuracy && !opts.dryRun) {
      try {
        const sync = await analystAccuracyWriter.syncPlaceholders({});
        const evaluate = await analystAccuracyWriter.evaluatePending({});
        summary.analystAccuracy = { sync, evaluate };
      } catch (err) {
        summary.errors.push({
          strategyRuntimeId: "<analyst_accuracy>",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    summary.endedAt = new Date().toISOString();

    // emit metrics（dryRun 也 emit；让监控面板看到 dry-run 计数）
    if ((opts.emitMetrics ?? true) === true) {
      const bus = opts.experienceBus ?? getExperienceBus();
      try {
        bus.emit({
          type: "maintenance_run",
          kind: "pnl_attributor",
          actor: "pnl_attributor",
          summary: {
            runtimesScanned: summary.runtimesScanned,
            runtimesProcessed: summary.runtimesProcessed,
            runtimesSkipped: summary.runtimesSkipped,
            fillsScanned: summary.fillsScanned,
            snapshotsWritten: summary.snapshotsWritten,
            errors: summary.errors.length,
            skillAttributionRows: summary.skillAttribution?.attributionRowsUpserted ?? 0,
            skillRunsUpdated: summary.skillAttribution?.skillRunsUpdated ?? 0,
          },
        });
        if (summary.analystAccuracy) {
          bus.emit({
            type: "maintenance_run",
            kind: "analyst_accuracy",
            actor: "analyst_accuracy_writer",
            summary: {
              scannedSignals: summary.analystAccuracy.sync.scannedSignals,
              placeholdersInserted: summary.analystAccuracy.sync.placeholdersInserted,
              evaluated: summary.analystAccuracy.evaluate.evaluated,
              skippedNoMark: summary.analystAccuracy.evaluate.skippedNoMark,
              skippedNoFutureMark: summary.analystAccuracy.evaluate.skippedNoFutureMark,
              failures:
                summary.analystAccuracy.evaluate.failures.length +
                summary.analystAccuracy.sync.skippedNoAgent,
            },
          });
        }
      } catch {
        /* metrics emit 失败 silent，不影响主流程 */
      }
    }

    return summary;
  }

  /** 选择候选 runtime；不传 runtimeIds / marketScope 即全部。 */
  private async listRuntimes(
    marketScope?: string[],
    runtimeIds?: string[]
  ): Promise<Array<{ id: string; market: string; executionMode: string }>> {
    const conditions = [];
    if (marketScope && marketScope.length > 0) {
      conditions.push(inArray(strategyRuntime.market, marketScope));
    }
    if (runtimeIds && runtimeIds.length > 0) {
      conditions.push(inArray(strategyRuntime.id, runtimeIds));
    }
    const where = conditions.length === 0 ? undefined : and(...conditions);
    const rows = await this.db
      .select({
        id: strategyRuntime.id,
        market: strategyRuntime.market,
        executionMode: strategyRuntime.executionMode,
      })
      .from(strategyRuntime)
      .where(where)
      .all();
    return rows;
  }

  /** 单 runtime 处理：load prior → load fills → calc → upsert。 */
  private async processRuntime(
    rt: { id: string; market: string; executionMode: string },
    opts: PnlAttributorRunOptions,
    feeCalculator: FeeCalculator,
    markFetcher: DailyMarkPriceFetcher
  ): Promise<PnlAttributorRuntimeResult> {
    const result: PnlAttributorRuntimeResult = {
      strategyRuntimeId: rt.id,
      market: rt.market,
      symbolsTouched: [],
      fillsScanned: 0,
      snapshotsWritten: 0,
      priorPositionsLoaded: 0,
      markCacheHits: 0,
      markCacheMisses: 0,
      perRunDay: [],
    };

    // 1) load priorPositions
    const priorPositions = await this.loadPriorPositions(rt.id, opts.fromDay);
    result.priorPositionsLoaded = priorPositions.length;

    // 2) load fills within [fromDay, toDay] —— 通过 filledAt 字符串前缀过滤，
    //    再在内存里把 filledAt → trading_day（按 runtime.market）。
    //    边界放宽 1 天，避免 UTC vs market local 时区造成的 fill 漏读。
    const fromBoundary = `${addDays(opts.fromDay, -1)}T00:00:00.000Z`;
    const toBoundary = `${addDays(opts.toDay, 1)}T23:59:59.999Z`;
    const fillRows = await this.db
      .select({
        fillId: fillTable.id,
        fillQty: fillTable.fillQty,
        fillPrice: fillTable.fillPrice,
        fee: fillTable.fee,
        filledAt: fillTable.filledAt,
        orderIntentId: brokerOrder.orderIntentId,
        side: orderIntent.side,
        market: orderIntent.market,
        symbol: orderIntent.symbol,
        workflowRunId: orderIntent.workflowRunId,
        strategyRuntimeId: orderIntent.strategyRuntimeId,
      })
      .from(fillTable)
      .innerJoin(brokerOrder, eq(fillTable.brokerOrderId, brokerOrder.id))
      .innerJoin(orderIntent, eq(brokerOrder.orderIntentId, orderIntent.id))
      .where(
        and(
          eq(orderIntent.strategyRuntimeId, rt.id),
          between(fillTable.filledAt, fromBoundary, toBoundary)
        )
      )
      .all();
    result.fillsScanned = fillRows.length;

    if (fillRows.length === 0 && priorPositions.length === 0) {
      return result;
    }

    // 3) 把 fill 转成 pnl-calc 期望的 PnlFill；按 runtime.market 算 trading_day。
    //    过滤掉落到范围外的（避免边界放宽带回的杂质）。
    //    fee：fill.fee 非 0 直接用；为 0 时调 feeCalculator
    const pnlFills: PnlFill[] = [];
    const dayToWorkflows = new Map<string, Set<string>>();
    for (const r of fillRows) {
      const filledAtDate = new Date(r.filledAt);
      const tradingDay = dateToTradingDay(filledAtDate, rt.market);
      if (tradingDay < opts.fromDay || tradingDay > opts.toDay) continue;
      const symbol = r.symbol ?? "UNKNOWN";
      const market = r.market ?? rt.market;
      // 估 fee（如 fill.fee 已记账则用之；否则 calculator）
      let fee = r.fee ?? 0;
      if (!fee || fee === 0) {
        const broker = inferBroker(rt.executionMode);
        const feeBreakdown = await feeCalculator.calculate({
          broker,
          market,
          assetClass: inferAssetClass(market),
          side: r.side,
          qty: r.fillQty,
          price: r.fillPrice,
          asOf: r.filledAt,
        });
        fee = feeBreakdown.total;
      }
      pnlFills.push({
        id: r.fillId,
        symbol,
        side: r.side,
        qty: r.fillQty,
        price: r.fillPrice,
        fee,
        tradingDay,
        ts: r.filledAt,
        market,
        assetClass: inferAssetClass(market),
        broker: inferBroker(rt.executionMode),
      });
      // 记录 (day, workflow_run) 给后续 skill 归因用
      if (r.workflowRunId) {
        if (!dayToWorkflows.has(tradingDay)) dayToWorkflows.set(tradingDay, new Set());
        dayToWorkflows.get(tradingDay)?.add(r.workflowRunId);
      }
    }

    // 4) 拉 markLookup：所有相关 symbol × day 一次性读出
    const symbolsAll = new Set<string>(priorPositions.map((p) => p.symbol));
    for (const f of pnlFills) symbolsAll.add(f.symbol);
    result.symbolsTouched = Array.from(symbolsAll).sort();
    const markCache = await this.buildMarkCache(
      rt.market,
      Array.from(symbolsAll),
      opts.fromDay,
      opts.toDay,
      markFetcher
    );
    const markLookup: MarkPriceLookup = (symbol, day) => {
      const v = markCache.get(`${symbol}|${day}`);
      if (v !== undefined) {
        result.markCacheHits += 1;
        return v;
      }
      result.markCacheMisses += 1;
      return undefined;
    };

    // 5) 算 PnL
    pnlFills.sort((a, b) =>
      a.tradingDay !== b.tradingDay
        ? a.tradingDay.localeCompare(b.tradingDay)
        : a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id)
    );
    const calcResult = calcPnlSeries({
      fills: pnlFills,
      fromDay: opts.fromDay,
      toDay: opts.toDay,
      market: rt.market,
      priorPositions,
      markLookup,
    });

    // 6) upsert（单事务）
    if (!opts.dryRun) {
      await this.upsertSnapshots(rt.id, calcResult);
      result.snapshotsWritten = calcResult.snapshots.length;
    } else {
      result.snapshotsWritten = 0;
    }

    // 7) 给 P4b-6 / P4b-7 准备 perRunDay 元信息
    const perDayAggregate = new Map<string, { pnl: number; symbols: Set<string> }>();
    for (const s of calcResult.snapshots) {
      const agg = perDayAggregate.get(s.tradingDay) ?? { pnl: 0, symbols: new Set<string>() };
      agg.pnl += s.realizedPnlDaily + s.unrealizedPnlDaily - s.feeDaily;
      agg.symbols.add(s.symbol);
      perDayAggregate.set(s.tradingDay, agg);
    }
    for (const [day, agg] of perDayAggregate) {
      result.perRunDay.push({
        workflowRunIds: Array.from(dayToWorkflows.get(day) ?? []),
        tradingDay: day,
        pnlAttributed: round6(agg.pnl),
        symbols: Array.from(agg.symbols),
      });
    }

    return result;
  }

  /**
   * 取 runtime 在 fromDay 之前每个 symbol 最近一次 snapshot 作为 priorPositions。
   *
   * 如果某 symbol 完全没有历史 snapshot（首次 PnlAttribute）→ 不加入；
   * pnl-calc 会从 0 持仓开始累加该 symbol 的 fills。
   *
   * 走 ORM：先按 symbol 找每个 symbol 的 max(trading_day < fromDay)，再二次取整行。
   * 数据量很小（每 runtime 持仓 symbol 通常 ≤ 数十）—— 不走相关子查询也不会爆。
   */
  private async loadPriorPositions(
    runtimeId: string,
    fromDay: string
  ): Promise<PositionState[]> {
    const maxRows = await this.db
      .select({
        symbol: strategyPnlSnapshot.symbol,
        maxDay: sql<string>`MAX(${strategyPnlSnapshot.tradingDay})`.as("max_day"),
      })
      .from(strategyPnlSnapshot)
      .where(
        and(
          eq(strategyPnlSnapshot.strategyRuntimeId, runtimeId),
          lt(strategyPnlSnapshot.tradingDay, fromDay)
        )
      )
      .groupBy(strategyPnlSnapshot.symbol)
      .all();
    if (maxRows.length === 0) return [];

    const out: PositionState[] = [];
    for (const m of maxRows) {
      const row = await this.db
        .select({
          symbol: strategyPnlSnapshot.symbol,
          qty: strategyPnlSnapshot.qty,
          avgCost: strategyPnlSnapshot.avgCost,
          realizedPnlCum: strategyPnlSnapshot.realizedPnlCum,
          feeCum: strategyPnlSnapshot.feeCum,
        })
        .from(strategyPnlSnapshot)
        .where(
          and(
            eq(strategyPnlSnapshot.strategyRuntimeId, runtimeId),
            eq(strategyPnlSnapshot.symbol, m.symbol),
            eq(strategyPnlSnapshot.tradingDay, m.maxDay)
          )
        )
        .get();
      if (!row) continue;
      out.push({
        symbol: row.symbol,
        qty: row.qty,
        avgCost: row.avgCost ?? 0,
        realizedCum: row.realizedPnlCum,
        feeCum: row.feeCum,
      });
    }
    return out;
  }

  /** 拉 markCache：所有 (symbol, day) 的 close。 */
  private async buildMarkCache(
    market: string,
    symbols: string[],
    fromDay: string,
    toDay: string,
    markFetcher: DailyMarkPriceFetcher
  ): Promise<Map<string, { close: number; source: string }>> {
    const out = new Map<string, { close: number; source: string }>();
    if (symbols.length === 0) return out;
    // 这里宽度上一次性扫整个 day range；为了拿 source 标签，绕过 fetcher.getClosesByDay
    // 直接走 schema 查询；避免每天独立 N 次 sql 调用
    const { dailyMarkPrice } = await import("../../db/sqlite/schema");
    const rows = await this.db
      .select({
        symbol: dailyMarkPrice.symbol,
        tradingDay: dailyMarkPrice.tradingDay,
        close: dailyMarkPrice.close,
        source: dailyMarkPrice.source,
      })
      .from(dailyMarkPrice)
      .where(
        and(
          eq(dailyMarkPrice.market, market),
          inArray(dailyMarkPrice.symbol, symbols),
          between(dailyMarkPrice.tradingDay, fromDay, toDay)
        )
      )
      .all();
    for (const r of rows) {
      out.set(`${r.symbol}|${r.tradingDay}`, { close: r.close, source: r.source });
    }
    // markFetcher 引入是为了 P4b-9 cron 触发 fetch 兜底，本 worker v0 不主动 fetch
    void markFetcher;
    return out;
  }

  /** upsert：(runtime, day, symbol) 唯一；同事务 N 条。 */
  private async upsertSnapshots(runtimeId: string, calc: PnlCalcResult): Promise<void> {
    if (calc.snapshots.length === 0) return;
    await runInTransaction(this.db, async () => {
      for (const s of calc.snapshots) {
        const existing = await this.db
          .select({ id: strategyPnlSnapshot.id })
          .from(strategyPnlSnapshot)
          .where(
            and(
              eq(strategyPnlSnapshot.strategyRuntimeId, runtimeId),
              eq(strategyPnlSnapshot.tradingDay, s.tradingDay),
              eq(strategyPnlSnapshot.symbol, s.symbol)
            )
          )
          .get();
        const values = {
          strategyRuntimeId: runtimeId,
          tradingDay: s.tradingDay,
          symbol: s.symbol,
          qty: s.qty,
          avgCost: s.avgCost,
          markPrice: s.markPrice,
          marketValue: s.marketValue,
          realizedPnlDaily: s.realizedPnlDaily,
          unrealizedPnlDaily: s.unrealizedPnlDaily,
          realizedPnlCum: s.realizedPnlCum,
          unrealizedPnlCum: s.unrealizedPnlCum,
          feeDaily: s.feeDaily,
          feeCum: s.feeCum,
          turnoverDaily: s.turnoverDaily,
          source: SNAPSHOT_SOURCE,
          metadataJson: {
            mark_source: s.markSource,
            fill_count: s.fillCount,
          },
        };
        if (existing) {
          await this.db
            .update(strategyPnlSnapshot)
            .set({
              ...values,
              computedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
            })
            .where(eq(strategyPnlSnapshot.id, existing.id))
            .run();
        } else {
          await this.db
            .insert(strategyPnlSnapshot)
            .values({
              id: `pnl_${randomUUID()}`,
              ...values,
            })
            .run();
        }
      }
    });
  }
}

export function createPnlAttributor(db: DbClient): PnlAttributor {
  return new PnlAttributor(db);
}

// ───────────────────────── helpers ─────────────────────────

function validateDayRange(fromDay: string, toDay: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
    throw new Error(`pnl-attributor: invalid day format "${fromDay}".."${toDay}"`);
  }
  if (fromDay > toDay) {
    throw new Error(`pnl-attributor: fromDay > toDay (${fromDay} > ${toDay})`);
  }
}

function addDays(iso: string, delta: number): string {
  const d = isoDateToDate(iso);
  const next = new Date(d.getTime() + delta * 86_400_000);
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, "0");
  const day = String(next.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function inferBroker(executionMode: string): string {
  // v0：paper / live 都先走 'paper' 兜底费率；实盘细化由 P5 接 trading_account.broker
  if (executionMode === "live") return "*";
  return "paper";
}

function inferAssetClass(market: string): string {
  if (market === "CRYPTO") return "crypto";
  return "stock";
}

function round6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * 把 PnlAttributorRuntimeResult[].perRunDay 拆成 SkillAttributorItem[]：
 *   - 一个 (workflow_run, trading_day) 一项
 *   - 同 runtime 同 day 多个 workflow → 把 pnlAttributed 等权拆分到每个 workflow
 *     （v0 简化；P5+ 可按 workflow 触发的 fill 数量加权）
 */
function flattenPerRunDayToSkillItems(
  results: PnlAttributorRuntimeResult[]
): Array<{
  workflowRunId: string;
  tradingDay: string;
  pnlAttributed: number;
  strategyRuntimeId: string;
}> {
  const out: Array<{
    workflowRunId: string;
    tradingDay: string;
    pnlAttributed: number;
    strategyRuntimeId: string;
  }> = [];
  for (const r of results) {
    for (const day of r.perRunDay) {
      if (day.workflowRunIds.length === 0) continue;
      const pnlPerWorkflow = day.pnlAttributed / day.workflowRunIds.length;
      for (const wfId of day.workflowRunIds) {
        out.push({
          workflowRunId: wfId,
          tradingDay: day.tradingDay,
          pnlAttributed: round6(pnlPerWorkflow),
          strategyRuntimeId: r.strategyRuntimeId,
        });
      }
    }
  }
  return out;
}

