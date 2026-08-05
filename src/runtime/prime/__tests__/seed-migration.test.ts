import { describe, expect, test } from "bun:test";
import {
  buildPrimeAgentSpecs,
  executionKindForRole,
  resolveExecutionKind,
  summarizePrimeSeed,
  toPrimeAgentSpec,
} from "../index";
import { SEED_AGENT_DEFINITIONS } from "../../seed-agent-definitions-data";

describe("prime seed → AgentSpec migration", () => {
  test("role maps to execution kind", () => {
    expect(executionKindForRole("orchestrator")).toBe("primary");
    expect(executionKindForRole("research")).toBe("subagent");
    expect(executionKindForRole("news_event")).toBe("reactor");
    expect(executionKindForRole("analyst_technical")).toBe("subagent");
  });

  test("resolveExecutionKind prefers explicit over role", () => {
    expect(
      resolveExecutionKind({ executionKind: "reactor", role: "orchestrator" })
    ).toBe("reactor");
    expect(resolveExecutionKind({ role: "orchestrator" })).toBe("primary");
  });

  test("every seed definition gets executionKind", () => {
    for (const def of SEED_AGENT_DEFINITIONS) {
      expect(def.executionKind).toBeDefined();
      expect(["primary", "subagent", "reactor"]).toContain(def.executionKind);
    }
  });

  test("prime specs preserve ids and fold role into labels", () => {
    const specs = buildPrimeAgentSpecs();
    const summary = summarizePrimeSeed(specs);
    expect(summary.total).toBe(SEED_AGENT_DEFINITIONS.length);
    expect(summary.byKind.primary).toBeGreaterThanOrEqual(1);
    expect(summary.byKind.subagent).toBeGreaterThanOrEqual(1);
    expect(summary.byKind.reactor).toBeGreaterThanOrEqual(1);
    expect(summary.primaryId).toBe("def-orchestrator");

    const orch = specs.find((s) => s.id === "def-orchestrator")!;
    expect(orch.execution_kind).toBe("primary");
    expect(orch.labels).toContain("orchestrator");

    const news = toPrimeAgentSpec(
      SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-news-event")!
    );
    expect(news.execution_kind).toBe("reactor");
    expect(news.triggers[0]).toEqual({
      kind: "domain_event",
      event_name: "market.news",
    });
  });
});
