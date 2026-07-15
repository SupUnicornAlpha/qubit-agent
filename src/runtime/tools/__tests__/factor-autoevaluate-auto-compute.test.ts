/**
 * factor-autoevaluate-auto-compute.test.ts
 *
 * 验证 `factor.autoEvaluate` 一步式（register → compute → evaluate）链路：
 *
 * 历史 bug（10 wf 内 12/12 失败诊断）：LLM 用 expr + name + project_id 调 autoEvaluate
 * 后，handler 只调了 factor.register（写 factor_definition），没调 factor.compute（不
 * 写 factor_value 到 DuckDB），随后 factorService.autoEvaluate 拉空 values → 抛
 * `no_factor_values: 先跑 compute 写入 factor_value 后再评估`。LLM 收到该错误后习惯
 * 性"重试 autoEvaluate" → 死循环。
 *
 * 修复：handler 在 register 成功后**自动调一次 factorService.compute**，再 autoEvaluate。
 * 本测试用 spy 检验调用顺序：register → compute → autoEvaluate（service 层）。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dispatchBuiltinTool } from "../builtin-tools";
import { runMigrations } from "../../../db/sqlite/migrate";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { bootstrapProviders } from "../../provider/bootstrap";
import { factorService } from "../../factor/factor-service";

let workspaceId: string;
let projectId: string;

const buildCtx = () => ({
  workflowId: randomUUID(),
  agentInstanceId: randomUUID(),
  traceId: randomUUID(),
  definition: { id: "agent.test", role: "researcher" as const },
  projectId,
  workspaceId,
});

const originalCompute = factorService.compute.bind(factorService);
const originalAutoEval = factorService.autoEvaluate.bind(factorService);

beforeAll(async () => {
  await runMigrations();
  await bootstrapProviders();
  const db = await getDb();
  workspaceId = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: "auto_compute_ws",
    owner: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "auto_compute_proj",
    marketScope: "CN-A",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

afterAll(() => {
  factorService.compute = originalCompute;
  factorService.autoEvaluate = originalAutoEval;
});

describe("factor.autoEvaluate 一步式 register → compute → evaluate", () => {
  test("传 expr + name + project_id 时：handler 应在 register 之后调用 factor.compute（再调 autoEvaluate）", async () => {
    /**
     * Mock 顺序追踪：
     *   - factorService.compute 标记被调，记 args，返回 fake row 数（不实际算）
     *   - factorService.autoEvaluate 标记被调，确认 compute 在它之前
     *   - 我们不关心最终 evaluate 数据，只关心"compute 被自动触发"
     */
    const callOrder: string[] = [];

    const computeSpy = mock(async (input: { factorId: string; symbols?: string[]; startDate: string; endDate: string }) => {
      callOrder.push(`compute(${input.factorId.slice(0, 8)}, symbols=${input.symbols?.join(",")})`);
      return { rows: [], meta: { factorId: input.factorId, rowCount: 30, latencyMs: 1 } } as never;
    });
    const autoEvalSpy = mock(async (input: { factorId: string }) => {
      callOrder.push(`autoEvaluate(${input.factorId.slice(0, 8)})`);
      return {
        factorId: input.factorId,
        evaluationId: randomUUID(),
        rankIc: 0.05,
        ir: 0.3,
        meta: { horizonDays: 5, decayHorizons: [1, 3, 5, 10, 20] },
      } as never;
    });

    factorService.compute = computeSpy as unknown as typeof factorService.compute;
    factorService.autoEvaluate = autoEvalSpy as unknown as typeof factorService.autoEvaluate;

    const ctx = buildCtx();
    await dispatchBuiltinTool("factor.autoEvaluate", ctx as never, {
      name: `t1_2_auto_compute_${randomUUID().slice(0, 6)}`,
      factor_expression: "Mean($close, 20) - Mean($close, 60)",
      project_id: projectId,
      symbols: ["AAPL"],
      start_date: "2026-01-01",
      end_date: "2026-04-30",
      horizon_days: 5,
    });

    /** 期望：compute 在 autoEvaluate 之前被调用 */
    expect(computeSpy).toHaveBeenCalled();
    expect(autoEvalSpy).toHaveBeenCalled();
    expect(callOrder.length).toBe(2);
    expect(callOrder[0]).toMatch(/^compute\(/);
    expect(callOrder[1]).toMatch(/^autoEvaluate\(/);

    /** compute 收到的 symbols 应来自入参 */
    const computeArg = computeSpy.mock.calls[0]?.[0] as { symbols?: string[] };
    expect(computeArg?.symbols).toEqual(["AAPL"]);

    /** compute 与 autoEvaluate 用同一个 factorId（register 刚产的） */
    const a = computeSpy.mock.calls[0]?.[0] as { factorId: string };
    const b = autoEvalSpy.mock.calls[0]?.[0] as { factorId: string };
    expect(a.factorId).toBe(b.factorId);

    /** 一步式内部注册也必须保留 Agent lineage，否则工坊会误标为用户产物。 */
    const registered = await factorService.get(a.factorId);
    expect(registered.createdBy).toBe("agent");
    expect(registered.agentInstanceId).toBe(ctx.agentInstanceId);
  });

  test("一步式 compute 返回 0 行时：应终止，不得继续 autoEvaluate", async () => {
    const callOrder: string[] = [];
    factorService.compute = (async () => {
      callOrder.push("compute");
      return { rows: [], meta: { factorId: crypto.randomUUID(), rowCount: 0, latencyMs: 1 } } as never;
    }) as typeof factorService.compute;
    factorService.autoEvaluate = (async () => {
      callOrder.push("autoEvaluate");
      return {} as never;
    }) as typeof factorService.autoEvaluate;

    await expect(
      dispatchBuiltinTool("factor.autoEvaluate", buildCtx() as never, {
        name: `zero_rows_${crypto.randomUUID()}`,
        factor_expression: "close / delay(close, 5) - 1",
        project_id: projectId,
        symbols: ["AAPL", "MSFT", "NVDA"],
        start_date: "2025-01-01",
        end_date: "2025-03-01",
      })
    ).rejects.toThrow("no_factor_values_written");
    expect(callOrder).toEqual(["compute"]);
  });

  test("已传 factor_id（非一步式）→ 不应触发 compute（保持原有行为）", async () => {
    const computeSpy = mock(async () => ({}) as never);
    const autoEvalSpy = mock(async (input: { factorId: string }) => ({
      factorId: input.factorId,
      evaluationId: randomUUID(),
      rankIc: 0,
      ir: 0,
      meta: { horizonDays: 5, decayHorizons: [1, 3, 5, 10, 20] },
    }) as never);

    factorService.compute = computeSpy as unknown as typeof factorService.compute;
    factorService.autoEvaluate = autoEvalSpy as unknown as typeof factorService.autoEvaluate;

    /** 先 register 拿真实 factor_id */
    const reg = (await dispatchBuiltinTool("factor.register", buildCtx() as never, {
      name: `t1_2_existing_${randomUUID().slice(0, 6)}`,
      project_id: projectId,
      category: "momentum",
      expr: "$close / Ref($close, 20) - 1",
      lang: "qlib_expr",
    })) as { id: string };

    /** 现在直接传 factor_id：handler 不应"主动" compute */
    await dispatchBuiltinTool("factor.autoEvaluate", buildCtx() as never, {
      factor_id: reg.id,
      start_date: "2026-01-01",
      end_date: "2026-04-30",
    });

    expect(computeSpy).not.toHaveBeenCalled();
    expect(autoEvalSpy).toHaveBeenCalled();
  });

  test("已有 factor_id 缺 values 时：自动 compute 一次后重试 evaluate", async () => {
    const reg = (await dispatchBuiltinTool("factor.register", buildCtx() as never, {
      name: `existing_recovery_${randomUUID().slice(0, 6)}`,
      project_id: projectId,
      category: "momentum",
      expr: "$close / Ref($close, 20) - 1",
      lang: "qlib_expr",
    })) as { id: string };
    const callOrder: string[] = [];
    let evaluateCalls = 0;
    factorService.autoEvaluate = (async () => {
      evaluateCalls += 1;
      callOrder.push(`evaluate-${evaluateCalls}`);
      if (evaluateCalls === 1) throw new Error("no_factor_values: compute first");
      return { evaluationId: randomUUID(), rankIc: 0.04, ir: 0.2 } as never;
    }) as typeof factorService.autoEvaluate;
    factorService.compute = (async (input) => {
      callOrder.push("compute");
      return { rows: [], meta: { factorId: input.factorId, rowCount: 30, latencyMs: 1 } } as never;
    }) as typeof factorService.compute;

    await dispatchBuiltinTool("factor.autoEvaluate", buildCtx() as never, {
      factor_id: reg.id,
      symbols: ["AAPL", "MSFT", "NVDA"],
      start_date: "2025-01-01",
      end_date: "2025-03-01",
    });
    expect(callOrder).toEqual(["evaluate-1", "compute", "evaluate-2"]);
  });
});
