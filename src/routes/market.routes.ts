import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import { backtestJob } from "../db/sqlite/schema";
import { loadBuiltinConnectorSettings } from "../runtime/config/builtin-connector-settings";
import {
  normalizeExecutionMarket,
  recordExecutionMark,
} from "../runtime/execution/execution-mark-service";
import {
  runPythonStrategyBacktestJob,
  runSmaCrossoverBacktestJob,
} from "../runtime/market/backtest-job-runner";
import { brokerBridgeStatusSnapshot } from "../runtime/market/broker-market-bridge";
import { ensureFutuRuntime, getFutuRuntimeStatus } from "../runtime/market/futu-runtime";
import { wrapKlinesThrownError } from "../runtime/market/klines-error";
import {
  computeDateRangeForLimit,
  queryBarsRange,
  queryKlines,
  timeframeToPeriod,
} from "../runtime/market/klines-query";
import {
  getMarketDataReadiness,
  runMarketDataHealthChecks,
} from "../runtime/market/market-data-health";
import {
  listMarketDataSources,
  patchMarketDataSource,
} from "../runtime/market/market-data-source-control";
import { marketStreamGateway } from "../runtime/market/market-stream-gateway";
import { getOrCreateMarketSnapshot } from "../runtime/market/contracts/market-snapshot-service";
import {
  queryChipDistribution,
  queryMarketOrderBook,
  queryMarketQuote,
  queryMarketTrades,
} from "../runtime/market/microstructure-query";
import { queryMarketNewsBrief } from "../runtime/market/news-brief-query";
import {
  fetchOptionChain,
  type OptionChainRequestSource,
} from "../runtime/market/options-chain";
import {
  analyzeOptionStrategy,
  isOptionStrategyName,
  type OptionStrategyInput,
} from "../runtime/market/options-strategy";
import { detectRegimeFromBars } from "../runtime/market/regime";
import {
  addMarketWatchlistItem,
  getMarketWatchlist,
  parseWatchlistIncludePositionsQuery,
  removeMarketWatchlistItem,
} from "../runtime/market/watchlist-service";
import { runStructuredTune } from "../runtime/market/structured-tune";
import {
  getWindSessionStatus,
  invalidateWindBridge,
  loginWindSession,
  reconnectWindSession,
} from "../runtime/market/wind-klines";

export const marketRouter = new Hono();

/** 真实行情源控制面：能力、凭证、健康、成功率、P95、熔断与优先级。 */
marketRouter.get("/data-sources", async (c) =>
  c.json({ ok: true, data: await listMarketDataSources(), readiness: getMarketDataReadiness() })
);

marketRouter.patch("/data-sources/:id", async (c) => {
  const body = await c.req.json<{
    status?: "active" | "inactive";
    priority?: number;
    isFallback?: boolean;
  }>();
  await patchMarketDataSource(c.req.param("id"), body);
  return c.json({ ok: true, data: await listMarketDataSources() });
});

marketRouter.post("/data-sources/health", async (c) => {
  const body = await c.req.json<{ sourceId?: string }>().catch(() => ({}) as { sourceId?: string });
  const readiness = await runMarketDataHealthChecks(body.sourceId);
  return c.json({ ok: true, data: await listMarketDataSources(), readiness });
});

marketRouter.get("/readiness", (c) => c.json({ ok: true, data: getMarketDataReadiness() }));
marketRouter.get("/stream/metrics", (c) =>
  c.json({ ok: true, data: marketStreamGateway.snapshot() })
);

/** 本机用户自选；只有 `includePositions=1` 才同步打券商持仓。 */
marketRouter.get("/watchlist", async (c) => {
  const includePositions = parseWatchlistIncludePositionsQuery(c.req.query("includePositions"));
  return c.json({ ok: true, data: await getMarketWatchlist({ includePositions }) });
});

marketRouter.post("/watchlist", async (c) => {
  const body = await c.req.json<{ symbol?: string; exchange?: string; label?: string }>();
  try {
    const data = await addMarketWatchlistItem({
      symbol: body.symbol ?? "",
      ...(body.exchange !== undefined ? { exchange: body.exchange } : {}),
      ...(body.label !== undefined ? { label: body.label } : {}),
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : "watchlist_add_failed" }, 400);
  }
});

