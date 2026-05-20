/**
 * Research scenario bootstrap：upsert 11 个内置场景 + 绑定默认编组
 *
 * 启动顺序约束：
 *   1. runMigrations 之后
 *   2. seed-agent-definitions（确保 agent_group 表里已有 BUILTIN_AGENT_GROUPS）之后
 */

import { researchScenarioRegistry } from "./registry";
import { BUILTIN_RESEARCH_SCENARIOS } from "./scenarios-seed";

let bootstrapPromise: Promise<void> | null = null;

export function bootstrapResearchScenarios(): Promise<void> {
  bootstrapPromise ??= (async () => {
    await researchScenarioRegistry.bootstrap(BUILTIN_RESEARCH_SCENARIOS);

    // 默认编组绑定：每个场景自动绑定它的 defaultAgentGroupId
    for (const spec of BUILTIN_RESEARCH_SCENARIOS) {
      if (!spec.defaultAgentGroupId) continue;
      await researchScenarioRegistry.bindGroup({
        scenarioKey: spec.key,
        agentGroupId: spec.defaultAgentGroupId,
        isDefault: true,
        sortOrder: 0,
      });
    }

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
