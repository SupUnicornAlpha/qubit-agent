import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { RESEARCH_PROGRAM_ENTRY_TOOLS } from "../../harness/research-program-harness";
import { SEED_AGENT_DEFINITIONS } from "../../seed-agent-definitions-data";
import {
  buildPrimeAgentSpecs,
  executionKindForRole,
  resolveExecutionKind,
  summarizePrimeSeed,
  toPrimeAgentSpec,
} from "../index";

describe("prime seed → AgentSpec migration", () => {
  test("role maps to execution kind", () => {
    expect(executionKindForRole("orchestrator")).toBe("primary");
    expect(executionKindForRole("research")).toBe("subagent");
    // Research news is invokable (call_team); event wake uses def-news-reactor.
    expect(executionKindForRole("news_event")).toBe("subagent");
    expect(executionKindForRole("analyst_technical")).toBe("subagent");
  });

  test("resolveExecutionKind prefers explicit over role", () => {
    expect(resolveExecutionKind({ executionKind: "reactor", role: "orchestrator" })).toBe(
      "reactor"
    );
    expect(resolveExecutionKind({ role: "orchestrator" })).toBe("primary");
  });

  test("every seed definition gets executionKind", () => {
    for (const def of SEED_AGENT_DEFINITIONS) {
      expect(def.executionKind).toBeDefined();
      if (!def.executionKind) throw new Error(`missing_execution_kind:${def.id}`);
      expect(["primary", "subagent", "reactor"] as string[]).toContain(def.executionKind);
    }
  });

  test("prime specs preserve ids and fold role into labels", () => {
    const specs = buildPrimeAgentSpecs();
    const summary = summarizePrimeSeed(specs);
    expect(summary.total).toBe(SEED_AGENT_DEFINITIONS.length);
    expect(summary.byKind.primary).toBeGreaterThanOrEqual(1);
    expect(summary.byKind.subagent).toBeGreaterThanOrEqual(1);
    // Reactor specs (def-news-reactor) are Core-bootstrapped, not Bun seed roles.
    expect(summary.primaryId).toBe("def-orchestrator");

    const orch = specs.find((s) => s.id === "def-orchestrator");
    if (!orch) throw new Error("missing_orchestrator_seed");
    expect(orch.execution_kind).toBe("primary");
    expect(orch.labels).toContain("orchestrator");
    expect(orch.tools).toEqual([
      ...new Set([
        ...(SEED_AGENT_DEFINITIONS.find((def) => def.id === "def-orchestrator")?.tools ?? []),
        ...RESEARCH_PROGRAM_ENTRY_TOOLS,
      ]),
    ]);

    const newsDefinition = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-news-event");
    if (!newsDefinition) throw new Error("missing_news_seed");
    const news = toPrimeAgentSpec(newsDefinition);
    expect(news.execution_kind).toBe("subagent");
    expect(news.triggers).toEqual([]);
    expect(news.labels).toContain("news_event");

    const coderDefinition = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-strategy-coder");
    if (!coderDefinition) throw new Error("missing_coder_seed");
    const coder = toPrimeAgentSpec(coderDefinition);
    expect(coder.execution_kind).toBe("subagent");
    expect(coder.labels).toContain("strategy_coder");
    expect(coder.labels).toContain("research");
    for (const name of RESEARCH_PROGRAM_ENTRY_TOOLS) expect(coder.tools).toContain(name);
    const monitor = SEED_AGENT_DEFINITIONS.find((def) => def.id === "def-execution-monitor");
    if (!monitor) throw new Error("missing_monitor_seed");
    expect(toPrimeAgentSpec(monitor).tools).toEqual(monitor.tools);
  });

  test("packaged Rust seed versions do not drift from runtime definitions", async () => {
    const packaged = JSON.parse(
      await readFile(
        new URL("../../../../crates/qubit-app-server/seed/prime-agent-specs.json", import.meta.url),
        "utf8"
      )
    ) as Array<{ id: string; version: string }>;
    const runtimeById = new Map(buildPrimeAgentSpecs().map((spec) => [spec.id, spec] as const));
    for (const spec of packaged) {
      expect(runtimeById.get(spec.id)?.version).toBe(spec.version);
    }
  });
});