marketRouter.delete("/watchlist/:symbol", async (c) => {
  const exchange = c.req.query("exchange");
  const data = await removeMarketWatchlistItem({
    symbol: c.req.param("symbol"),
    ...(exchange !== undefined ? { exchange } : {}),
  });
  return c.json({ ok: true, data });
});

/**
 * 冻结研究/回测输入。UI 可在提交回测前调用，随后 backtest_run 只消费该 snapshotId。
 * 这是数据复制，而不是行情订阅或交易授权。
 */
marketRouter.post("/snapshots", async (c) => {
  try {
    const body = await c.req.json<{
      symbols?: string[];
      exchange?: string;
      asOf?: string;
      timeframe?: string;
      limit?: number;
      purpose?: "research" | "backtest";
    }>();
    const symbols = [...new Set((body.symbols ?? []).map((symbol) => symbol.trim()).filter(Boolean))];
    if (symbols.length === 0) return c.json({ ok: false, error: "symbols are required" }, 400);
    const data = await getOrCreateMarketSnapshot({
      symbols,
      ...(body.exchange ? { exchange: body.exchange } : {}),
      ...(body.asOf ? { asOf: body.asOf } : {}),
      purpose: body.purpose ?? "backtest",
      timeframe: body.timeframe ?? "1d",
      ...(body.limit ? { limit: body.limit } : {}),
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : "market_snapshot_failed" },
      400
    );
  }
});

/** Pluggable broker market-data bridges (Futu / IB / SuperMind / …). */
marketRouter.get("/stream/bridges", async (c) =>
  c.json({
    ok: true,
    data: brokerBridgeStatusSnapshot(),
    futuRuntime: await getFutuRuntimeStatus(),
  })
);

marketRouter.post("/stream/bridges/futu/ensure", async (c) => {
  const status = await ensureFutuRuntime();
  return c.json({ ok: true, data: status });
});

