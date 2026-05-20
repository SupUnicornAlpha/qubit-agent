/**
 * /api/v1/strategy-compositions — 因子+规则组合的定义与执行
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.3
 */

import { Hono } from "hono";
import {
  strategyComposer,
  StrategyComposerError,
  type StrategyKind,
  type WeightMethod,
} from "../runtime/strategy/strategy-composer";

export const strategyCompositionRouter = new Hono();

function asError(e: unknown) {
  if (e instanceof StrategyComposerError) {
    return { ok: false, code: e.code, error: e.message } as const;
  }
  return { ok: false, code: "internal_error", error: (e as Error).message } as const;
}

/** GET /api/v1/strategy-compositions?strategy_version_id=xxx */
strategyCompositionRouter.get("/", async (c) => {
  const svid = c.req.query("strategy_version_id");
  if (!svid) return c.json({ ok: false, error: "strategy_version_id_required" }, 400);
  try {
    const data = await strategyComposer.listByVersion(svid);
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 500);
  }
});

/** GET /api/v1/strategy-compositions/:id */
strategyCompositionRouter.get("/:id", async (c) => {
  try {
    const data = await strategyComposer.get(c.req.param("id"));
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 404);
  }
});

/** POST /api/v1/strategy-compositions */
strategyCompositionRouter.post("/", async (c) => {
  try {
    const body = await c.req.json<{
      strategyVersionId: string;
      kind: StrategyKind;
      factorIds?: string[];
      ruleIds?: string[];
      weightMethod?: WeightMethod;
      factorWeights?: Record<string, number>;
      rebalanceFreq?: string;
      universe?: string;
      params?: Record<string, unknown>;
    }>();
    const data = await strategyComposer.define({
      strategyVersionId: body.strategyVersionId,
      kind: body.kind,
      ...(body.factorIds ? { factorIds: body.factorIds } : {}),
      ...(body.ruleIds ? { ruleIds: body.ruleIds } : {}),
      ...(body.weightMethod ? { weightMethod: body.weightMethod } : {}),
      ...(body.factorWeights ? { factorWeights: body.factorWeights } : {}),
      ...(body.rebalanceFreq ? { rebalanceFreq: body.rebalanceFreq } : {}),
      ...(body.universe ? { universe: body.universe } : {}),
      ...(body.params ? { params: body.params } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** POST /api/v1/strategy-compositions/:id/execute */
strategyCompositionRouter.post("/:id/execute", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json<{
      asof: string;
      startDate: string;
      endDate: string;
      symbols?: string[];
      extraContext?: Record<string, unknown>;
    }>();
    const data = await strategyComposer.execute({
      compositionId: id,
      asof: body.asof,
      startDate: body.startDate,
      endDate: body.endDate,
      ...(body.symbols && body.symbols.length > 0 ? { symbols: body.symbols } : {}),
      ...(body.extraContext ? { extraContext: body.extraContext } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});
