/**
 * /api/v1/research-scenarios — 研究场景注册中心查看 & 启动接口
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.6
 */

import { Hono } from "hono";
import { researchScenarioRegistry } from "../runtime/research-scenario/registry";
import { researchScenarioService } from "../runtime/research-scenario/service";
import { ScenarioError } from "../runtime/research-scenario/types";

export const researchScenarioRouter = new Hono();

/** GET /api/v1/research-scenarios?status=enabled */
researchScenarioRouter.get("/", async (c) => {
  const statusQ = c.req.query("status") as "enabled" | "disabled" | undefined;
  const list = await researchScenarioRegistry.list(
    statusQ ? { status: statusQ } : undefined
  );
  return c.json({
    ok: true,
    data: list.map((s) => ({
      id: s.id,
      key: s.key,
      displayName: s.displayName,
      description: s.description,
      inputSchema: s.inputSchema,
      outputContract: s.outputContract,
      requiredCapabilities: s.requiredCapabilities,
      toolPreset: s.toolPreset,
      loopDefaults: s.loopDefaults,
      status: s.status,
      sortOrder: s.sortOrder,
      isBuiltin: s.isBuiltin,
    })),
  });
});

/** GET /api/v1/research-scenarios/:key */
researchScenarioRouter.get("/:key", (c) => {
  const key = c.req.param("key");
  const spec = researchScenarioRegistry.get(key);
  if (!spec) return c.json({ ok: false, error: "scenario_not_found" }, 404);
  return c.json({ ok: true, data: spec });
});

/** POST /api/v1/research-scenarios/:key/validate  { inputParams, projectId? } */
researchScenarioRouter.post("/:key/validate", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json<{
    inputParams: Record<string, unknown>;
    projectId?: string;
  }>();
  try {
    const result = await researchScenarioService.validate(
      key,
      body.inputParams ?? {},
      body.projectId ? { projectId: body.projectId } : {}
    );
    return c.json({ ok: true, data: result });
  } catch (e) {
    if (e instanceof ScenarioError) {
      return c.json({ ok: false, code: e.code, error: e.message }, 400);
    }
    throw e;
  }
});

/** POST /api/v1/research-scenarios/:key/plan-launch  { projectId, inputParams } */
researchScenarioRouter.post("/:key/plan-launch", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json<{
    projectId: string;
    inputParams: Record<string, unknown>;
    loopOverrides?: Record<string, unknown>;
  }>();
  try {
    const plan = await researchScenarioService.planLaunch({
      scenarioKey: key,
      projectId: body.projectId,
      inputParams: body.inputParams ?? {},
      ...(body.loopOverrides
        ? { loopOverrides: body.loopOverrides as never }
        : {}),
    });
    return c.json({ ok: true, data: plan });
  } catch (e) {
    if (e instanceof ScenarioError) {
      return c.json({ ok: false, code: e.code, error: e.message }, 400);
    }
    throw e;
  }
});

/** POST /api/v1/research-scenarios/:key/launch  { projectId, inputParams, goal? } */
researchScenarioRouter.post("/:key/launch", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json<{
    projectId: string;
    goal?: string;
    inputParams: Record<string, unknown>;
    loopOverrides?: Record<string, unknown>;
  }>();
  try {
    const launched = await researchScenarioService.launch({
      scenarioKey: key,
      projectId: body.projectId,
      ...(body.goal ? { goal: body.goal } : {}),
      inputParams: body.inputParams ?? {},
      ...(body.loopOverrides ? { loopOverrides: body.loopOverrides as never } : {}),
    });
    return c.json({ ok: true, data: launched }, 202);
  } catch (e) {
    if (e instanceof ScenarioError) {
      const status =
        e.code === "scenario_not_found"
          ? 404
          : e.code === "missing_capability"
            ? 409
            : 400;
      const payload = { ok: false, code: e.code, error: e.message, details: e.details };
      if (status === 404) return c.json(payload, 404);
      if (status === 409) return c.json(payload, 409);
      return c.json(payload, 400);
    }
    throw e;
  }
});

/** PATCH /api/v1/research-scenarios/:key  { status } */
researchScenarioRouter.patch("/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json<{ status?: "enabled" | "disabled" }>();
  if (body.status !== "enabled" && body.status !== "disabled") {
    return c.json({ ok: false, error: "invalid_status" }, 400);
  }
  await researchScenarioRegistry.setStatus(key, body.status);
  return c.json({ ok: true });
});
