import { Hono } from "hono";
import { z } from "zod";
import { sealedEvaluatorClient } from "../runtime/research-program/evaluator-client";
import { researchRunner } from "../runtime/research-program/runner";
import { researchProgramService } from "../runtime/research-program/service";
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
