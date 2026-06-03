/**
 * Self-Evolving Agent P4b — PnL 对账脚本。
 *
 * 用途：
 *   把"原始 fill 流水合计"与"strategy_pnl_snapshot 物化结果"做对照，找出 worker 漏算 /
 *   错算的边界 case。典型场景：
 *     - PnlAttributor 还没跑到某 runtime（snapshot 缺）
 *     - fill 出在窗口外但 trading_day 落进窗口（边界放宽 buffer 问题）
 *     - upsert 失败造成 snapshot 数据陈旧
 *     - fee 估算和实际不一致
 *
 * 算法（v0 简单口径）：
 *   对范围 [fromDay, toDay] 内每个 runtime × symbol：
 *     A = SUM(|fill.fillQty * fill.fillPrice|) 经 fill→broker_order→order_intent
 *     B = SUM(strategy_pnl_snapshot.turnoverDaily)
 *     drift = |A - B| / max(1, A)
 *   drift > tolerance → 入报告。
 *
 * 用法：
 *   bun run src/scripts/run-pnl-reconcile.ts --from=2026-05-27 --to=2026-06-03 [--tolerance=0.001] [--json]
 *
 * 退出码：
 *   0 = 无漂移；1 = 有漂移 / 缺 snapshot；2 = 参数错 / 内部异常
 */

import { and, between, eq, sql } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { runMigrations } from "../db/sqlite/migrate";
import {
  brokerOrder,
  fill as fillTable,
  orderIntent,
  strategyPnlSnapshot,
  strategyRuntime,
} from "../db/sqlite/schema";

interface CliArgs {
  from?: string;
  to?: string;
  tolerance: number;
  json: boolean;
}

interface DriftEntry {
  strategyRuntimeId: string;
  market: string;
  symbol: string;
  fillTurnover: number;
  snapshotTurnover: number;
  driftAbs: number;
  driftRatio: number;
  reason: "snapshot_missing" | "turnover_mismatch";
}

interface ReconcileReport {
  fromDay: string;
  toDay: string;
  tolerance: number;
  scannedRuntimes: number;
  scannedSymbols: number;
  driftCount: number;
  drifts: DriftEntry[];
  computedAt: string;
  elapsedMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { tolerance: 0.001, json: false };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const val = eq >= 0 ? raw.slice(eq + 1) : "true";
    if (key === "from") args.from = val;
    else if (key === "to") args.to = val;
    else if (key === "tolerance") args.tolerance = Math.max(0, Number(val) || 0.001);
    else if (key === "json") args.json = val !== "false";
  }
  return args;
}

function usage(): void {
  console.error(
    "Usage: bun run run-pnl-reconcile.ts --from=YYYY-MM-DD --to=YYYY-MM-DD [--tolerance=0.001] [--json]"
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from || !args.to) {
    usage();
    process.exit(2);
  }

  await runMigrations();
  const db = await getDb();
  const t0 = Date.now();
  const report = await reconcile(db, args.from, args.to, args.tolerance);
  report.elapsedMs = Date.now() - t0;

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMarkdown(report));
  }

  process.exit(report.driftCount === 0 ? 0 : 1);
}

