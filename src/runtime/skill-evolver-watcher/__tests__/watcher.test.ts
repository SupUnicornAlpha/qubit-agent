/**
 * P6 SkillEvolverWatcher 集成测：reflective(skill_revision_request) 队列 → SkillEvolver.evolve。
 *
 * Fixture：workspace → project → 一条 base agent_skill；自助构造 reflective 请求。
 * SkillEvolver 用 mock 实现避免触发 LLM；watcher 只验编排。
 *
 * 覆盖：
 *   1) 首次跑：未处理请求 → 调 evolve → 回写 evolutionRunId
 *   2) 重跑：已 processed 的请求被跳过（evolve 不再调）
 *   3) base 不存在 → skipped_base_missing；processedAt 仍回写
 *   4) base 已 archived → skipped_base_archived
 *   5) 多条请求批处理：成功/失败/跳过 三类同时存在
 *   6) requestSkillRevision 6h 内同 base 去重 → status='deduped'
 *   7) emitMetrics=true → 收到 maintenance_run/skill_evolver event
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import {
  agentSkill as agentSkillTable,
  experience as experienceTable,
  project,
  workspace,
} from "../../../db/sqlite/schema";
import type { ExperienceBus } from "../../experience/experience-bus";
import { getExperienceStore } from "../../experience/experience-store";
import { SkillEvolver } from "../../skills/skill-evolve";
import { requestSkillRevision } from "../request-skill-revision";
import { SkillEvolverWatcher } from "../watcher";
import type { SkillRevisionRequestMeta } from "../types";

interface Fixture {
  workspaceId: string;
  projectId: string;
  baseSkillId: string;
  archivedSkillId: string;
}

let fixture: Fixture;

beforeAll(async () => {
  process.env.QUBIT_DATA_DIR = join("/tmp", `qubit-p6-watcher-${Date.now()}`);
  await runMigrations();
  const db = await getDb();
  const f: Fixture = {
    workspaceId: `ws_${randomUUID()}`,
    projectId: `prj_${randomUUID()}`,
    baseSkillId: `skill_${randomUUID()}`,
    archivedSkillId: `skill_${randomUUID()}`,
  };
  await db.insert(workspace).values({ id: f.workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: f.projectId, workspaceId: f.workspaceId, name: "p", marketScope: "US" })
    .run();
  // base skill（active）+ archived skill 用于测试 base archived 分支
  await db
    .insert(agentSkillTable)
    .values({
      id: f.baseSkillId,
      projectId: f.projectId,
      name: "base_skill",
      description: "test skill",
      bodyMd: "## 步骤\n1. 调 tool A\n2. 调 tool B\n3. 输出 final answer\n",
      state: "active",
    })
    .run();
  await db
    .insert(agentSkillTable)
    .values({
      id: f.archivedSkillId,
      projectId: f.projectId,
      name: "archived_skill",
      description: "已归档",
      bodyMd: "## 步骤\n1. 已废弃\n",
      state: "archived",
    })
    .run();
  fixture = f;
});

beforeEach(async () => {
  // 清掉本 project 所有 reflective request，避免跨用例污染
  const db = await getDb();
  await db.delete(experienceTable).where(eq(experienceTable.scopeId, fixture.projectId));
});

/** 用 mock SkillEvolver 避开 LLM 依赖 */
function makeMockEvolver(opts: {
  shouldFail?: boolean;
  returningRunId?: string;
}): SkillEvolver {
  const evolver = new SkillEvolver();
  // 替换 evolve 方法
  (evolver as unknown as { evolve: SkillEvolver["evolve"] }).evolve = async (input) => {
    if (opts.shouldFail) {
      return {
        evolutionRunId: "run_failed",
        status: "failed",
        baselineScore: 0,
        bestScore: 0,
        winningSkillId: null,
        winningCandidate: null,
        candidates: [],
        promoted: false,
        errorMessage: "mock failure",
      };
    }
    return {
      evolutionRunId: opts.returningRunId ?? `run_${input.baseSkillId.slice(0, 6)}`,
      status: "completed",
      baselineScore: 0.5,
      bestScore: 0.7,
      winningSkillId: `evo_${input.baseSkillId.slice(0, 6)}`,
      winningCandidate: null,
      candidates: [],
      promoted: true,
    };
  };
  return evolver;
}

