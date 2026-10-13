import { Hono } from "hono";
import { z } from "zod";
import { sealedEvaluatorClient } from "../runtime/research-program/evaluator-client";
import { exportResearchEvidence } from "../runtime/research-program/evidence";
import { factorComparisonRunner } from "../runtime/research-program/factor-comparison-runner";
import { researchRunner } from "../runtime/research-program/runner";
import { researchProgramService } from "../runtime/research-program/service";
import {
  researchStrategyRunner,
  strategyExecutionSchema,
} from "../runtime/research-program/strategy-runner";
import {
  ResearchProgramError,
  researchProtocolSpecSchema,
} from "../runtime/research-program/types";

/** Local operator API, like the existing workspace routes. Do not expose the application port to untrusted networks. */
export const researchProgramRouter = new Hono();
researchProgramRouter.onError((error, c) =>
  c.json(
    {
      ok: false,
      code: error instanceof ResearchProgramError ? error.code : "research_request_failed",
      error: error.message,
    },
    error instanceof ResearchProgramError ? error.status : 400
  )
);
researchProgramRouter.get("/evaluator", async (c) =>
  c.json({ ok: true, data: await sealedEvaluatorClient.catalog() })
);
researchProgramRouter.get("/:projectId/attempts/:id/evidence", async (c) =>
  c.json({
    ok: true,
    data: await exportResearchEvidence(c.req.param("projectId"), c.req.param("id")),
  })
);
researchProgramRouter.get("/:projectId", async (c) => {
  await researchProgramService.recoverExpired();
  return c.json({ ok: true, data: await researchProgramService.get(c.req.param("projectId")) });
});
researchProgramRouter.post("/:projectId/protocols", async (c) => {
  const { spec } = z
    .object({ spec: researchProtocolSpecSchema })
    .strict()
    .parse(await c.req.json());
  return c.json(
    {
      ok: true,
      data: await researchRunner.createProtocol({ projectId: c.req.param("projectId"), spec }),
    },
    201
  );
});
researchProgramRouter.patch("/:projectId", async (c) => {
  const { status } = z
    .object({ status: z.enum(["active", "paused"]) })
    .strict()
    .parse(await c.req.json());
  return c.json({
    ok: true,
    data: await researchProgramService.setStatus(c.req.param("projectId"), status),
  });
});
researchProgramRouter.post("/:projectId/attempts", async (c) => {
  const input = z
    .object({
      factorId: z.string().min(1).max(200),
      kind: z.enum(["factor_compute", "factor_evaluate", "sealed_factor"]),
      idempotencyKey: z.string().trim().min(1).max(200),
    })
    .strict()
    .parse(await c.req.json());
  return c.json(
    {
      ok: true,
      data: await researchRunner.submitFactor({ projectId: c.req.param("projectId"), ...input }),
    },
    202
  );
});
researchProgramRouter.post("/:projectId/attempts/:id/cancel", async (c) =>
  c.json({
    ok: true,
    data: await researchRunner.cancel(c.req.param("projectId"), c.req.param("id")),
  })
);

researchProgramRouter.post("/:projectId/comparisons", async (c) => {
  const input = z
    .object({
      factorId: z.string().min(1).max(200),
      idempotencyKey: z.string().trim().min(1).max(200),
    })
    .strict()
    .parse(await c.req.json());
  return c.json(
    {
      ok: true,
      data: await factorComparisonRunner.submit({ projectId: c.req.param("projectId"), ...input }),
    },
    202
  );
});

researchProgramRouter.get("/:projectId/strategies", async (c) =>
  c.json({ ok: true, data: await researchStrategyRunner.list(c.req.param("projectId")) })
);
researchProgramRouter.get("/:projectId/strategies/:id/artifact", async (c) =>
  c.json({
    ok: true,
    data: await researchStrategyRunner.artifact(c.req.param("projectId"), c.req.param("id")),
  })
);
researchProgramRouter.post("/:projectId/strategies", async (c) => {
  const { sourceAttemptId, execution } = z
    .object({ sourceAttemptId: z.string().min(1).max(200), execution: strategyExecutionSchema })
    .strict()
    .parse(await c.req.json());
  return c.json(
    {
      ok: true,
      data: await researchStrategyRunner.create(
        c.req.param("projectId"),
        sourceAttemptId,
        execution
      ),
    },
    201
  );
});
researchProgramRouter.post("/:projectId/strategies/:id/backtests", async (c) => {
  const { idempotencyKey } = z
    .object({ idempotencyKey: z.string().trim().min(1).max(200) })
    .strict()
    .parse(await c.req.json());
  return c.json(
    {
      ok: true,
      data: await researchStrategyRunner.submit(
        c.req.param("projectId"),
        c.req.param("id"),
        idempotencyKey
      ),
    },
    202
  );
});
