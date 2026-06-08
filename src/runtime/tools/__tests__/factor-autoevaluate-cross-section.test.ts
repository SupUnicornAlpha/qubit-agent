/**
 * factor-autoevaluate-cross-section.test.ts (P0-3 Round 6 复盘修)
 *
 * 验证 `factor.autoEvaluate` 与 `factorService.autoEvaluate` 的横截面 symbols 防御：
 *
 * 1) tool 层：symbols 入参数量 < 3 → 立刻抛清晰错误（教 LLM 用 ≥3 symbols）
 * 2) service 层：当 factor_value 实际只覆盖单 symbol → 即使 LLM 没传 symbols，service
 *    也在 loadValues 之后抛 cross_section_too_few_symbols（不让脏 0 流入下游）
 * 3) service 层：evaluate 返回的 result.error（sample_size_too_small / ...）必须抛错，
 *    不能让 LLM 看到 ic=0/rankIc=0/ir=0 的"成功"结果当真实指标
 *
 * 背景：Round 6 实测 LLM 用 ["AAPL"] 单标的 + horizon=60，下游 IC=0 但顶层 result=ok,
 * LLM 误把 0 当真实指标写进 strategy（详见 docs/agent-readiness-eval-round6 报告）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dispatchBuiltinTool } from "../builtin-tools";
import { runMigrations } from "../../../db/sqlite/migrate";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { bootstrapProviders } from "../../provider/bootstrap";
import {
  factorService,
  FactorServiceError,
} from "../../factor/factor-service";

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

const originalLoadValues = factorService.loadValues.bind(factorService);
const originalEvaluate = factorService.evaluate.bind(factorService);

beforeAll(async () => {
  await runMigrations();
  await bootstrapProviders();
  const db = await getDb();
  workspaceId = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: "cs_ws",
    owner: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "cs_proj",
    marketScope: "CN-A",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

afterAll(() => {
  factorService.loadValues = originalLoadValues;
  factorService.evaluate = originalEvaluate;
});

describe("factor.autoEvaluate cross-section guard (P0-3)", () => {
  test("tool 层：symbols 入参只有 1 只 → 立即抛错（不再走 service）", async () => {
    /** 即使 factor_id 不存在，也应该被入参校验先拦住 */
    await expect(
      dispatchBuiltinTool("factor.autoEvaluate", buildCtx() as never, {
        factor_id: randomUUID(),
        symbols: ["AAPL"],
        start_date: "2026-01-01",
        end_date: "2026-04-30",
        horizon_days: 5,
      })
    ).rejects.toThrow(/symbols 数量过少.*横截面.*至少需要 3 只/);
  });

  test("tool 层：symbols 入参 2 只仍少于 3 → 抛错", async () => {
    await expect(
      dispatchBuiltinTool("factor.autoEvaluate", buildCtx() as never, {
        factor_id: randomUUID(),
        symbols: ["AAPL", "MSFT"],
        start_date: "2026-01-01",
        end_date: "2026-04-30",
      })
    ).rejects.toThrow(/symbols 数量过少/);
  });

  test("tool 层：symbols 入参 3 只 → 通过入参校验（不再抛 symbols 数量错）", async () => {
    /**
     * 我们 mock evaluate 让它直接抛"已知"错误，确认入参校验放行 → 抵达 service 层。
     * 即只要错误信息不再是 'symbols 数量过少'，就证明 tool 入参校验放行了。
     */
    factorService.evaluate = (async () => {
      throw new Error("expected: passed through tool guard");
    }) as never;
    factorService.loadValues = (async () => {
      return [
        { symbol: "AAPL", date: "2026-01-01", value: 1 },
        { symbol: "MSFT", date: "2026-01-01", value: 2 },
        { symbol: "NVDA", date: "2026-01-01", value: 3 },
      ];
    }) as never;

    /** 真 factor 落库一条，autoEvaluate 第一步 this.get(factorId) 才能查到 */
    const reg = (await dispatchBuiltinTool("factor.register", buildCtx() as never, {
      name: `cs_pass_${randomUUID().slice(0, 6)}`,
      project_id: projectId,
      category: "momentum",
      expr: "$close",
      lang: "qlib_expr",
    })) as { id: string };

    await expect(
      dispatchBuiltinTool("factor.autoEvaluate", buildCtx() as never, {
        factor_id: reg.id,
        symbols: ["AAPL", "MSFT", "NVDA"],
        start_date: "2026-01-01",
        end_date: "2026-04-30",
      })
    ).rejects.toThrow(/expected: passed through tool guard/);
  });

  test("service 层：factor_value 只覆盖单 symbol → 抛 cross_section_too_few_symbols", async () => {
    /** loadValues 模拟 DuckDB 只有 1 只 symbol 的 factor_value（与单 AAPL compute 的实测一致） */
    factorService.loadValues = (async () => {
      return [
        { symbol: "AAPL", date: "2026-01-01", value: 1 },
        { symbol: "AAPL", date: "2026-01-02", value: 2 },
        { symbol: "AAPL", date: "2026-01-03", value: 3 },
      ];
    }) as never;

    const reg = await factorService.register({
      projectId,
      name: `cs_single_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "$close",
      lang: "qlib_expr",
    });

    await expect(
      factorService.autoEvaluate({
        factorId: reg.id,
        startDate: "2026-01-01",
        endDate: "2026-04-30",
      })
    ).rejects.toBeInstanceOf(FactorServiceError);

    await expect(
      factorService.autoEvaluate({
        factorId: reg.id,
        startDate: "2026-01-01",
        endDate: "2026-04-30",
      })
    ).rejects.toThrow(/cross_section_too_few_symbols.*只覆盖 1 只 symbols/);
  });

  test("service 层：provider 返回 result.error → 抛 factor_evaluation_invalid（不让 0 假装成功）", async () => {
    /**
     * 模拟：loadValues 给出 5 只 symbols 通过 symbol 数量校验，
     * 但 evaluate 返回 sample_size_too_small（如 horizon 太长以致 future returns 都缺失）。
     */
    factorService.loadValues = (async () => {
      const out = [];
      for (const s of ["AAPL", "MSFT", "NVDA", "GOOG", "META"]) {
        out.push({ symbol: s, date: "2026-01-01", value: 0.1 });
      }
      return out;
    }) as never;

    factorService.evaluate = (async () => ({
      ic: 0,
      rankIc: 0,
      ir: 0,
      turnover: 0,
      decayCurve: [],
      groupReturns: [],
      sampleSize: 2,
      latencyMs: 1,
      error: "sample_size_too_small",
      evaluationId: randomUUID(),
    })) as never;

    const reg = await factorService.register({
      projectId,
      name: `cs_provider_err_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "$close",
      lang: "qlib_expr",
    });

    await expect(
      factorService.autoEvaluate({
        factorId: reg.id,
        startDate: "2026-01-01",
        endDate: "2026-04-30",
      })
    ).rejects.toThrow(/factor_evaluation_invalid: sample_size_too_small/);
  });
});
