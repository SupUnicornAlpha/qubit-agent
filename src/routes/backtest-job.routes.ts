/**
 * /api/v1/backtest-jobs — 事件驱动回测任务
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §8.1
 */

import { Hono } from "hono";
import {
  BacktestJobError,
  type BacktestJobSubmitInput,
  backtestJobService,
} from "../runtime/backtest/backtest-job-service";
import { walkForwardEvaluationService } from "../runtime/effect-validation/walk-forward-evaluation-service";
import type { WalkForwardRunOptions } from "../runtime/effect-validation/walk-forward-evaluation-service";
import { sensitivityAnalysisService, type SensitivityParamKey } from "../runtime/backtest/sensitivity-analysis-service";
import { monteCarloService } from "../runtime/backtest/monte-carlo-service";
import { verifyPointInTimeIntegrity } from "../runtime/backtest/pit-verifier";

export const backtestJobRouter = new Hono();

function asError(e: unknown) {
  if (e instanceof BacktestJobError) {
    return { ok: false, code: e.code, error: e.message } as const;
  }
  return { ok: false, code: "internal_error", error: (e as Error).message } as const;
}

/** POST /api/v1/backtest-jobs/:id/walk-forward — 扩展窗口 OOS 评估 */
backtestJobRouter.post("/:id/walk-forward", async (c) => {
  try {
    const body: WalkForwardRunOptions = await c.req.json().catch(() => ({}));
    const data = await walkForwardEvaluationService.run(c.req.param("id"), body);
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** POST /api/v1/backtest-jobs/:id/sensitivity — 参数敏感性热力图分析 */
backtestJobRouter.post("/:id/sensitivity", async (c) => {
  try {
    const body: {
      xParam?: { key: SensitivityParamKey; values: Array<number | string> };
      yParam?: { key: SensitivityParamKey; values: Array<number | string> };
    } = await c.req.json().catch(() => ({}));
    const data = await sensitivityAnalysisService.run({
      jobId: c.req.param("id"),
      ...(body.xParam ? { xParam: body.xParam } : {}),
      ...(body.yParam ? { yParam: body.yParam } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** POST /api/v1/backtest-jobs/:id/monte-carlo — 蒙特卡洛压力测试与重抽样 */
backtestJobRouter.post("/:id/monte-carlo", async (c) => {
  try {
    const body: {
      simulations?: number;
      blockSize?: number;
      ruinThresholdRatio?: number;
      seed?: number;
    } = await c.req.json().catch(() => ({}));
    const data = await monteCarloService.run({
      jobId: c.req.param("id"),
      ...(body.simulations !== undefined ? { simulations: body.simulations } : {}),
      ...(body.blockSize !== undefined ? { blockSize: body.blockSize } : {}),
      ...(body.ruinThresholdRatio !== undefined
        ? { ruinThresholdRatio: body.ruinThresholdRatio }
        : {}),
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** POST /api/v1/backtest-jobs/:id/pit-audit — Point-In-Time 数据隔离与防未来函数审计 */
backtestJobRouter.post("/:id/pit-audit", async (c) => {
  try {
    const job = await backtestJobService.get(c.req.param("id"));
    if (!job) {
      return c.json({ ok: false, code: "not_found", error: "Backtest job not found" }, 404);
    }
    const auditReport = verifyPointInTimeIntegrity(job.config.dataset);
    return c.json({ ok: true, data: auditReport });
  } catch (e) {
    return c.json(asError(e), 400);
  }
});

/** GET /api/v1/backtest-jobs?strategy_version_id=&status=&project_id=&workflow_run_id= */
backtestJobRouter.get("/", async (c) => {
  try {
    const strategyVersionId = c.req.query("strategy_version_id");
    const projectId = c.req.query("project_id");
    const workflowRunId = c.req.query("workflow_run_id");
    const data = await backtestJobService.list({
      ...(strategyVersionId ? { strategyVersionId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(workflowRunId ? { workflowRunId } : {}),
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
