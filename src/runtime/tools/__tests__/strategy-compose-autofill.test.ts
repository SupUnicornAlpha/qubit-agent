/**
 * Unit tests — strategy.compose 在 kind=factor_score 但 agent 未传 factor_ids 时
 * 自动从 factor_definition 拉 top-3 兜底。
 *
 * 修复背景（2026-06-09）：
 *   Agent Readiness Evaluation R-7 跑了 4 次 strategy.compose 调用，2 次因
 *   `factor_score_requires_factor_ids` 直接 abort —— Agent prompt 引导力不足 +
 *   StrategyComposer 没兜底导致；引入 top-3 自动兜底后这 2 次 abort 应转为成功。
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dispatchBuiltinTool } from "../builtin-tools";
import { runMigrations } from "../../../db/sqlite/migrate";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { factorService } from "../../factor/factor-service";

const NOW = "2026-06-09T00:00:00.000Z";

let workspaceId: string;
let projectId: string;
let strategyVersionId: string;
let workflowRunId: string;

const buildCtx = () => ({
  workflowId: workflowRunId,
  agentInstanceId: randomUUID(),
  traceId: randomUUID(),
  definition: { id: "agent.test", role: "researcher" as const },
  projectId,
  workspaceId,
});

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  const db = await getDb();
  workspaceId = randomUUID();
  projectId = randomUUID();
  workflowRunId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: "ws_strategy_compose_autofill",
    owner: "test",
    createdAt: NOW,
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "p_strategy_compose_autofill",
    marketScope: "CN-A",
    createdAt: NOW,
  });
  /**
   * workflow_run 必须存在，否则 builtin tools 里的 resolveProjectIdForWorkflow
   * 拿不到 projectId，自动兜底分支会走 catch 退回原报错。
   */
  await db.insert(schema.workflowRun).values({
    id: workflowRunId,
    projectId,
    goal: "test_compose_autofill",
    mode: "research",
    source: "manual",
    status: "running",
    loopKind: "native",
    createdAt: NOW,
  } as never);

  // 给项目挂 5 个 active 因子，验证只取前 3
  // register 默认 status='draft'，需要显式置 active 模拟 agent autoEvaluate 后的状态
  for (let i = 0; i < 5; i++) {
    await factorService.register({
      projectId,
      name: `mom_${i + 1}d`,
      category: "momentum",
      expr: `(close - REF(close, ${i + 1})) / REF(close, ${i + 1})`,
      lang: "qlib_expr",
      status: "active",
    });
  }

  // 建 strategy + strategy_version（compose 调用必须依赖 version 行存在）
  const strategyId = randomUUID();
  strategyVersionId = randomUUID();
  await db.insert(schema.strategy).values({
    id: strategyId,
    projectId,
    name: "test_strategy",
    style: "factor_score",
    createdAt: NOW,
  });
  await db.insert(schema.strategyVersion).values({
    id: strategyVersionId,
    strategyId,
    versionTag: "v1",
    logicHash: "deadbeef",
    paramSchemaJson: {} as never,
    workflowRunId,
    createdAt: NOW,
  });
});

describe("strategy.compose · factor_score 自动兜底", () => {
  test("kind=factor_score 没传 factor_ids → 自动注入项目下 top-3 active 因子", async () => {
    const ctx = buildCtx();
    const out = (await dispatchBuiltinTool("strategy.compose", ctx as never, {
      strategy_version_id: strategyVersionId,
      kind: "factor_score",
    })) as { id: string; factorIds: string[] };
    expect(out.id).toBeTruthy();
    expect(out.factorIds.length).toBe(3);
  });

  test("kind=factor_score 显式传了 factor_ids → 沿用传入值、不覆盖", async () => {
    const ctx = buildCtx();
    const explicit = (
      await factorService.list({ projectId, status: "active" })
    ).map((f) => f.id);
    const picked = explicit.slice(0, 2);
    const out = (await dispatchBuiltinTool("strategy.compose", ctx as never, {
      strategy_version_id: strategyVersionId,
      kind: "factor_score",
      factor_ids: picked,
    })) as { id: string; factorIds: string[] };
    expect(out.factorIds.sort()).toEqual([...picked].sort());
  });

  test("项目下没 active 因子 → 退回原校验报错 factor_score_requires_factor_ids", async () => {
    /**
     * 单独的 project（无因子）来复现"兜底也找不到候选"的场景：
     * 此时应优雅退回原报错，而不是 silent 通过 0 个 factorIds。
     */
    const db = await getDb();
    const lonelyProj = randomUUID();
    const lonelyWfRun = randomUUID();
    await db.insert(schema.project).values({
      id: lonelyProj,
      workspaceId,
      name: "p_no_factor",
      marketScope: "CN-A",
      createdAt: NOW,
    });
    await db.insert(schema.workflowRun).values({
      id: lonelyWfRun,
      projectId: lonelyProj,
      goal: "test_compose_no_factor",
      mode: "research",
      source: "manual",
      status: "running",
      loopKind: "native",
      createdAt: NOW,
    } as never);
    const sid = randomUUID();
    const svid = randomUUID();
    await db.insert(schema.strategy).values({
      id: sid,
      projectId: lonelyProj,
      name: "test_strategy_no_factor",
      style: "factor_score",
      createdAt: NOW,
    });
    await db.insert(schema.strategyVersion).values({
      id: svid,
      strategyId: sid,
      versionTag: "v1",
      logicHash: "cafe",
      paramSchemaJson: {} as never,
      workflowRunId: lonelyWfRun,
      createdAt: NOW,
    });

    const ctx = {
      workflowId: lonelyWfRun,
      agentInstanceId: randomUUID(),
      traceId: randomUUID(),
      definition: { id: "agent.test", role: "researcher" as const },
      projectId: lonelyProj,
      workspaceId,
    };
    await expect(
      dispatchBuiltinTool("strategy.compose", ctx as never, {
        strategy_version_id: svid,
        kind: "factor_score",
      })
    ).rejects.toThrow(/factor_score_requires_factor_ids/);
  });
});
