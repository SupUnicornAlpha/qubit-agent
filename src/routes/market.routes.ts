import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { backtestJob } from "../db/sqlite/schema";
import {
  runPythonStrategyBacktestJob,
  runSmaCrossoverBacktestJob,
} from "../runtime/market/backtest-job-runner";
import {
  computeDateRangeForLimit,
  queryBarsRange,
  queryKlines,
  timeframeToPeriod,
} from "../runtime/market/klines-query";
import { detectRegimeFromBars } from "../runtime/market/regime";
import { runStructuredTune } from "../runtime/market/structured-tune";
import { wrapKlinesThrownError } from "../runtime/market/klines-error";
import { queryMarketNewsBrief } from "../runtime/market/news-brief-query";
import {
  getWindSessionStatus,
  invalidateWindBridge,
  loginWindSession,
  reconnectWindSession,
} from "../runtime/market/wind-klines";
import { loadBuiltinConnectorSettings } from "../runtime/config/builtin-connector-settings";
import {
  normalizeExecutionMarket,
  recordExecutionMark,
} from "../runtime/execution/execution-mark-service";

export const marketRouter = new Hono();

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
      return c.json({ ok: false, error: { type: "klines_invalid_request", message: "symbol is required" } }, 400);
    }

    const { bars, meta, error } = await queryKlines({
      symbol,
      exchange: exchange || undefined,
      timeframe,
      limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
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
          : 500;
    console.error("[market/klines]", e);
    return c.json({ ok: false, error: wrapped }, status);
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
      limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
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
        exchange: typeof base.exchange === "string" ? base.exchange : undefined,
        timeframe: typeof base.timeframe === "string" ? base.timeframe : undefined,
        limit: base.limit !== undefined ? Number(base.limit) : undefined,
        startDate: typeof base.startDate === "string" ? base.startDate : undefined,
        endDate: typeof base.endDate === "string" ? base.endDate : undefined,
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