describe("SkillEvolverWatcher.runOnce", () => {
  test("1) 首次跑：未处理请求 → 调 evolve → 回写 evolutionRunId", async () => {
    const { experienceId } = await requestSkillRevision({
      projectId: fixture.projectId,
      baseSkillId: fixture.baseSkillId,
      requestedBy: "test",
      reason: "tool chain ABT 失败 3 次",
    });

    const watcher = new SkillEvolverWatcher({ evolver: makeMockEvolver({}) });
    const summary = await watcher.runOnce({
      projectId: fixture.projectId,
      emitMetrics: false,
    });
    expect(summary.scanned).toBe(1);
    expect(summary.processed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]!.status).toBe("completed");
    expect(summary.results[0]!.evolutionRunId).toBeTruthy();

    const store = getExperienceStore();
    const exp = await store.findById(experienceId);
    const meta = exp!.metadataJson as unknown as SkillRevisionRequestMeta;
    expect(meta.processedAt).toBeTruthy();
    expect(meta.evolveStatus).toBe("completed");
    expect(meta.evolutionRunId).toBeTruthy();
  });

  test("2) 重跑：已 processed 的请求 evolve 不再调", async () => {
    await requestSkillRevision({
      projectId: fixture.projectId,
      baseSkillId: fixture.baseSkillId,
      requestedBy: "test",
    });

    let evolveCalls = 0;
    const evolver = makeMockEvolver({});
    const origEvolve = evolver.evolve.bind(evolver);
    (evolver as unknown as { evolve: SkillEvolver["evolve"] }).evolve = async (input) => {
      evolveCalls += 1;
      return origEvolve(input);
    };
    const watcher = new SkillEvolverWatcher({ evolver });
    await watcher.runOnce({ projectId: fixture.projectId, emitMetrics: false });
    expect(evolveCalls).toBe(1);

    const summary2 = await watcher.runOnce({ projectId: fixture.projectId, emitMetrics: false });
    expect(evolveCalls).toBe(1); // 没再调
    expect(summary2.processed).toBe(0);
    expect(summary2.scanned).toBe(1); // 仍能看到但跳过
  });

  test("3) base 不存在 → skipped_base_missing；processedAt 仍回写", async () => {
    const { experienceId } = await requestSkillRevision({
      projectId: fixture.projectId,
      baseSkillId: "skill_does_not_exist",
      requestedBy: "test",
    });

    const watcher = new SkillEvolverWatcher({ evolver: makeMockEvolver({}) });
    const summary = await watcher.runOnce({
      projectId: fixture.projectId,
      emitMetrics: false,
    });
    expect(summary.skippedBaseMissing).toBe(1);
    expect(summary.processed).toBe(0);

    const store = getExperienceStore();
    const exp = await store.findById(experienceId);
    const meta = exp!.metadataJson as unknown as SkillRevisionRequestMeta;
    expect(meta.evolveStatus).toBe("skipped_base_missing");
    expect(meta.processedAt).toBeTruthy();
  });

  test("4) base 已 archived → skipped_base_archived", async () => {
    await requestSkillRevision({
      projectId: fixture.projectId,
      baseSkillId: fixture.archivedSkillId,
      requestedBy: "test",
    });
    const watcher = new SkillEvolverWatcher({ evolver: makeMockEvolver({}) });
    const summary = await watcher.runOnce({
      projectId: fixture.projectId,
      emitMetrics: false,
    });
    expect(summary.skippedBaseArchived).toBe(1);
  });

  test("5) 多条混合：base ok + base missing + base archived", async () => {
    await requestSkillRevision({
      projectId: fixture.projectId,
      baseSkillId: fixture.baseSkillId,
      requestedBy: "test",
    });
    await requestSkillRevision({
      projectId: fixture.projectId,
      baseSkillId: "skill_404",
      requestedBy: "test",
    });
    await requestSkillRevision({
      projectId: fixture.projectId,
      baseSkillId: fixture.archivedSkillId,
      requestedBy: "test",
    });

    const watcher = new SkillEvolverWatcher({ evolver: makeMockEvolver({}) });
    const summary = await watcher.runOnce({
      projectId: fixture.projectId,
      emitMetrics: false,
    });
    expect(summary.scanned).toBe(3);
    expect(summary.processed).toBe(1);
    expect(summary.skippedBaseMissing).toBe(1);
    expect(summary.skippedBaseArchived).toBe(1);
  });

  test("6) requestSkillRevision 6h 内同 base 去重", async () => {
    const a = await requestSkillRevision({
      projectId: fixture.projectId,
      baseSkillId: fixture.baseSkillId,
      requestedBy: "test",
    });
    expect(a.status).toBe("created");
    const b = await requestSkillRevision({
      projectId: fixture.projectId,
      baseSkillId: fixture.baseSkillId,
      requestedBy: "test",
    });
    expect(b.status).toBe("deduped");
    expect(b.experienceId).toBe(a.experienceId);
  });

  test("7) emitMetrics=true 触发 maintenance_run/skill_evolver event", async () => {
    await requestSkillRevision({
      projectId: fixture.projectId,
      baseSkillId: fixture.baseSkillId,
      requestedBy: "test",
    });
    const captured: { kind: string; summary: Record<string, unknown> }[] = [];
    const handlers = new Set<(ev: { kind: string; summary: Record<string, number | string> }) => void>();
    const bus: ExperienceBus = {
      emit: (ev) => {
        if (ev.type === "maintenance_run") for (const h of handlers) h(ev);
      },
      subscribe: (_type, handler) => {
        const h = handler as unknown as (ev: { kind: string; summary: Record<string, number | string> }) => void;
        handlers.add(h);
        return () => handlers.delete(h);
      },
      handlerCount: () => handlers.size,
      clearAllForTesting: () => handlers.clear(),
    };
    bus.subscribe("maintenance_run", (ev) => {
      captured.push({ kind: ev.kind, summary: ev.summary });
    });
    const watcher = new SkillEvolverWatcher({ bus, evolver: makeMockEvolver({}) });
    await watcher.runOnce({ projectId: fixture.projectId, emitMetrics: true });
    const evs = captured.filter((e) => e.kind === "skill_evolver");
    expect(evs.length).toBe(1);
    expect(Number(evs[0]!.summary.processed)).toBe(1);
  });

  test("8) evolve 抛错 → 标 failed + errorMessage 回写", async () => {
    await requestSkillRevision({
      projectId: fixture.projectId,
      baseSkillId: fixture.baseSkillId,
      requestedBy: "test",
    });
    const evolver = new SkillEvolver();
    (evolver as unknown as { evolve: SkillEvolver["evolve"] }).evolve = async () => {
      throw new Error("boom");
    };
    const watcher = new SkillEvolverWatcher({ evolver });
    const summary = await watcher.runOnce({
      projectId: fixture.projectId,
      emitMetrics: false,
    });
    expect(summary.failed).toBe(1);
    expect(summary.processed).toBe(0);
    expect(summary.results[0]!.errorMessage).toBe("boom");
  });
});
