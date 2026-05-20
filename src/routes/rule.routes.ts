/**
 * /api/v1/rules — 规则管理与执行
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.2
 */

import { Hono } from "hono";
import {
  ruleService,
  RuleServiceError,
  type RuleAppliesTo,
  type RuleLang,
  type RuleStatus,
} from "../runtime/rule/rule-service";
import type { RuleEvalContext } from "../runtime/provider/types";

export const ruleRouter = new Hono();

function asError(e: unknown) {
  if (e instanceof RuleServiceError) {
    return { ok: false, code: e.code, error: e.message } as const;
  }
  return { ok: false, code: "internal_error", error: (e as Error).message } as const;
}

/** GET /api/v1/rules?project_id=&applies_to=&status= */
ruleRouter.get("/", async (c) => {
  try {
    const data = await ruleService.list({
      ...(c.req.query("project_id") ? { projectId: c.req.query("project_id")! } : {}),
      ...(c.req.query("applies_to")
        ? { appliesTo: c.req.query("applies_to") as RuleAppliesTo }
        : {}),
      ...(c.req.query("status") ? { status: c.req.query("status") as RuleStatus } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 500);
  }
});

/** GET /api/v1/rules/:id */
ruleRouter.get("/:id", async (c) => {
  try {
    const data = await ruleService.get(c.req.param("id"));
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 404);
  }
});

/** POST /api/v1/rules */
ruleRouter.post("/", async (c) => {
  try {
    const body = await c.req.json<{
      projectId: string;
      name: string;
      description?: string;
      appliesTo?: RuleAppliesTo;
      lang?: RuleLang;
      dsl: unknown;
      status?: RuleStatus;
      providerKey?: string;
    }>();
    const data = await ruleService.register({
      projectId: body.projectId,
      name: body.name,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.appliesTo ? { appliesTo: body.appliesTo } : {}),
      ...(body.lang ? { lang: body.lang } : {}),
      dsl: body.dsl,
      ...(body.status ? { status: body.status } : {}),
      ...(body.providerKey ? { providerKey: body.providerKey } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** PATCH /api/v1/rules/:id  { status } */
ruleRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: RuleStatus }>();
  if (body.status !== "draft" && body.status !== "active" && body.status !== "archived") {
    return c.json({ ok: false, error: "invalid_status" }, 400);
  }
  try {
    await ruleService.setStatus(id, body.status);
    return c.json({ ok: true });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** POST /api/v1/rules/:id/evaluate  { context, providerKey? } */
ruleRouter.post("/:id/evaluate", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json<{ context: RuleEvalContext; providerKey?: string }>();
    if (!body.context || typeof body.context !== "object") {
      return c.json({ ok: false, error: "context_required" }, 400);
    }
    const data = await ruleService.evaluate({
      ruleId: id,
      context: body.context,
      ...(body.providerKey ? { providerKey: body.providerKey } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** GET /api/v1/rules/:id/logs */
ruleRouter.get("/:id/logs", async (c) => {
  const id = c.req.param("id");
  const limitQ = Number(c.req.query("limit") ?? "50");
  const limit = Number.isFinite(limitQ) ? Math.min(500, Math.max(1, Math.floor(limitQ))) : 50;
  try {
    const data = await ruleService.listEvaluationLogs(id, limit);
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 500);
  }
});
