/**
 * /api/v1/factors — 因子管理与计算/评估
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.1
 */

import { Hono } from "hono";
import {
  factorService,
  FactorServiceError,
  type FactorCategory,
  type FactorLang,
  type FactorStatus,
} from "../runtime/factor/factor-service";
import type { FactorComputeRow } from "../runtime/provider/types";

export const factorRouter = new Hono();

function asError(e: unknown) {
  if (e instanceof FactorServiceError) {
    return { ok: false, code: e.code, error: e.message } as const;
  }
  return { ok: false, code: "internal_error", error: (e as Error).message } as const;
}

/** GET /api/v1/factors?project_id=&category=&status= */
factorRouter.get("/", async (c) => {
  try {
    const data = await factorService.list({
      ...(c.req.query("project_id") ? { projectId: c.req.query("project_id")! } : {}),
      ...(c.req.query("category")
        ? { category: c.req.query("category") as FactorCategory }
        : {}),
      ...(c.req.query("status")
        ? { status: c.req.query("status") as FactorStatus }
        : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 500);
  }
});

/** GET /api/v1/factors/:id */
factorRouter.get("/:id", async (c) => {
  try {
    const data = await factorService.get(c.req.param("id"));
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 404);
  }
});

/** POST /api/v1/factors */
factorRouter.post("/", async (c) => {
  try {
    const body = await c.req.json<{
      projectId: string;
      name: string;
      category: FactorCategory;
      expr: string;
      lang?: FactorLang;
      universe?: string;
      horizon?: number;
      status?: FactorStatus;
      providerKey?: string;
      definition?: Record<string, unknown>;
    }>();
    const data = await factorService.register({
      projectId: body.projectId,
      name: body.name,
      category: body.category,
      expr: body.expr,
      ...(body.lang ? { lang: body.lang } : {}),
      ...(body.universe ? { universe: body.universe } : {}),
      ...(body.horizon !== undefined ? { horizon: body.horizon } : {}),
      ...(body.status ? { status: body.status } : {}),
      ...(body.providerKey ? { providerKey: body.providerKey } : {}),
      ...(body.definition ? { definition: body.definition } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** PATCH /api/v1/factors/:id  { status } */
factorRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: FactorStatus }>();
  if (body.status !== "draft" && body.status !== "active" && body.status !== "archived") {
    return c.json({ ok: false, error: "invalid_status" }, 400);
  }
  try {
    await factorService.setStatus(id, body.status);
    return c.json({ ok: true });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** POST /api/v1/factors/:id/compute  { startDate, endDate, symbols?, providerKey? } */
factorRouter.post("/:id/compute", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json<{
      startDate: string;
      endDate: string;
      symbols?: string[];
      providerKey?: string;
    }>();
    const data = await factorService.compute({
      factorId: id,
      startDate: body.startDate,
      endDate: body.endDate,
      ...(body.symbols && body.symbols.length > 0 ? { symbols: body.symbols } : {}),
      ...(body.providerKey ? { providerKey: body.providerKey } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** POST /api/v1/factors/:id/evaluate  { values, futureReturns?, asof?, providerKey? } */
factorRouter.post("/:id/evaluate", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json<{
      values: FactorComputeRow[];
      futureReturns?: FactorComputeRow[];
      asof?: string;
      providerKey?: string;
    }>();
    const data = await factorService.evaluate({
      factorId: id,
      values: body.values ?? [],
      ...(body.futureReturns ? { futureReturns: body.futureReturns } : {}),
      ...(body.asof ? { asof: body.asof } : {}),
      ...(body.providerKey ? { providerKey: body.providerKey } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/**
 * POST /api/v1/factors/:id/auto-evaluate
 * {
 *   startDate, endDate, symbols?, horizonDays?, decayHorizons?, groupCount?, providerKey?
 * }
 * 自动从 DuckDB 拉因子值 + 拉行情算未来收益，得到 IC/IR/decay/group。
 */
factorRouter.post("/:id/auto-evaluate", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json<{
      startDate: string;
      endDate: string;
      symbols?: string[];
      horizonDays?: number;
      decayHorizons?: number[];
      groupCount?: number;
      providerKey?: string;
    }>();
    const data = await factorService.autoEvaluate({
      factorId: id,
      startDate: body.startDate,
      endDate: body.endDate,
      ...(body.symbols && body.symbols.length > 0 ? { symbols: body.symbols } : {}),
      ...(typeof body.horizonDays === "number" ? { horizonDays: body.horizonDays } : {}),
      ...(body.decayHorizons ? { decayHorizons: body.decayHorizons } : {}),
      ...(typeof body.groupCount === "number" ? { groupCount: body.groupCount } : {}),
      ...(body.providerKey ? { providerKey: body.providerKey } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** GET /api/v1/factors/:id/values?symbols=...&startDate=...&endDate=...&latestN=... */
factorRouter.get("/:id/values", async (c) => {
  const id = c.req.param("id");
  try {
    const symbolsQ = c.req.query("symbols");
    const latestNQ = c.req.query("latestN");
    const data = await factorService.loadValues({
      factorId: id,
      ...(symbolsQ ? { symbols: symbolsQ.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      ...(c.req.query("startDate") ? { startDate: c.req.query("startDate")! } : {}),
      ...(c.req.query("endDate") ? { endDate: c.req.query("endDate")! } : {}),
      ...(latestNQ && Number(latestNQ) > 0 ? { latestN: Math.floor(Number(latestNQ)) } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 500);
  }
});

/** GET /api/v1/factors/:id/values/stats */
factorRouter.get("/:id/values/stats", async (c) => {
  const id = c.req.param("id");
  try {
    const data = await factorService.valuesStats(id);
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 500);
  }
});

/** GET /api/v1/factors/:id/evaluations */
factorRouter.get("/:id/evaluations", async (c) => {
  const id = c.req.param("id");
  const limitQ = Number(c.req.query("limit") ?? "20");
  const limit = Number.isFinite(limitQ) ? Math.min(200, Math.max(1, Math.floor(limitQ))) : 20;
  try {
    const data = await factorService.listEvaluations(id, limit);
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 500);
  }
});