async function reconcile(
  db: Awaited<ReturnType<typeof getDb>>,
  fromDay: string,
  toDay: string,
  tolerance: number
): Promise<ReconcileReport> {
  // 1) 拉 fill 端：聚合 (runtime, symbol) 的 turnover。窗口宽放 1 天 buffer 防时区漏读。
  const fromBoundary = `${addDays(fromDay, -1)}T00:00:00.000Z`;
  const toBoundary = `${addDays(toDay, 1)}T23:59:59.999Z`;
  const fillAgg = await db
    .select({
      strategyRuntimeId: orderIntent.strategyRuntimeId,
      symbol: orderIntent.symbol,
      market: orderIntent.market,
      turnover: sql<number>`COALESCE(SUM(${fillTable.fillQty} * ${fillTable.fillPrice}), 0)`.as(
        "turnover"
      ),
    })
    .from(fillTable)
    .innerJoin(brokerOrder, eq(fillTable.brokerOrderId, brokerOrder.id))
    .innerJoin(orderIntent, eq(brokerOrder.orderIntentId, orderIntent.id))
    .where(between(fillTable.filledAt, fromBoundary, toBoundary))
    .groupBy(orderIntent.strategyRuntimeId, orderIntent.symbol, orderIntent.market)
    .all();

  // 2) 拉 snapshot 端：聚合 (runtime, symbol) 的 turnover_daily 求和
  const snapshotAgg = await db
    .select({
      strategyRuntimeId: strategyPnlSnapshot.strategyRuntimeId,
      symbol: strategyPnlSnapshot.symbol,
      turnover: sql<number>`COALESCE(SUM(${strategyPnlSnapshot.turnoverDaily}), 0)`.as(
        "turnover"
      ),
    })
    .from(strategyPnlSnapshot)
    .where(
      and(
        sql`${strategyPnlSnapshot.tradingDay} >= ${fromDay}`,
        sql`${strategyPnlSnapshot.tradingDay} <= ${toDay}`
      )
    )
    .groupBy(strategyPnlSnapshot.strategyRuntimeId, strategyPnlSnapshot.symbol)
    .all();
  const snapshotMap = new Map(
    snapshotAgg.map((s) => [`${s.strategyRuntimeId}|${s.symbol}`, s.turnover])
  );

  // 3) 拉 runtime meta（市场名展示用）
  const runtimes = await db
    .select({ id: strategyRuntime.id, market: strategyRuntime.market })
    .from(strategyRuntime)
    .all();
  const runtimeMarket = new Map(runtimes.map((r) => [r.id, r.market]));

  // 4) 对照
  const scannedRuntimes = new Set<string>();
  const scannedSymbols = new Set<string>();
  const drifts: DriftEntry[] = [];
  for (const f of fillAgg) {
    if (!f.strategyRuntimeId) continue; // 手动下单 fill 无 strategy_runtime
    scannedRuntimes.add(f.strategyRuntimeId);
    scannedSymbols.add(f.symbol ?? "");
    const key = `${f.strategyRuntimeId}|${f.symbol}`;
    const snap = snapshotMap.get(key);
    const fillTurnover = Math.abs(f.turnover);
    if (snap === undefined) {
      drifts.push({
        strategyRuntimeId: f.strategyRuntimeId,
        market: runtimeMarket.get(f.strategyRuntimeId) ?? f.market ?? "?",
        symbol: f.symbol ?? "?",
        fillTurnover,
        snapshotTurnover: 0,
        driftAbs: fillTurnover,
        driftRatio: 1,
        reason: "snapshot_missing",
      });
      continue;
    }
    const driftAbs = Math.abs(fillTurnover - snap);
    const driftRatio = driftAbs / Math.max(1, fillTurnover);
    if (driftRatio > tolerance) {
      drifts.push({
        strategyRuntimeId: f.strategyRuntimeId,
        market: runtimeMarket.get(f.strategyRuntimeId) ?? f.market ?? "?",
        symbol: f.symbol ?? "?",
        fillTurnover,
        snapshotTurnover: snap,
        driftAbs,
        driftRatio,
        reason: "turnover_mismatch",
      });
    }
  }

  drifts.sort((a, b) => b.driftRatio - a.driftRatio);

  return {
    fromDay,
    toDay,
    tolerance,
    scannedRuntimes: scannedRuntimes.size,
    scannedSymbols: scannedSymbols.size,
    driftCount: drifts.length,
    drifts,
    computedAt: new Date().toISOString(),
    elapsedMs: 0,
  };
}

function renderMarkdown(r: ReconcileReport): string {
  const lines: string[] = [];
  lines.push("# PnL Reconcile Report");
  lines.push("");
  lines.push(`- Range: \`${r.fromDay}\` ~ \`${r.toDay}\``);
  lines.push(`- Tolerance: ${(r.tolerance * 100).toFixed(2)}%`);
  lines.push(`- Scanned runtimes: ${r.scannedRuntimes}`);
  lines.push(`- Scanned (runtime, symbol) pairs: ${r.scannedSymbols}`);
  lines.push(`- Drifts: **${r.driftCount}**`);
  lines.push(`- Elapsed: ${r.elapsedMs} ms`);
  if (r.drifts.length === 0) {
    lines.push("");
    lines.push("✓ 无漂移。");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("| runtime | market | symbol | reason | fill turnover | snapshot turnover | drift ratio |");
  lines.push("|---|---|---|---|---:|---:|---:|");
  for (const d of r.drifts.slice(0, 50)) {
    lines.push(
      `| \`${d.strategyRuntimeId}\` | ${d.market} | ${d.symbol} | ${d.reason} | ${d.fillTurnover.toFixed(2)} | ${d.snapshotTurnover.toFixed(2)} | ${(d.driftRatio * 100).toFixed(2)}% |`
    );
  }
  if (r.drifts.length > 50) {
    lines.push(`*（截断；共 ${r.drifts.length} 行）*`);
  }
  return lines.join("\n");
}

function addDays(iso: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`run-pnl-reconcile: invalid date "${iso}"`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const next = new Date(d.getTime() + delta * 86_400_000);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

main().catch((err) => {
  console.error("[pnl-reconcile] fatal:", err);
  process.exit(2);
});
