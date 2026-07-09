import { describe, expect, test } from "bun:test";
import { researchScenarioRegistry } from "../registry";
import { researchScenarioService } from "../service";
import { BUILTIN_RESEARCH_SCENARIOS } from "../scenarios-seed";
import { bootstrapProviders } from "../../provider/bootstrap";
import { runMigrations } from "../../../db/sqlite/migrate";

describe("Research scenario bootstrap + service", () => {
  test("启动序列：migrate → providers → scenarios", async () => {
    await runMigrations();
    await bootstrapProviders();
    await researchScenarioRegistry.bootstrap(BUILTIN_RESEARCH_SCENARIOS);

    const all = await researchScenarioRegistry.list();
    expect(all.length).toBe(BUILTIN_RESEARCH_SCENARIOS.length);

    const factor = researchScenarioRegistry.get("factor_research");
    expect(factor).not.toBeNull();
    expect(factor!.requiredCapabilities.some((c) => c.kind === "factor_compute")).toBe(true);
  });

  test("validate: 漏 required 字段 → invalid_input", async () => {
    const result = await researchScenarioService.validate("factor_research", {
      universe: "CN-A:hs300",
      // 漏 factorCategory（required）
    });
    expect(result.ok).toBe(false);
    expect(result.invalidInputs?.some((e) => e.field === "factorCategory" && e.error === "required")).toBe(
      true
    );
  });

  test("validate: enum 不在白名单 → not_in_enum", async () => {
    const result = await researchScenarioService.validate("factor_research", {
      universe: "Mars:dow",
      factorCategory: "momentum",
    });
    expect(result.invalidInputs?.some((e) => e.field === "universe")).toBe(true);
  });

  test("planLaunch: 默认场景配置解析成功", async () => {
    const plan = await researchScenarioService.planLaunch({
      scenarioKey: "stock_screening",
      projectId: "p-test",
      inputParams: { universe: "CN-A:csi500", topN: 30 },
    });
    expect(plan.scenarioKey).toBe("stock_screening");
    expect(plan.loopOptions.maxIterations).toBe(3);
  });

  test("planLaunch: scenario 不存在 → ScenarioError", async () => {
    await expect(
      researchScenarioService.planLaunch({
        scenarioKey: "non_existent",
        projectId: "p-test",
        inputParams: {},
      })
    ).rejects.toThrow(/scenario_not_found/);
  });
});
