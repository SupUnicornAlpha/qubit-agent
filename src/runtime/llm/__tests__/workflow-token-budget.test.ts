import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../../db/sqlite/schema";
import {
  loadWorkflowTokenBudgetStatus,
  resolveWorkflowTokenBudget,
} from "../workflow-token-budget";

describe("resolveWorkflowTokenBudget", () => {
  test("chat 多 Agent 单轮默认拥有 1M 预算", () => {
    const chat = resolveWorkflowTokenBudget(undefined, {
      source: "chat",
      mode: "research",
      researchScenarioId: null,
    });
    const research = resolveWorkflowTokenBudget(undefined, {
      source: "manual",
      mode: "research",
      researchScenarioId: "factor_research",
    });
    expect(chat.maxTotalTokens).toBe(1_000_000);
    expect(research.maxTotalTokens).toBe(1_000_000);
  });

  test("workflow override 覆盖默认值", () => {
    const policy = resolveWorkflowTokenBudget(
      {
        maxTotalTokens: 50_000,
        softLimitRatio: 0.7,
        maxPromptTokensPerCall: 9_000,
      },
      { source: "chat", mode: "research", researchScenarioId: null }
    );
    expect(policy.maxTotalTokens).toBe(50_000);
    expect(policy.softLimitRatio).toBe(0.7);
    expect(policy.maxPromptTokensPerCall).toBe(9_000);
    expect(policy.maxSystemPromptChars).toBeGreaterThan(0);
  });

  test("复用 workflow 时只统计当前轮次，不让历史 token 阻塞后续对话", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE workflow_run (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        mode TEXT NOT NULL,
        research_scenario_id TEXT,
        loop_options_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE llm_call_log (
        workflow_run_id TEXT NOT NULL,
        total_tokens INTEGER,
        created_at TEXT NOT NULL
      );
      INSERT INTO workflow_run (
        id, source, mode, research_scenario_id, loop_options_json, created_at
      ) VALUES (
        'reused-workflow', 'manual', 'research', NULL, '{}', '2026-07-29T05:48:16.061Z'
      );
      INSERT INTO llm_call_log (workflow_run_id, total_tokens, created_at) VALUES
        ('reused-workflow', 390000, '2026-07-28T02:51:34.000Z'),
        ('reused-workflow', 20000,  '2026-07-29T05:48:29.185Z');
    `);
    const db = drizzle(sqlite, { schema });

    const status = await loadWorkflowTokenBudgetStatus(db, "reused-workflow");

    expect(status.usedTokens).toBe(20_000);
    expect(status.remainingTokens).toBe(980_000);
    expect(status.hardLimitReached).toBe(false);

    sqlite.exec(`
      INSERT INTO llm_call_log (workflow_run_id, total_tokens, created_at)
      VALUES ('reused-workflow', 990000, '2026-07-29T05:49:00.000Z');
    `);
    const exhaustedCurrentTurn = await loadWorkflowTokenBudgetStatus(db, "reused-workflow");
    expect(exhaustedCurrentTurn.usedTokens).toBe(1_010_000);
    expect(exhaustedCurrentTurn.hardLimitReached).toBe(true);
    sqlite.close();
  });
});
