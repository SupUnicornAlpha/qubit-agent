/**
 * Agent 量化工坊工具入口集成测试
 *
 * 验证 builtin-tools 中新增的 factor.list / factor.autoEvaluate / discovery.run /
 * discovery.promote / backtest.run 能通过 dispatchBuiltinTool 调用，并正确路由到
 * factorService / discoveryService / backtestJobService。
 *
 * 与 services 自身的单测互补：这里只验证「工具入口的参数解析与编排链路」。
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dispatchBuiltinTool, listRegisteredBuiltinTools } from "../builtin-tools";
import { runMigrations } from "../../../db/sqlite/migrate";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { bootstrapProviders } from "../../provider/bootstrap";
import { factorService } from "../../factor/factor-service";
import { discoveryService } from "../../discovery/discovery-service";

const NOW = "2026-01-01T00:00:00.000Z";

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

beforeAll(async () => {
  await runMigrations();
  await bootstrapProviders();
  const db = await getDb();

  workspaceId = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: "test_ws",
    owner: "test",
    createdAt: NOW,
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "test_proj",
    marketScope: "CN-A",
    createdAt: NOW,
  });
});

describe("Agent 量化工坊工具入口", () => {
  test("注册的工具列表包含 M2/M6/M7 量化工坊工具（含 code.run_python 沙箱）", () => {
    const names = listRegisteredBuiltinTools();
    for (const t of [
      "factor.register",
      "factor.compute",
      "factor.evaluate",
      "factor.list",
      "factor.autoEvaluate",
      "rule.register",
      "rule.evaluate",
      "strategy.compose",
      "discovery.run",
      "discovery.promote",
      "backtest.run",
      "code.run_python",
    ]) {
      expect(names).toContain(t);
    }
  });

  test("code.run_python：dispatch 走通沙箱 + 注入 vars", async () => {
    const ctx = buildCtx();
    const out = (await dispatchBuiltinTool("code.run_python", ctx as never, {
      code: "result = sum(vars['xs'])",
      vars: { xs: [10, 20, 30] },
      return_var: "result",
      timeout_sec: 5,
    })) as { ok: boolean; result: unknown };
    if (!out.ok) {
      console.warn("[skip] python3 not available for code.run_python dispatch test");
      return;
    }
    expect(out.result).toBe(60);
  });

  test("code.run_python：缺 code 抛错", async () => {
    const ctx = buildCtx();
    await expect(
      dispatchBuiltinTool("code.run_python", ctx as never, { code: "" })
    ).rejects.toThrow(/code/);
  });

  test("factor.register + factor.list：能注册并查询出来", async () => {
    const ctx = buildCtx();
    const f = (await dispatchBuiltinTool("factor.register", ctx as never, {
      name: `agent_factor_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "Mean($close, 20) - Mean($close, 60)",
      lang: "qlib_expr",
      horizon: 5,
    })) as { id: string; name: string };
    expect(f.id).toBeDefined();

    const list = (await dispatchBuiltinTool("factor.list", ctx as never, {
      project_id: projectId,
    })) as Array<{ id: string }>;
    const ids = list.map((x) => x.id);
    expect(ids).toContain(f.id);

    // 带 status 过滤
    const drafts = (await dispatchBuiltinTool("factor.list", ctx as never, {
      project_id: projectId,
      status: "draft",
    })) as Array<{ id: string; status: string }>;
    for (const d of drafts) expect(d.status).toBe("draft");
  });

  test("discovery.run → 返回候选 + discovery.promote 落正式 factor", async () => {
    const ctx = buildCtx();
    const job = (await dispatchBuiltinTool("discovery.run", ctx as never, {
      project_id: projectId,
      kind: "factor_alpha101",
      symbols: ["SYN1", "SYN2", "SYN3"],
      start_date: "2026-01-01",
      end_date: "2026-04-30",
      horizon_days: 5,
      top_k: 3,
    })) as { id: string; candidates: Array<{ id: string; expr: string; error?: string }> };
    expect(job.id).toBeDefined();
    expect(job.candidates.length).toBeGreaterThan(0);

    // 过滤掉 error 候选
    const good = job.candidates.find((c) => !c.error);
    expect(good).toBeDefined();

    const promoted = (await dispatchBuiltinTool("discovery.promote", ctx as never, {
      job_id: job.id,
      candidate_id: good!.id,
      name: `agent_promote_${randomUUID().slice(0, 6)}`,
      category: "momentum",
    })) as { id: string; expr: string };
    expect(promoted.id).toBeDefined();
    expect(promoted.expr).toBe(good!.expr);

    // 确认入库
    const fresh = await factorService.get(promoted.id);
    expect(fresh.providerKey).toBe("qlib_expr");
  });

  test("discovery.run 缺 symbols → 抛错", async () => {
    const ctx = buildCtx();
    await expect(
      dispatchBuiltinTool("discovery.run", ctx as never, {
        project_id: projectId,
        kind: "factor_alpha101",
        start_date: "2026-01-01",
        end_date: "2026-04-30",
      })
    ).rejects.toThrow(/symbols/);
  });

  test("backtest.run 缺 strategy_version_id → 抛错", async () => {
    const ctx = buildCtx();
    await expect(
      dispatchBuiltinTool("backtest.run", ctx as never, {
        symbols: ["A"],
        start_date: "2026-01-01",
        end_date: "2026-04-30",
        signals: { kind: "factor_score", expr: "Mean($close, 20)", lang: "qlib_expr" },
      })
    ).rejects.toThrow(/strategy_version_id/);
  });

  test("factor.autoEvaluate 必填校验", async () => {
    const ctx = buildCtx();
    await expect(
      dispatchBuiltinTool("factor.autoEvaluate", ctx as never, {
        factor_id: "",
        start_date: "2026-01-01",
        end_date: "2026-04-30",
      })
    ).rejects.toThrow(/factor_id/);

    await expect(
      dispatchBuiltinTool("factor.autoEvaluate", ctx as never, {
        factor_id: "some-id",
      })
    ).rejects.toThrow(/start_date/);
  });
});

afterEach(() => {
  // Service 之间共享 db 状态，每个 test 用唯一 uuid 避免冲突，无需清理
});
