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
      defaultAgentGroupId: s.defaultAgentGroupId,
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

/** GET /api/v1/research-scenarios/:key/groups */
researchScenarioRouter.get("/:key/groups", async (c) => {
  const key = c.req.param("key");
  const groups = await researchScenarioRegistry.listGroupsForScenario(key);
  return c.json({ ok: true, data: groups });
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

/** POST /api/v1/research-scenarios/:key/plan-launch  { projectId, inputParams, agentGroupId? } */
researchScenarioRouter.post("/:key/plan-launch", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json<{
    projectId: string;
    inputParams: Record<string, unknown>;
    agentGroupId?: string;
    loopOverrides?: Record<string, unknown>;
  }>();
  try {
    const plan = await researchScenarioService.planLaunch({
      scenarioKey: key,
      projectId: body.projectId,
      inputParams: body.inputParams ?? {},
      ...(body.agentGroupId ? { agentGroupId: body.agentGroupId } : {}),
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
