/**
 * /api/v1/strategies — strategy + strategy_version 列表（前端选择用）
 *
 * 主要服务 BacktestStudio：让用户在前端选 strategyVersionId 后再发起回测。
 */

import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { strategy as strategyTable, strategyVersion as strategyVersionTable } from "../db/sqlite/schema";
import { strategyComposer } from "../runtime/strategy/strategy-composer";

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
 * GET /api/v1/strategies/versions?project_id=&workflow_run_id=
 *
 * 扁平 list strategy_version + 关联 strategy.name，便于前端单层下拉。
 *
 * `workflow_run_id` 用于研究产出侧栏严格按"本工作流"过滤；命中
 * `idx_strategy_version_workflow`（migration 0047）。
 */
strategyRouter.get("/versions", async (c) => {
  try {
    const db = await getDb();
    const projectId = c.req.query("project_id");
    const workflowRunId = c.req.query("workflow_run_id");

    const baseSelect = {
      id: strategyVersionTable.id,
      strategyId: strategyVersionTable.strategyId,
      versionTag: strategyVersionTable.versionTag,
      createdAt: strategyVersionTable.createdAt,
      workflowRunId: strategyVersionTable.workflowRunId,
      strategyName: strategyTable.name,
      strategyStyle: strategyTable.style,
      projectId: strategyTable.projectId,
    };

    const conds = [];
    if (projectId) conds.push(eq(strategyTable.projectId, projectId));
    if (workflowRunId) conds.push(eq(strategyVersionTable.workflowRunId, workflowRunId));

    const rows = conds.length
      ? await db
          .select(baseSelect)
          .from(strategyVersionTable)
          .innerJoin(strategyTable, eq(strategyTable.id, strategyVersionTable.strategyId))
          .where(conds.length === 1 ? conds[0] : and(...conds))
          .orderBy(desc(strategyVersionTable.createdAt))
      : await db
          .select(baseSelect)
          .from(strategyVersionTable)
          .innerJoin(strategyTable, eq(strategyTable.id, strategyVersionTable.strategyId))
          .orderBy(desc(strategyVersionTable.createdAt));
    return c.json({ ok: true, data: rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/**
 * POST /api/v1/strategies/versions
 *
 * 让 Composer UI 自洽 —— 此前 strategy_version 只能由 research agent / strategy IDE
 * / reia-bridge 三条非 UI 路径写入，导致用户在 Quant Workbench 里看到「暂无 version」
 * 死锁。此端点直接落 strategy_version 行；可选同时自动建一个 strategy 父对象。
 *
 * Body：
 * {
 *   "project_id": "...",
 *   "strategy_id"?: "...",        // 已有 strategy.id，二选一
 *   "strategy_name"?: "...",      // 自动新建 strategy 时使用
 *   "strategy_style"?: "low_freq" | "high_freq" | "mid_freq",
 *   "version_tag"?: "v1",
 *   "params"?: {...},             // → strategy_version.param_schema_json
 *   "workflow_run_id"?: null
 * }
 */
strategyRouter.post("/versions", async (c) => {
  try {
    const body = await c.req.json<{
      project_id?: string;
      projectId?: string;
      strategy_id?: string;
      strategyId?: string;
      strategy_name?: string;
      strategyName?: string;
      strategy_style?: "low_freq" | "high_freq" | "mid_freq";
      strategyStyle?: "low_freq" | "high_freq" | "mid_freq";
      version_tag?: string;
      versionTag?: string;
      params?: Record<string, unknown>;
      workflow_run_id?: string | null;
      workflowRunId?: string | null;
    }>();
    const projectId = (body.project_id ?? body.projectId ?? "").trim();
    if (!projectId) {
      return c.json({ ok: false, error: "project_id is required" }, 400);
    }
    const created = await strategyComposer.createVersion({
      projectId,
      ...(body.strategy_id || body.strategyId
        ? { strategyId: (body.strategy_id ?? body.strategyId)! }
        : {}),
      ...(body.strategy_name || body.strategyName
        ? { strategyName: (body.strategy_name ?? body.strategyName)! }
        : {}),
      ...(body.strategy_style || body.strategyStyle
        ? { strategyStyle: (body.strategy_style ?? body.strategyStyle)! }
        : {}),
      ...(body.version_tag || body.versionTag
        ? { versionTag: (body.version_tag ?? body.versionTag)! }
        : {}),
      ...(body.params ? { params: body.params } : {}),
      workflowRunId: body.workflow_run_id ?? body.workflowRunId ?? null,
    });
    return c.json({ ok: true, data: created });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400);
  }
});
