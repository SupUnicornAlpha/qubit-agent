import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { toolMatchesRequiredCapability } from "./data-gap";
import {
  assessRequiredToolGate,
  listAuthorizedToolsFromSqlite,
  listWorkflowAttemptedToolsFromSqlite,
} from "./required-tool-gate";

describe("required tool gate (workflow scope)", () => {
  test("credits child-agent tool_call_log rows as attempted", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE tool_call_log (
        id TEXT PRIMARY KEY,
        workflow_run_id TEXT,
        tool_name TEXT
      );
      INSERT INTO tool_call_log VALUES
        ('1', 'wf-1', 'factor.register'),
        ('2', 'wf-1', 'market.readiness');
    `);
    const attempted = listWorkflowAttemptedToolsFromSqlite(sqlite, "wf-1", ["update_plan"]);
    expect(attempted).toContain("factor.register");
    expect(attempted).toContain("update_plan");
  });

  test("unions enabled agent tools as authorized", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE agent_definition (
        id TEXT PRIMARY KEY,
        enabled INTEGER,
        tools_json TEXT
      );
      INSERT INTO agent_definition VALUES
        ('orch', 1, '["run_screener"]'),
        ('research', 1, '["factor.register","strategy.create_version"]'),
        ('disabled', 0, '["order.create_intent"]');
    `);
    const authorized = listAuthorizedToolsFromSqlite(sqlite, ["evaluate_risk"]);
    expect(authorized).toContain("run_screener");
    expect(authorized).toContain("factor.register");
    expect(authorized).toContain("evaluate_risk");
    expect(authorized).not.toContain("order.create_intent");
  });

  test("does not mark factor unconfigured when research authorizes it", () => {
    const gate = assessRequiredToolGate({
      requiredTools: ["factor", "screener"],
      authorizedTools: ["factor.register", "run_screener"],
      attemptedTools: ["run_screener"],
      runnableTools: ["run_screener"],
      unavailableManifestTools: [],
      market: "US",
    });
    expect(gate.unavailableRequired).toEqual([]);
    expect(gate.notAttempted.map((g) => g.capability)).toEqual(["factor"]);
  });

  test("treats workflow-attempted factor.register as satisfying factor", () => {
    const gate = assessRequiredToolGate({
      requiredTools: ["factor"],
      authorizedTools: ["factor.register"],
      attemptedTools: ["factor.register"],
      runnableTools: [],
      unavailableManifestTools: [],
      market: "CN",
    });
    expect(gate.unavailableRequired).toEqual([]);
    expect(gate.notAttempted).toEqual([]);
  });

  test("risk aliases do not treat bare substring hits as order", () => {
    expect(toolMatchesRequiredCapability("evaluate_risk", "risk")).toBe(true);
    expect(toolMatchesRequiredCapability("evaluate_risk", "order")).toBe(false);
    expect(toolMatchesRequiredCapability("order.create_intent", "order")).toBe(true);
    expect(toolMatchesRequiredCapability("call_team_risk", "risk")).toBe(true);
  });
});
