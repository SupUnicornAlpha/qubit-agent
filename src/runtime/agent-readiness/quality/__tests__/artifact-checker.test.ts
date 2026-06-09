/**
 * P2 优先级 TDD（Round 7 复盘 2026-06-08）：artifact gate helper
 *
 * 覆盖：
 *   1. resolveScenarioKey 从 workflow_run.research_scenario_id 取值
 *   2. checkRequiredArtifacts 按 scenario 反查产物落库
 *   3. buildArtifactGapHint 输出可读 markdown
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildArtifactGapHint,
  checkRequiredArtifacts,
  resolveScenarioKey,
} from "../artifact-checker";

let sqlite: Database;

beforeAll(() => {
  /**
   * 建一个内存 DB，按 scenario-expectations.ts 用到的表名/列名建简版 schema。
   * 不用真实 schema 是因为 schema.ts 表很多且我们只需要 5 个 artifact 表。
   */
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE workflow_run (
      id TEXT PRIMARY KEY,
      research_scenario_id TEXT
    );
    CREATE TABLE analyst_signal (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT,
      ticker TEXT,
      reasoning TEXT
    );
    CREATE TABLE signal_fusion_result (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT
    );
    CREATE TABLE strategy_version (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT
    );
    CREATE TABLE strategy_composition (
      id TEXT PRIMARY KEY,
      strategy_version_id TEXT,
      factor_ids_json TEXT
    );
    CREATE TABLE order_intent (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT,
      side TEXT
    );
    CREATE TABLE risk_decision (
      id TEXT PRIMARY KEY,
      order_intent_id TEXT
    );
    CREATE TABLE factor_definition (
      id TEXT PRIMARY KEY,
      expr TEXT,
      workflow_run_id TEXT
    );
    CREATE TABLE factor_evaluation (
      id TEXT PRIMARY KEY,
      factor_id TEXT,
      ic REAL
    );
    CREATE TABLE screener_run (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT
    );
    CREATE TABLE screener_candidate (
      id TEXT PRIMARY KEY,
      screener_run_id TEXT
    );
  `);
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  /** 每个 test 重置数据；注意 factor_evaluation 先 delete（FK 概念上指向 factor_definition） */
  sqlite.exec(`
    DELETE FROM workflow_run;
    DELETE FROM analyst_signal;
    DELETE FROM signal_fusion_result;
    DELETE FROM strategy_version;
    DELETE FROM strategy_composition;
    DELETE FROM order_intent;
    DELETE FROM risk_decision;
    DELETE FROM factor_evaluation;
    DELETE FROM factor_definition;
    DELETE FROM screener_run;
    DELETE FROM screener_candidate;
  `);
});

describe("resolveScenarioKey (P2 artifact gate)", () => {
  test("已 tag 的 scenario → 返回 key", () => {
    sqlite
      .prepare("INSERT INTO workflow_run (id, research_scenario_id) VALUES (?, ?)")
      .run("wf-1", "strategy");
    expect(resolveScenarioKey(sqlite, "wf-1")).toBe("strategy");
  });

  test("未 tag（null）→ 返回 null", () => {
    sqlite.prepare("INSERT INTO workflow_run (id) VALUES (?)").run("wf-2");
    expect(resolveScenarioKey(sqlite, "wf-2")).toBeNull();
  });

  test("未知 scenario 值 → 返回 null（不强转）", () => {
    sqlite
      .prepare("INSERT INTO workflow_run (id, research_scenario_id) VALUES (?, ?)")
      .run("wf-3", "garbage_scenario");
    expect(resolveScenarioKey(sqlite, "wf-3")).toBeNull();
  });

  test("workflow 不存在 → 返回 null", () => {
    expect(resolveScenarioKey(sqlite, "wf-not-exist")).toBeNull();
  });
});

describe("checkRequiredArtifacts (P2 artifact gate)", () => {
  test("strategy scenario：无任何 strategy_version → missing", () => {
    const result = checkRequiredArtifacts(sqlite, "strategy", "wf-x");
    expect(result.ok).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.missing.some((m) => m.table === "strategy_version")).toBe(true);
    expect(result.missing.some((m) => m.table === "strategy_composition")).toBe(true);
    expect(result.rows.every((r) => r.rows === 0)).toBe(true);
  });

  test("strategy scenario：strategy_version + composition 都有 → ok", () => {
    sqlite
      .prepare("INSERT INTO strategy_version (id, workflow_run_id) VALUES (?, ?)")
      .run("sv-1", "wf-x");
    sqlite
      .prepare(
        "INSERT INTO strategy_composition (id, strategy_version_id, factor_ids_json) VALUES (?, ?, ?)"
      )
      .run("sc-1", "sv-1", '["f1"]');
    const result = checkRequiredArtifacts(sqlite, "strategy", "wf-x");
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  test("strategy scenario：composition.factor_ids_json='[]' → 不算满足", () => {
    sqlite
      .prepare("INSERT INTO strategy_version (id, workflow_run_id) VALUES (?, ?)")
      .run("sv-1", "wf-x");
    sqlite
      .prepare(
        "INSERT INTO strategy_composition (id, strategy_version_id, factor_ids_json) VALUES (?, ?, ?)"
      )
      .run("sc-1", "sv-1", "[]");
    const result = checkRequiredArtifacts(sqlite, "strategy", "wf-x");
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.table === "strategy_composition")).toBe(true);
  });

  test("live_trading scenario：无 order_intent → missing", () => {
    const result = checkRequiredArtifacts(sqlite, "live_trading", "wf-x");
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.table === "order_intent")).toBe(true);
  });

  test("live_trading scenario：有 side=buy order_intent + risk_decision → ok", () => {
    sqlite
      .prepare("INSERT INTO order_intent (id, workflow_run_id, side) VALUES (?, ?, ?)")
      .run("oi-1", "wf-x", "buy");
    sqlite
      .prepare("INSERT INTO risk_decision (id, order_intent_id) VALUES (?, ?)")
      .run("rd-1", "oi-1");
    const result = checkRequiredArtifacts(sqlite, "live_trading", "wf-x");
    expect(result.ok).toBe(true);
  });

  test("live_trading scenario：只有 side=sell 的 order → missing（做多场景要求 side=buy）", () => {
    sqlite
      .prepare("INSERT INTO order_intent (id, workflow_run_id, side) VALUES (?, ?, ?)")
      .run("oi-sell", "wf-x", "sell");
    sqlite
      .prepare("INSERT INTO risk_decision (id, order_intent_id) VALUES (?, ?)")
      .run("rd-sell", "oi-sell");
    const result = checkRequiredArtifacts(sqlite, "live_trading", "wf-x");
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.table === "order_intent")).toBe(true);
  });

  test("live_trading_short scenario：有 side=sell order_intent + risk_decision → ok", () => {
    sqlite
      .prepare("INSERT INTO order_intent (id, workflow_run_id, side) VALUES (?, ?, ?)")
      .run("oi-2", "wf-y", "sell");
    sqlite
      .prepare("INSERT INTO risk_decision (id, order_intent_id) VALUES (?, ?)")
      .run("rd-2", "oi-2");
    const result = checkRequiredArtifacts(sqlite, "live_trading_short", "wf-y");
    expect(result.ok).toBe(true);
  });

  test("live_trading_short scenario：只有 side=buy 的 order → missing（做空场景要求 side=sell）", () => {
    sqlite
      .prepare("INSERT INTO order_intent (id, workflow_run_id, side) VALUES (?, ?, ?)")
      .run("oi-buy", "wf-y", "buy");
    sqlite
      .prepare("INSERT INTO risk_decision (id, order_intent_id) VALUES (?, ?)")
      .run("rd-buy", "oi-buy");
    const result = checkRequiredArtifacts(sqlite, "live_trading_short", "wf-y");
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.table === "order_intent")).toBe(true);
  });

  test("research scenario：缺 analyst_signal → missing 含 minRows=2 元信息", () => {
    const result = checkRequiredArtifacts(sqlite, "research", "wf-x");
    expect(result.ok).toBe(false);
    const missingAS = result.missing.find((m) => m.table === "analyst_signal");
    expect(missingAS).toBeDefined();
    expect(missingAS?.minRows).toBe(2);
    expect(missingAS?.rows).toBe(0);
  });

  /**
   * Round 8 复盘（2026-06-08）：原 factor 场景 SQL 没用 workflow_run_id `?` 占位符
   * → 历史 round 的全库因子被误计为本 workflow 产出 → A-1 假阳性。
   */
  test("factor scenario：其他 workflow 的因子不应被计入本 workflow", () => {
    // 灌 1 条"别的 workflow"的 factor + evaluation
    sqlite
      .prepare(
        "INSERT INTO factor_definition (id, expr, workflow_run_id) VALUES (?, ?, ?)"
      )
      .run("f-other", "close - close[20]", "wf-other");
    sqlite
      .prepare("INSERT INTO factor_evaluation (id, factor_id, ic) VALUES (?, ?, ?)")
      .run("fe-other", "f-other", 0.04);

    const result = checkRequiredArtifacts(sqlite, "factor", "wf-current");
    expect(result.ok).toBe(false);
    expect(result.rows.find((r) => r.table === "factor_definition")?.rows).toBe(0);
    expect(result.rows.find((r) => r.table === "factor_evaluation")?.rows).toBe(0);
  });

  test("factor scenario：本 workflow 因子 + 评估齐全 → ok", () => {
    sqlite
      .prepare(
        "INSERT INTO factor_definition (id, expr, workflow_run_id) VALUES (?, ?, ?)"
      )
      .run("f-curr", "ret_20d", "wf-x");
    sqlite
      .prepare("INSERT INTO factor_evaluation (id, factor_id, ic) VALUES (?, ?, ?)")
      .run("fe-curr", "f-curr", 0.05);

    const result = checkRequiredArtifacts(sqlite, "factor", "wf-x");
    expect(result.ok).toBe(true);
  });

  test("factor scenario：本 workflow 有因子但 evaluation.ic IS NULL → 不算 ok", () => {
    sqlite
      .prepare(
        "INSERT INTO factor_definition (id, expr, workflow_run_id) VALUES (?, ?, ?)"
      )
      .run("f-x", "ret_20d", "wf-x");
    sqlite
      .prepare("INSERT INTO factor_evaluation (id, factor_id, ic) VALUES (?, ?, NULL)")
      .run("fe-x", "f-x");

    const result = checkRequiredArtifacts(sqlite, "factor", "wf-x");
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.table === "factor_evaluation")).toBe(true);
  });
});

describe("buildArtifactGapHint (P2 artifact gate)", () => {
  test("ok=true → 空串", () => {
    const hint = buildArtifactGapHint({
      scenario: "strategy",
      ok: true,
      missing: [],
      rows: [],
    });
    expect(hint).toBe("");
  });

  test("missing 有内容 → markdown 含场景名 + 表名 + 缺口数字", () => {
    const hint = buildArtifactGapHint({
      scenario: "strategy",
      ok: false,
      missing: [
        { table: "strategy_version", rows: 0, minRows: 1 },
        { table: "strategy_composition", rows: 0, minRows: 1 },
      ],
      rows: [],
    });
    expect(hint).toContain("strategy");
    expect(hint).toContain("strategy_version >= 1（当前 0）");
    expect(hint).toContain("strategy_composition >= 1（当前 0）");
    expect(hint).toContain("artifact gate");
    expect(hint).toContain("不要返回");
  });
});
