import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { runMigrations } from "../../../db/sqlite/migrate";
import { bootstrapProviders, _resetBootstrapForTests } from "../../provider/bootstrap";
import { ruleService, RuleServiceError } from "../rule-service";

let projectId = "";

beforeAll(async () => {
  await runMigrations();
  _resetBootstrapForTests();
  await bootstrapProviders();
  const db = await getDb();
  const wid = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({ id: wid, name: "rs-ws", owner: "test" });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId: wid,
    name: "rs-proj",
    marketScope: "CN-A",
    status: "active",
  });
});

describe("RuleService", () => {
  test("register: 合法 DSL → 写库 + parse pass", async () => {
    const r = await ruleService.register({
      projectId,
      name: `low_pe_high_mom_${randomUUID().slice(0, 6)}`,
      appliesTo: "score",
      dsl: {
        when: { "<": [{ factor: "pe" }, 30] },
        score: { weighted_sum: [{ factor: "mom", w: 0.7 }, { factor: "quality", w: 0.3 }] },
      },
    });
    expect(r.id).toBeTruthy();
    expect(r.appliesTo).toBe("score");
    expect(r.lang).toBe("jsonlogic");
    expect(r.status).toBe("draft");
  });

  test("register: 非法 DSL → 抛 parse_failed", async () => {
    await expect(
      ruleService.register({
        projectId,
        name: `bad_${randomUUID().slice(0, 6)}`,
        dsl: { irrelevant: 1 },
      })
    ).rejects.toMatchObject({ code: "parse_failed" });
  });

  test("register: 重名 → duplicate_name", async () => {
    const name = `dup_${randomUUID().slice(0, 6)}`;
    await ruleService.register({
      projectId,
      name,
      dsl: { score: { factor: "mom" } },
    });
    await expect(
      ruleService.register({
        projectId,
        name,
        dsl: { score: { factor: "mom" } },
      })
    ).rejects.toBeInstanceOf(RuleServiceError);
  });

  test("evaluate: 写 rule_evaluation_log 留痕", async () => {
    const r = await ruleService.register({
      projectId,
      name: `mom_pos_${randomUUID().slice(0, 6)}`,
      dsl: {
        when: { ">": [{ factor: "mom" }, 0] },
        score: { factor: "mom" },
      },
    });
    const res = await ruleService.evaluate({
      ruleId: r.id,
      context: {
        asof: "2026-05-20",
        universe: "CN-A:hs300",
        factorContext: {
          A: { mom: 0.05 },
          B: { mom: -0.01 },
          C: { mom: 0.08 },
        },
      },
    });
    expect(res.evaluationId).toBeTruthy();
    const a = res.symbols.find((s) => s.symbol === "A");
    const b = res.symbols.find((s) => s.symbol === "B");
    expect(a?.passed).toBe(true);
    expect(b?.passed).toBe(false);

    const logs = await ruleService.listEvaluationLogs(r.id);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.ruleId).toBe(r.id);
    expect(logs[0]?.sampleSize).toBe(3);
  });
});
