import { Hono } from "hono";
import {
  componentChallengerService,
  resolveShadowVariant,
} from "../runtime/governance/component-challenger-service";
import { getResearchIntegrityReview } from "../runtime/governance/research-integrity-review-service";
import { getStrategyConsistencyReport } from "../runtime/governance/strategy-consistency-service";

export const governanceRouter = new Hono();

/** Read-only joint projection; it intentionally never promotes a component or strategy. */
governanceRouter.get("/research-integrity-review", async (c) => {
  const projectId = c.req.query("projectId")?.trim();
  if (!projectId) return c.json({ ok: false, error: "projectId is required" }, 400);
  return c.json({ ok: true, data: await getResearchIntegrityReview(projectId) });
});

governanceRouter.post("/component-evaluations", async (c) => {
  const body = await c.req.json<Parameters<typeof componentChallengerService.record>[0]>();
  if (
    !body.projectId ||
    !body.componentKind ||
    !body.componentId ||
    !body.versionId ||
    !body.evalKind ||
    !body.comparisonCohortId
  ) {
    return c.json({ ok: false, error: "missing_required_fields" }, 400);
  }
  // Runtime evidence must be produced by the authoritative paper/shadow
  // evaluators, not asserted by a generic API caller. Otherwise an arbitrary
  // client could manufacture the second half of a promotion scorecard.
  if (body.evalKind !== "offline") {
    return c.json(
      {
        ok: false,
        error: "component_runtime_evidence_must_be_captured_by_authoritative_evaluator",
      },
      403
    );
  }
  return c.json({ ok: true, data: await componentChallengerService.record(body) }, 201);
});

governanceRouter.post("/component-challengers/compare", async (c) => {
  const body = await c.req.json<Parameters<typeof componentChallengerService.compare>[0]>();
  if (
    !body.projectId ||
    !body.componentKind ||
    !body.componentId ||
    !body.challengerVersionId ||
    !body.comparisonCohortId
  ) {
    return c.json({ ok: false, error: "missing_required_fields" }, 400);
  }
  return c.json({ ok: true, data: await componentChallengerService.compare(body) });
});

governanceRouter.post("/shadow/resolve", async (c) => {
  const body = await c.req.json<Parameters<typeof resolveShadowVariant>[0]>();
  if (!body.allocationKey) return c.json({ ok: false, error: "allocationKey is required" }, 400);
  return c.json({ ok: true, data: { variant: resolveShadowVariant(body), autoPromotion: false } });
});

governanceRouter.get("/strategy-consistency", async (c) => {
  const projectId = c.req.query("projectId")?.trim();
  const strategyVersionId = c.req.query("strategyVersionId")?.trim();
  if (!projectId || !strategyVersionId) {
    return c.json({ ok: false, error: "projectId and strategyVersionId are required" }, 400);
  }
  const toleranceValue = Number(c.req.query("tolerance"));
  const data = await getStrategyConsistencyReport({
    projectId,
    strategyVersionId,
    ...(Number.isFinite(toleranceValue) ? { tolerance: toleranceValue } : {}),
  });
  return c.json({ ok: true, data });
});
