/**
 * strategy-create-version-and-order-intent.test.ts (P0-1.b + P0-1.c)
 *
 * 验证两个新增的 builtin tool，让多 agent 团队能"落最后一公里"产物：
 *
 * - strategy.create_version：创建 strategy + strategy_version（让 strategy_pipeline 能落库）
 * - order.create_intent：trader 在 paper mode 下落 order_intent（让 live_trading 团队闭环）
 *
 * 背景：Round 6 实测 grp-strategy-pipeline 跑了 18 step / 13 tool 但 strategy_version DB
 * 0 行；grp-live-trading 4 step 0 个 order_intent —— 因为 LLM 没有对应工具能写。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dispatchBuiltinTool } from "../builtin-tools";
import { runMigrations } from "../../../db/sqlite/migrate";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { bootstrapProviders } from "../../provider/bootstrap";

let workspaceId: string;
let projectId: string;
let workflowRunId: string;

const buildCtx = () => ({
  workflowId: workflowRunId,
  agentInstanceId: randomUUID(),
  traceId: randomUUID(),
  definition: { id: "agent.test", role: "research" as const },
  projectId,
  workspaceId,
});

beforeAll(async () => {
  await runMigrations();
  await bootstrapProviders();
  const db = await getDb();
  workspaceId = randomUUID();
  projectId = randomUUID();
  workflowRunId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: "p0_1_ws",
    owner: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "p0_1_proj",
    marketScope: "US",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  /** workflow_run 必须存在：order_intent.workflow_run_id 走 FK */
  await db.insert(schema.workflowRun).values({
    id: workflowRunId,
    projectId,
    goal: "P0-1 trader 测试",
    mode: "live_trading",
    source: "api",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

afterAll(async () => {
  // 清理：让本测试不污染他次跑（FK 没法清，DB 是测试 fixture 形态，OK）
});

describe("strategy.create_version (P0-1.b)", () => {
  test("传 name 创建 → 落 strategy + strategy_version + 返回 strategyVersionId", async () => {
    const res = (await dispatchBuiltinTool("strategy.create_version", buildCtx() as never, {
      name: `pp_strategy_${randomUUID().slice(0, 6)}`,
      style: "low_freq",
      description: "P0-1.b 测试策略",
    })) as { strategyId: string; strategyVersionId: string; versionTag: string };

    expect(res.strategyId).toBeTruthy();
    expect(res.strategyVersionId).toBeTruthy();
    expect(res.versionTag).toBe("v1");

    const db = await getDb();
    const stratRows = await db
      .select()
      .from(schema.strategy)
      .where(eq(schema.strategy.id, res.strategyId));
    expect(stratRows[0]).toBeDefined();
    expect(stratRows[0]!.projectId).toBe(projectId);

    const versionRows = await db
      .select()
      .from(schema.strategyVersion)
      .where(eq(schema.strategyVersion.id, res.strategyVersionId));
    expect(versionRows[0]).toBeDefined();
    expect(versionRows[0]!.strategyId).toBe(res.strategyId);
    expect(versionRows[0]!.workflowRunId).toBe(workflowRunId);
  });

  test("name 重复 → 复用同一个 strategy，但 versionTag 自增 v2", async () => {
    const name = `pp_strategy_dup_${randomUUID().slice(0, 6)}`;
    const r1 = (await dispatchBuiltinTool("strategy.create_version", buildCtx() as never, {
      name,
      style: "low_freq",
    })) as { strategyId: string; versionTag: string };
    const r2 = (await dispatchBuiltinTool("strategy.create_version", buildCtx() as never, {
      name,
      style: "low_freq",
    })) as { strategyId: string; versionTag: string };

    expect(r1.strategyId).toBe(r2.strategyId);
    expect(r1.versionTag).toBe("v1");
    expect(r2.versionTag).toBe("v2");
  });

  test("非法 style → 抛错", async () => {
    await expect(
      dispatchBuiltinTool("strategy.create_version", buildCtx() as never, {
        name: "bad_style",
        style: "ultra_high_freq",
      })
    ).rejects.toThrow(/style 必须是/);
  });

  test("缺 name → 抛错", async () => {
    await expect(
      dispatchBuiltinTool("strategy.create_version", buildCtx() as never, {})
    ).rejects.toThrow(/name \(策略名\) is required/);
  });
});

describe("order.create_intent (P0-1.c)", () => {
  test("market buy 1 股 AAPL → 落 order_intent (paper mode) + 返回 riskOutcome", async () => {
    /** 先创 strategy_version 备用 */
    const sv = (await dispatchBuiltinTool("strategy.create_version", buildCtx() as never, {
      name: `pp_order_strategy_${randomUUID().slice(0, 6)}`,
      style: "low_freq",
    })) as { strategyVersionId: string };

    const res = (await dispatchBuiltinTool("order.create_intent", buildCtx() as never, {
      strategy_version_id: sv.strategyVersionId,
      symbol: "AAPL",
      side: "buy",
      qty: 1,
      order_type: "market",
      market: "US",
    })) as {
      orderIntentId: string;
      riskOutcome: string;
      dispatchMode: string;
      symbol: string;
    };

    expect(res.orderIntentId).toBeTruthy();
    expect(res.symbol).toBe("AAPL");
    expect(res.dispatchMode).toBe("paper"); // default

    const db = await getDb();
    const orderRows = await db
      .select()
      .from(schema.orderIntent)
      .where(eq(schema.orderIntent.id, res.orderIntentId));
    expect(orderRows[0]).toBeDefined();
    expect(orderRows[0]!.workflowRunId).toBe(workflowRunId);
    expect(orderRows[0]!.strategyVersionId).toBe(sv.strategyVersionId);
    expect(orderRows[0]!.qty).toBe(1);
    expect(orderRows[0]!.side).toBe("buy");
  });

  test("limit 单缺 price → 抛错", async () => {
    const sv = (await dispatchBuiltinTool("strategy.create_version", buildCtx() as never, {
      name: `pp_limit_${randomUUID().slice(0, 6)}`,
      style: "low_freq",
    })) as { strategyVersionId: string };

    await expect(
      dispatchBuiltinTool("order.create_intent", buildCtx() as never, {
        strategy_version_id: sv.strategyVersionId,
        symbol: "MSFT",
        side: "buy",
        qty: 10,
        order_type: "limit",
        /** 故意不传 price */
      })
    ).rejects.toThrow(/order_type=limit.*price/);
  });

  test("qty <= 0 → 抛错", async () => {
    const sv = (await dispatchBuiltinTool("strategy.create_version", buildCtx() as never, {
      name: `pp_qty_${randomUUID().slice(0, 6)}`,
      style: "low_freq",
    })) as { strategyVersionId: string };

    await expect(
      dispatchBuiltinTool("order.create_intent", buildCtx() as never, {
        strategy_version_id: sv.strategyVersionId,
        symbol: "MSFT",
        side: "buy",
        qty: -5,
      })
    ).rejects.toThrow(/qty 必须是正数/);
  });

  test("非法 side → 抛错", async () => {
    const sv = (await dispatchBuiltinTool("strategy.create_version", buildCtx() as never, {
      name: `pp_side_${randomUUID().slice(0, 6)}`,
      style: "low_freq",
    })) as { strategyVersionId: string };

    await expect(
      dispatchBuiltinTool("order.create_intent", buildCtx() as never, {
        strategy_version_id: sv.strategyVersionId,
        symbol: "MSFT",
        side: "hold",
        qty: 1,
      })
    ).rejects.toThrow(/side 必须是 'buy' 或 'sell'/);
  });
});
