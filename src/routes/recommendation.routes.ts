import { Hono } from "hono";
import { evaluateRecommendationOutcomes } from "../runtime/effect-validation/recommendation-outcome-evaluator";
import {
  type RecommendationSide,
  type RecommendationStatus,
  recommendationService,
} from "../runtime/effect-validation/recommendation-service";

export const recommendationRouter = new Hono();

recommendationRouter.get("/", async (c) => {
  try {
    const projectId = c.req.query("project_id");
    const symbol = c.req.query("symbol");
    const side = c.req.query("side") as RecommendationSide | undefined;
    const status = c.req.query("status") as RecommendationStatus | undefined;
    const data = await recommendationService.list({
      ...(projectId ? { projectId } : {}),
      ...(symbol ? { symbol } : {}),
      ...(side ? { side } : {}),
      ...(status ? { status } : {}),
      ...(c.req.query("limit") ? { limit: Number(c.req.query("limit")) } : {}),
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      400
    );
  }
});

recommendationRouter.get("/stats", async (c) => {
  try {
    const data = await recommendationService.stats(c.req.query("project_id"));
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
});

recommendationRouter.post("/outcomes/run", async (c) => {
  try {
    const body = await c.req
      .json<{ projectId?: string; limit?: number; force?: boolean }>()
      .catch(() => ({}) as { projectId?: string; limit?: number; force?: boolean });
    const data = await evaluateRecommendationOutcomes({
      ...(body.projectId ? { projectId: body.projectId } : {}),
      ...(body.limit != null ? { limit: body.limit } : {}),
      ...(body.force != null ? { force: body.force } : {}),
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
});

recommendationRouter.get("/:id", async (c) => {
  try {
    const data = await recommendationService.get(c.req.param("id"));
    if (!data) return c.json({ ok: false, error: "recommendation_not_found" }, 404);
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
});

recommendationRouter.patch("/:id/status", async (c) => {
  try {
    const body = await c.req.json<{ status: RecommendationStatus }>();
    if (!["draft", "active", "closed", "expired", "invalidated"].includes(body.status)) {
      return c.json({ ok: false, error: "invalid_status" }, 400);
    }
    const data = await recommendationService.setStatus(c.req.param("id"), body.status);
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      400
    );
  }
});
