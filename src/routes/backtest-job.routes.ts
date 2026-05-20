/**
 * /api/v1/backtest-jobs — 事件驱动回测任务
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §8.1
 */

import { Hono } from "hono";
import {
  backtestJobService,
  BacktestJobError,
  type BacktestJobSubmitInput,
} from "../runtime/backtest/backtest-job-service";

export const backtestJobRouter = new Hono();

function asError(e: unknown) {
  if (e instanceof BacktestJobError) {
    return { ok: false, code: e.code, error: e.message } as const;
  }
  return { ok: false, code: "internal_error", error: (e as Error).message } as const;
}

/** GET /api/v1/backtest-jobs?strategy_version_id=&status= */
backtestJobRouter.get("/", async (c) => {
  try {
    const data = await backtestJobService.list({
      ...(c.req.query("strategy_version_id")
        ? { strategyVersionId: c.req.query("strategy_version_id")! }
        : {}),
      ...(c.req.query("status")
        ? { status: c.req.query("status") as "pending" | "running" | "completed" | "failed" }
        : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 500);
  }
});

/** GET /api/v1/backtest-jobs/:id */
backtestJobRouter.get("/:id", async (c) => {
  try {
    const data = await backtestJobService.get(c.req.param("id"));
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 404);
  }
});

/** POST /api/v1/backtest-jobs  — 创建任务（pending） */
backtestJobRouter.post("/", async (c) => {
  try {
    const body = await c.req.json<BacktestJobSubmitInput>();
    const data = await backtestJobService.submit(body);
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** POST /api/v1/backtest-jobs/:id/run — 触发执行 */
backtestJobRouter.post("/:id/run", async (c) => {
  try {
    const data = await backtestJobService.run(c.req.param("id"));
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** POST /api/v1/backtest-jobs/run-now — submit + run 一步到位 */
backtestJobRouter.post("/run-now", async (c) => {
  try {
    const body = await c.req.json<BacktestJobSubmitInput>();
    const data = await backtestJobService.submitAndRun(body);
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});
