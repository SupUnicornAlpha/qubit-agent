/**
 * /api/v1/discovery-jobs — 因子挖掘任务
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.4
 */

import { Hono } from "hono";
import {
  discoveryService,
  DiscoveryError,
  type DiscoveryKind,
  type DiscoverySubmitInput,
} from "../runtime/discovery/discovery-service";

export const discoveryRouter = new Hono();

function asError(e: unknown) {
  if (e instanceof DiscoveryError) {
    return { ok: false, code: e.code, error: e.message } as const;
  }
  return { ok: false, code: "internal_error", error: (e as Error).message } as const;
}

/** GET /api/v1/discovery-jobs?project_id=&kind= */
discoveryRouter.get("/", async (c) => {
  try {
    const data = await discoveryService.list({
      ...(c.req.query("project_id") ? { projectId: c.req.query("project_id")! } : {}),
      ...(c.req.query("kind") ? { kind: c.req.query("kind") as DiscoveryKind } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 500);
  }
});

/** GET /api/v1/discovery-jobs/:id */
discoveryRouter.get("/:id", async (c) => {
  try {
    const data = await discoveryService.get(c.req.param("id"));
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 404);
  }
});

/** POST /api/v1/discovery-jobs */
discoveryRouter.post("/", async (c) => {
  try {
    const body = await c.req.json<DiscoverySubmitInput>();
    const data = await discoveryService.submit(body);
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** POST /api/v1/discovery-jobs/:id/run */
discoveryRouter.post("/:id/run", async (c) => {
  try {
    const data = await discoveryService.run(c.req.param("id"));
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** POST /api/v1/discovery-jobs/run-now */
discoveryRouter.post("/run-now", async (c) => {
  try {
    const body = await c.req.json<DiscoverySubmitInput>();
    const data = await discoveryService.submitAndRun(body);
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/**
 * POST /api/v1/discovery-jobs/:id/candidates/:candidateId/promote
 * {
 *   name: string;
 *   category?: FactorCategory;
 *   status?: FactorStatus;
 * }
 * 把指定候选 promote 为 project 下的正式 factor_definition。
 */
discoveryRouter.post("/:id/candidates/:candidateId/promote", async (c) => {
  try {
    const jobId = c.req.param("id");
    const candidateId = c.req.param("candidateId");
    const body = await c.req.json<{
      name: string;
      category?:
        | "value"
        | "momentum"
        | "volatility"
        | "news"
        | "quality"
        | "macro";
      status?: "draft" | "active" | "archived";
    }>();
    const data = await discoveryService.promoteCandidate(jobId, candidateId, body);
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});