marketRouter.get("/quote", async (c) => {
  try {
    const symbol = c.req.query("symbol")?.trim() ?? "";
    const exchange = c.req.query("exchange");
    if (!symbol) return c.json({ ok: false, error: "symbol is required" }, 400);
    const data = await queryMarketQuote({
      symbol,
      ...(exchange ? { exchange } : {}),
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      503
    );
  }
});

/**
 * 期权链：默认券商优先（富途 OpenD），公开 Yahoo 仅作带来源标识的研究级降级。
 * `source=futu` 禁止降级，便于策略 / Agent 显式要求券商行情。
 */
marketRouter.get("/options/chain", async (c) => {
  try {
    const symbol = c.req.query("symbol")?.trim() ?? c.req.query("underlying")?.trim() ?? "";
    const expiry = c.req.query("expiry");
    const exchange = c.req.query("exchange")?.trim();
    const requestedSource = c.req.query("source")?.trim().toLowerCase();
    if (!symbol) return c.json({ ok: false, error: "symbol is required" }, 400);
    if (requestedSource && !["auto", "futu", "alpaca", "research"].includes(requestedSource)) {
      return c.json({ ok: false, error: "source must be auto, futu, alpaca, or research" }, 400);
    }
    const settings = await loadBuiltinConnectorSettings();
    const data = await fetchOptionChain({
      symbol,
      ...(exchange ? { exchange } : {}),
      ...(expiry ? { expiry } : {}),
      ...(requestedSource ? { source: requestedSource as OptionChainRequestSource } : {}),
      settings,
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      503
    );
  }
});

/**
 * Deterministic, read-only multi-leg strategy analysis. The result is a quote
 * snapshot, never an order preview: callers must not treat it as an execution
 * authorization even if its source is a broker observe feed.
 */
marketRouter.get("/options/strategy-analyze", async (c) => {
  try {
    const symbol = c.req.query("symbol")?.trim() ?? c.req.query("underlying")?.trim() ?? "";
    const strategyRaw = c.req.query("strategy")?.trim().toLowerCase() ?? "single";
    const sourceRaw = c.req.query("source")?.trim().toLowerCase() ?? "auto";
    if (!symbol) return c.json({ ok: false, error: "symbol is required" }, 400);
    if (!isOptionStrategyName(strategyRaw)) return c.json({ ok: false, error: "invalid option strategy" }, 400);
    if (!["auto", "futu", "alpaca", "research"].includes(sourceRaw)) {
      return c.json({ ok: false, error: "source must be auto, futu, alpaca, or research" }, 400);
    }
    const exchange = c.req.query("exchange")?.trim();
    const expiry = c.req.query("expiry")?.trim();
    const farExpiry = c.req.query("farExpiry")?.trim() ?? c.req.query("far_expiry")?.trim();
    const numeric = (key: string) => {
      const value = Number(c.req.query(key));
      return Number.isFinite(value) ? value : undefined;
    };
    const settings = await loadBuiltinConnectorSettings();
    const source = sourceRaw as OptionChainRequestSource;
    const chain = await fetchOptionChain({ symbol, ...(exchange ? { exchange } : {}), ...(expiry ? { expiry } : {}), source, settings });
    const needsFarExpiry = strategyRaw === "calendar" || strategyRaw === "diagonal";
    const inferredFarExpiry = chain.expirations.find((date) => !expiry || !date.startsWith(expiry));
    const resolvedFarExpiry = farExpiry || inferredFarExpiry;
    const farChain = needsFarExpiry && resolvedFarExpiry
      ? await fetchOptionChain({ symbol, ...(exchange ? { exchange } : {}), expiry: resolvedFarExpiry, source, settings })
      : null;
    const quote = await queryMarketQuote({ symbol, ...(exchange ? { exchange } : {}) }).catch(() => null);
    const centerStrike = numeric("centerStrike");
    const widthSteps = numeric("widthSteps");
    const quantity = numeric("quantity");
    const singleRight = c.req.query("singleRight");
    const singleSide = c.req.query("singleSide");
    const direction = c.req.query("direction");
    const input: OptionStrategyInput = {
      strategy: strategyRaw,
      ...(centerStrike !== undefined ? { centerStrike } : {}),
      ...(widthSteps !== undefined ? { widthSteps } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(singleRight === "call" || singleRight === "put" ? { singleRight } : {}),
      ...(singleSide === "buy" || singleSide === "sell" ? { singleSide } : {}),
      ...(direction === "bullish" || direction === "bearish" ? { direction } : {}),
    };
    const analysis = analyzeOptionStrategy(input, farChain ? [chain, farChain] : [chain], quote?.lastPrice ?? null);
    return c.json({
      ok: true,
      data: {
        ...analysis,
        underlying: chain.underlying,
        spot: quote?.lastPrice ?? null,
        source: chain.source,
        feedClass: chain.feedClass,
        licenseUse: chain.licenseUse,
        fetchedAt: chain.fetchedAt,
        ...(needsFarExpiry && !farChain ? { warning: "calendar_or_diagonal_requires_a_second_expiry" } : {}),
      },
    });
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503);
  }
});

marketRouter.get("/order-book", async (c) => {
  try {
    const symbol = c.req.query("symbol")?.trim() ?? "";
    const exchange = c.req.query("exchange");
    if (!symbol) return c.json({ ok: false, error: "symbol is required" }, 400);
    const depth = Number(c.req.query("depth") ?? 5);
    const data = await queryMarketOrderBook({
      symbol,
      ...(exchange ? { exchange } : {}),
      depth: Number.isFinite(depth) ? depth : 5,
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      503
    );
  }
});

marketRouter.get("/trades", async (c) => {
  try {
    const symbol = c.req.query("symbol")?.trim() ?? "";
    const exchange = c.req.query("exchange");
    if (!symbol) return c.json({ ok: false, error: "symbol is required" }, 400);
    const limit = Number(c.req.query("limit") ?? 50);
    const data = await queryMarketTrades({
      symbol,
      ...(exchange ? { exchange } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      503
    );
  }
});

marketRouter.get("/chip-distribution", async (c) => {
  try {
    const symbol = c.req.query("symbol")?.trim() ?? "";
    const exchange = c.req.query("exchange");
    if (!symbol) return c.json({ ok: false, error: "symbol is required" }, 400);
    const adjust = c.req.query("adjust");
    const adjustType = adjust === "pre" || adjust === "post" ? adjust : "none";
    const data = await queryChipDistribution({
      symbol,
      ...(exchange ? { exchange } : {}),
      adjustType,
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      503
    );
  }
});

interface SmaBacktestPost {
  kind?: string;
  symbol?: string;
  exchange?: string;
  timeframe?: string;
  limit?: number;
  fastPeriod?: number;
  slowPeriod?: number;
  initialCapital?: number;
  commission?: number;
  startDate?: string;
  endDate?: string;
  /** kind=python_strategy 时使用，user-provided Python on_init/on_bar 源码。 */
  strategyCode?: string;
}

interface RegimeDetectPost {
  symbol?: string;
  exchange?: string;
  timeframe?: string;
  limit?: number;
  startDate?: string;
  endDate?: string;
}

interface StructuredTuneBase {
  symbol?: string;
  exchange?: string;
  timeframe?: string;
  limit?: number;
  startDate?: string;
  endDate?: string;
}

interface StructuredTunePost {
  base?: StructuredTuneBase;
  fastPeriods?: unknown[];
  slowPeriods?: unknown[];
  initialCapital?: number;
  commission?: number;
}

/**
 * OHLCV bars for charting / agents.
 * Query: symbol (required), exchange, timeframe (default 1d), limit (default 300, max 2000).
 */
marketRouter.get("/klines", async (c) => {
  try {
    const symbol = c.req.query("symbol") ?? "";
    const exchange = c.req.query("exchange") ?? "";
    const timeframe = c.req.query("timeframe") ?? c.req.query("tf") ?? undefined;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw !== undefined && limitRaw !== "" ? Number(limitRaw) : undefined;
    if (!symbol.trim()) {
      return c.json(
        { ok: false, error: { type: "klines_invalid_request", message: "symbol is required" } },
        400
      );
    }

    const { bars, meta, error } = await queryKlines({
      symbol,
      ...(exchange ? { exchange } : {}),
      ...(timeframe ? { timeframe } : {}),
      ...(Number.isFinite(limit as number) ? { limit: limit as number } : {}),
    });
    const latest = bars[bars.length - 1];
    if (latest?.close && !error) {
      await recordExecutionMark(await getDb(), {
        market: normalizeExecutionMarket(exchange),
        symbol,
        price: latest.close,
        observedAt: latest.timestamp,
        timeframe: meta.timeframe,
        source: meta.dataSource,
      }).catch(() => undefined);
    }

    return c.json({ ok: true, data: bars, meta, ...(error ? { error } : {}) });
  } catch (e) {
    const wrapped = wrapKlinesThrownError(e);
    const status =
      wrapped.type === "klines_invalid_request"
        ? 400
        : wrapped.type === "klines_connector_unavailable"
          ? 503
          : wrapped.type === "klines_upstream_failed"
            ? 503
            : 500;
    console.error("[market/klines]", e);
    return c.json({ ok: false, error: wrapped }, status);
  }
});

/** 批量 K 线（自选 sparkline 等）；服务端限流并发，复用 queryKlines 缓存。 */
marketRouter.post("/klines/batch", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      requests?: Array<{ symbol?: string; exchange?: string; timeframe?: string; limit?: number }>;
      /** 自选 sparkline：禁止 Yahoo 瀑布，避免拖慢本机自选列表。 */
      fast?: boolean;
    };
    const requests = Array.isArray(body.requests) ? body.requests.slice(0, 30) : [];
    const bestEffort = body.fast === true;
    if (requests.length === 0) {
      return c.json({ ok: true, data: {} as Record<string, unknown> });
    }
    const concurrency = 4;
    const results: Record<
      string,
      { bars: Awaited<ReturnType<typeof queryKlines>>["bars"]; meta: Awaited<ReturnType<typeof queryKlines>>["meta"]; error?: Awaited<ReturnType<typeof queryKlines>>["error"] }
    > = {};
    let cursor = 0;
    const worker = async () => {
      while (cursor < requests.length) {
        const index = cursor++;
        const req = requests[index]!;
        const symbol = String(req.symbol ?? "").trim();
        if (!symbol) continue;
        const exchange = req.exchange?.trim() ?? "";
        const key = `${symbol.toUpperCase()}:${exchange.toUpperCase()}`;
        const { bars, meta, error } = await queryKlines({
          symbol,
          ...(exchange ? { exchange } : {}),
          ...(req.timeframe ? { timeframe: req.timeframe } : {}),
          ...(req.limit !== undefined ? { limit: req.limit } : {}),
          ...(bestEffort ? { bestEffort: true } : {}),
        });
        results[key] = { bars, meta, ...(error ? { error } : {}) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, () => worker()));
    return c.json({ ok: true, data: results });
  } catch (e) {
    const wrapped = wrapKlinesThrownError(e);
    console.error("[market/klines/batch]", e);
    return c.json({ ok: false, error: wrapped }, 500);
  }
});

/** Wind 登录态查询（需本地 Wind 终端 + WindPy）。 */
marketRouter.get("/wind/session", async (c) => {
  try {
    const settings = await loadBuiltinConnectorSettings();
    const session = await getWindSessionStatus(settings);
    return c.json({ ok: true, data: session });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[market/wind/session]", e);
    return c.json({ ok: false, error: msg }, 503);
  }
});

/** 使用配置中心账号密码登录 Wind（或 body 覆盖）。 */
marketRouter.post("/wind/session/login", async (c) => {
  try {
    const settings = await loadBuiltinConnectorSettings();
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      startWaitSec?: number;
    };
    const session = await loginWindSession(settings, {
      ...(body.username ? { username: body.username } : {}),
      ...(body.password ? { password: body.password } : {}),
      ...(body.startWaitSec !== undefined ? { startWaitSec: Number(body.startWaitSec) } : {}),
    });
    return c.json({ ok: true, data: session });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[market/wind/session/login]", e);
    return c.json({ ok: false, error: msg }, 503);
  }
});

/** 断开并重连 Wind（复用已保存凭据或终端已有登录）。 */
marketRouter.post("/wind/session/reconnect", async (c) => {
  try {
    const settings = await loadBuiltinConnectorSettings();
    const session = await reconnectWindSession(settings);
    return c.json({ ok: true, data: session });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[market/wind/session/reconnect]", e);
    return c.json({ ok: false, error: msg }, 503);
  }
});

/** 关闭 Wind 子进程（保存配置后也可调用以强制重建会话）。 */
marketRouter.post("/wind/session/reset", async (c) => {
  try {
    await invalidateWindBridge();
    return c.json({ ok: true, data: { reset: true } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg }, 500);
  }
});

/**
 * 资讯页：个股 Yahoo 头条 RSS + 配置中心 `qubit-news` 补充；板块侧为 Yahoo 行业/板块映射到 sector ETF 的 RSS 头条。
 * Query: symbol（必填）, exchange, limit（默认 12，最大 30）。
 */
marketRouter.get("/news-brief", async (c) => {
  try {
    const symbol = (c.req.query("symbol") ?? "").trim();
    if (!symbol) return c.json({ ok: false, error: "symbol is required" }, 400);
    const exchange = c.req.query("exchange") ?? "";
    const limitRaw = c.req.query("limit");
    const limit = limitRaw !== undefined && limitRaw !== "" ? Number(limitRaw) : undefined;
    const data = await queryMarketNewsBrief({
      symbol,
      exchange,
      ...(Number.isFinite(limit as number) ? { limit: limit as number } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[market/news-brief]", e);
    return c.json({ ok: false, error: msg }, 500);
  }
});

/**
 * Submit server-side backtest (sync execution, persisted job row).
 *
 * 支持两种 kind：
 *   - "sma_crossover"（默认）：固定 SMA 双均线策略，参数从 fastPeriod/slowPeriod 读取。
 *   - "python_strategy"：执行 body.strategyCode 中的 on_init/on_bar，bar-by-bar 真实回测。
 */
marketRouter.post("/backtests", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SmaBacktestPost;
  const kind = String(body.kind ?? "sma_crossover");
  if (kind !== "sma_crossover" && kind !== "python_strategy") {
    return c.json({ ok: false, error: `Unsupported kind: ${kind}` }, 400);
  }
  const symbol = String(body.symbol ?? "").trim();
  if (!symbol) return c.json({ ok: false, error: "symbol is required" }, 400);
  if (kind === "python_strategy" && !String(body.strategyCode ?? "").trim()) {
    return c.json({ ok: false, error: "strategyCode is required for python_strategy" }, 400);
  }

  const jobId = crypto.randomUUID();
  const db = await getDb();
  await db.insert(backtestJob).values({
    id: jobId,
    status: "queued",
    kind,
    paramsJson: body as Record<string, unknown>,
  });

  try {
    if (kind === "python_strategy") {
      await runPythonStrategyBacktestJob(jobId, body as Record<string, unknown>);
    } else {
      await runSmaCrossoverBacktestJob(jobId, body as Record<string, unknown>);
    }
    const row = await db.select().from(backtestJob).where(eq(backtestJob.id, jobId)).limit(1);
    const r = row[0];
    return c.json(
      {
        ok: true,
        data: {
          id: jobId,
          status: r?.status,
          result: r?.resultJson,
          error: r?.error,
        },
      },
      201
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const row = await db.select().from(backtestJob).where(eq(backtestJob.id, jobId)).limit(1);
    return c.json(
      {
        ok: false,
        error: msg,
        data: { id: jobId, status: row[0]?.status ?? "failed", error: row[0]?.error ?? msg },
      },
      500
    );
  }
});

marketRouter.get("/backtests/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const db = await getDb();
  const row = await db.select().from(backtestJob).where(eq(backtestJob.id, jobId)).limit(1);
  const r = row[0];
  if (!r) return c.json({ ok: false, error: "Not found" }, 404);
  return c.json({
    ok: true,
    data: {
      id: r.id,
      status: r.status,
      kind: r.kind,
      paramsJson: r.paramsJson,
      resultJson: r.resultJson,
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    },
  });
});

/** Rule-based regime from recent closes (synchronous). */
marketRouter.post("/experiments/regime/detect", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as RegimeDetectPost;
    const symbol = String(body.symbol ?? "").trim();
    if (!symbol) return c.json({ ok: false, error: "symbol is required" }, 400);
    const exchange = String(body.exchange ?? "");
    const timeframe = String(body.timeframe ?? "1d");
    const limit = Math.max(20, Math.min(Number(body.limit ?? 120), 2000));
    const startRaw = body.startDate;
    const endRaw = body.endDate;
    let period = timeframeToPeriod(timeframe);
    let startDate: string;
    let endDate: string;
    if (typeof startRaw === "string" && typeof endRaw === "string" && startRaw && endRaw) {
      startDate = startRaw;
      endDate = endRaw;
      period = timeframeToPeriod(timeframe);
    } else {
      const r = computeDateRangeForLimit(timeframe, limit);
      startDate = r.startDate;
      endDate = r.endDate;
      period = r.period;
    }
    const bars = await queryBarsRange({ symbol, exchange, period, startDate, endDate });
    const regime = detectRegimeFromBars(bars);
    return c.json({
      ok: true,
      data: { ...regime, barCount: bars.length, period, startDate, endDate },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[market/regime]", e);
    return c.json({ ok: false, error: msg }, 500);
  }
});

/** Grid search over SMA periods (sync, max 50 trials). */
marketRouter.post("/experiments/structured-tune", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as StructuredTunePost;
    const base = body.base ?? {};
    const symbol = String(base.symbol ?? "").trim();
    if (!symbol) return c.json({ ok: false, error: "base.symbol is required" }, 400);
    const fastPeriods = Array.isArray(body.fastPeriods)
      ? body.fastPeriods.map((x) => Number(x)).filter((x) => Number.isFinite(x))
      : [3, 5, 8];
    const slowPeriods = Array.isArray(body.slowPeriods)
      ? body.slowPeriods.map((x) => Number(x)).filter((x) => Number.isFinite(x))
      : [15, 20, 30];
    const out = await runStructuredTune({
      base: {
        symbol,
        ...(typeof base.exchange === "string" ? { exchange: base.exchange } : {}),
        ...(typeof base.timeframe === "string" ? { timeframe: base.timeframe } : {}),
        ...(base.limit !== undefined ? { limit: Number(base.limit) } : {}),
        ...(typeof base.startDate === "string" ? { startDate: base.startDate } : {}),
        ...(typeof base.endDate === "string" ? { endDate: base.endDate } : {}),
      },
      fastPeriods,
      slowPeriods,
      initialCapital: Number(body.initialCapital ?? 10_000),
      commission: Number(body.commission ?? 0.001),
    });
    return c.json({ ok: true, data: out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[market/structured-tune]", e);
    return c.json({ ok: false, error: msg }, 500);
  }
});
