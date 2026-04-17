export { BaseAgent } from "./base.agent";
export { OrchestratorAgent, orchestratorAgent } from "./orchestrator";
export { MarketDataAgent, marketDataAgent } from "./market-data";
export { NewsEventAgent, newsEventAgent } from "./news-event";
export { ResearchAgent, researchAgent } from "./research";
export { BacktestAgent, backtestAgent } from "./backtest";
export { SimulationAgent, simulationAgent } from "./simulation";
export { RiskAgent, riskAgent } from "./risk";
export { ExecutionAgent, executionAgent } from "./execution";
export { MemoryAgent, memoryAgent } from "./memory";
export { AuditAgent, auditAgent } from "./audit";

import type { BaseAgent } from "./base.agent";
import { orchestratorAgent } from "./orchestrator";
import { marketDataAgent } from "./market-data";
import { newsEventAgent } from "./news-event";
import { researchAgent } from "./research";
import { backtestAgent } from "./backtest";
import { simulationAgent } from "./simulation";
import { riskAgent } from "./risk";
import { executionAgent } from "./execution";
import { memoryAgent } from "./memory";
import { auditAgent } from "./audit";

export const ALL_AGENTS: BaseAgent[] = [
  orchestratorAgent,
  marketDataAgent,
  newsEventAgent,
  researchAgent,
  backtestAgent,
  simulationAgent,
  riskAgent,
  executionAgent,
  memoryAgent,
  auditAgent,
];

export async function startAllAgents(): Promise<void> {
  for (const agent of ALL_AGENTS) {
    await agent.start();
  }
  console.log(`[AgentPool] All ${ALL_AGENTS.length} agents started.`);
}

export async function stopAllAgents(): Promise<void> {
  for (const agent of [...ALL_AGENTS].reverse()) {
    await agent.stop();
  }
  console.log("[AgentPool] All agents stopped.");
}
