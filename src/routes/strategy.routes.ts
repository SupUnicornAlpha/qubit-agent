/**
 * /api/v1/strategies — strategy + strategy_version 列表（前端选择用）
 *
 * 主要服务 BacktestStudio：让用户在前端选 strategyVersionId 后再发起回测。
 */

import { Hono } from "hono";
import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { strategy as strategyTable, strategyVersion as strategyVersionTable } from "../db/sqlite/schema";

export const strategyRouter = new Hono();

/**
 * GET /api/v1/strategies?project_id=
 *
 * 返回 strategy 列表 + 每个 strategy 关联的 versions（按 createdAt 倒序）
 */
strategyRouter.get("/", async (c) => {
  try {
    const db = await getDb();
    const projectId = c.req.query("project_id");
    const strategies = projectId
      ? await db
          .select()
          .from(strategyTable)
          .where(eq(strategyTable.projectId, projectId))
          .orderBy(asc(strategyTable.name))
      : await db.select().from(strategyTable).orderBy(asc(strategyTable.name));

    const versions = await db
      .select()
      .from(strategyVersionTable)
      .orderBy(desc(strategyVersionTable.createdAt));

    const byStrategy = new Map<string, typeof versions>();
    for (const v of versions) {
      const list = byStrategy.get(v.strategyId) ?? [];
      list.push(v);
      byStrategy.set(v.strategyId, list);
    }

    return c.json({
      ok: true,
      data: strategies.map((s) => ({
        ...s,
        versions: byStrategy.get(s.id) ?? [],
      })),
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/**
 * GET /api/v1/strategies/versions?project_id=
 *
 * 扁平 list strategy_version + 关联 strategy.name，便于前端单层下拉。
 */
strategyRouter.get("/versions", async (c) => {
  try {
    const db = await getDb();
    const projectId = c.req.query("project_id");
    const rows = projectId
      ? await db
          .select({
            id: strategyVersionTable.id,
            strategyId: strategyVersionTable.strategyId,
            versionTag: strategyVersionTable.versionTag,
            createdAt: strategyVersionTable.createdAt,
            strategyName: strategyTable.name,
            strategyStyle: strategyTable.style,
            projectId: strategyTable.projectId,
          })
          .from(strategyVersionTable)
          .innerJoin(strategyTable, eq(strategyTable.id, strategyVersionTable.strategyId))
          .where(eq(strategyTable.projectId, projectId))
          .orderBy(desc(strategyVersionTable.createdAt))
      : await db
          .select({
            id: strategyVersionTable.id,
            strategyId: strategyVersionTable.strategyId,
            versionTag: strategyVersionTable.versionTag,
            createdAt: strategyVersionTable.createdAt,
            strategyName: strategyTable.name,
            strategyStyle: strategyTable.style,
            projectId: strategyTable.projectId,
          })
          .from(strategyVersionTable)
          .innerJoin(strategyTable, eq(strategyTable.id, strategyVersionTable.strategyId))
          .orderBy(desc(strategyVersionTable.createdAt));
    return c.json({ ok: true, data: rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});
