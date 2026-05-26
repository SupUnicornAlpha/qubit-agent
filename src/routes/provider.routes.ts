/**
 * /api/v1/providers — Provider 注册中心查看 & 切换接口
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §5.4 §7.7
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import {
  providerRegistry as providerRegistryTable,
} from "../db/sqlite/schema";
import { providerRegistry } from "../runtime/provider/registry";
import { providerResolver } from "../runtime/provider/resolver";
import type { ProviderKind } from "../runtime/provider/types";

const ALL_KINDS: ProviderKind[] = ["factor_compute", "factor_eval", "rule_engine", "backtest"];

export const providerRouter = new Hono();

/** GET /api/v1/providers?kind=factor_compute */
providerRouter.get("/", async (c) => {
  const kindQ = c.req.query("kind") as ProviderKind | undefined;
  const db = await getDb();
  const rows =
    kindQ && ALL_KINDS.includes(kindQ)
      ? await db
          .select()
          .from(providerRegistryTable)
          .where(eq(providerRegistryTable.kind, kindQ))
      : await db.select().from(providerRegistryTable);
  return c.json({
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      providerKey: r.providerKey,
      displayName: r.displayName,
      description: r.description,
      capability: r.capabilityJson,
      status: r.status,
      priority: r.priority,
      version: r.version,
      isBuiltin: Boolean(r.isBuiltin),
      isFallback: Boolean(r.isFallback),
      updatedAt: r.updatedAt,
    })),
  });
});

/** GET /api/v1/providers/resolve?kind=factor_compute&project_id=xxx */
providerRouter.get("/resolve", async (c) => {
  const kind = c.req.query("kind") as ProviderKind | undefined;
  if (!kind || !ALL_KINDS.includes(kind)) {
    return c.json({ ok: false, error: "invalid_kind" }, 400);
  }
  const scope = {
    ...(c.req.query("project_id") ? { projectId: c.req.query("project_id")! } : {}),
    ...(c.req.query("workflow_id") ? { workflowRunId: c.req.query("workflow_id")! } : {}),
    ...(c.req.query("strategy_version_id")
      ? { strategyVersionId: c.req.query("strategy_version_id")! }
      : {}),
  };
  try {
    const p = await providerResolver.resolve(kind, scope);
    return c.json({
      ok: true,
      data: {
        kind,
        providerKey: p.meta.key,
        displayName: p.meta.displayName,
        version: p.meta.version,
        capability: p.meta.capability,
      },
    });
  } catch (e) {
    return c.json(
      { ok: false, error: (e as Error).message, code: "resolve_failed" },
      404
    );
  }
});

/** PATCH /api/v1/providers/:id  { status?, priority? } */
providerRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: "enabled" | "disabled"; priority?: number }>();
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.status === "enabled" || body.status === "disabled") patch.status = body.status;
  if (typeof body.priority === "number" && Number.isFinite(body.priority)) {
    patch.priority = Math.max(0, Math.min(100, Math.floor(body.priority)));
  }
  if (Object.keys(patch).length === 1) {
    return c.json({ ok: false, error: "no_changes" }, 400);
  }
  const db = await getDb();
  await db.update(providerRegistryTable).set(patch).where(eq(providerRegistryTable.id, id));
  await providerRegistry.reload();
  return c.json({ ok: true });
});

/** GET /api/v1/providers/health  健康检查全部 Provider */
providerRouter.get("/health", async (c) => {
  const out: Array<{
    kind: ProviderKind;
    providerKey: string;
    ok: boolean;
    latencyMs?: number;
    error?: string;
  }> = [];
  for (const kind of ALL_KINDS) {
    for (const entry of providerRegistry.list(kind, { includeDisabled: true })) {
      const health = await entry.provider.healthCheck();
      out.push({
        kind,
        providerKey: entry.provider.meta.key,
        ok: health.ok,
        ...(health.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {}),
        ...(health.error ? { error: health.error } : {}),
      });
    }
  }
  return c.json({ ok: true, data: out });
});
