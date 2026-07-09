/**
 * Research scenario bootstrap：upsert 11 个内置场景
 *
 * 启动顺序约束：
 *   1. runMigrations 之后
 *   2. seed-agent-definitions 之后
 */

import { researchScenarioRegistry } from "./registry";
import { BUILTIN_RESEARCH_SCENARIOS } from "./scenarios-seed";

let bootstrapPromise: Promise<void> | null = null;

export function bootstrapResearchScenarios(): Promise<void> {
  bootstrapPromise ??= (async () => {
    await researchScenarioRegistry.bootstrap(BUILTIN_RESEARCH_SCENARIOS);

    console.log(
      `[ResearchScenario] bootstrap done: ${BUILTIN_RESEARCH_SCENARIOS.length} scenarios registered`
    );
  })();
  return bootstrapPromise;
}

export function _resetResearchScenarioBootstrapForTests(): void {
  bootstrapPromise = null;
  researchScenarioRegistry._resetForTests();
}
