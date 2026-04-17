import type { AgentRole, A2AMessageType } from "../../types/entities";
import type { A2AMessageEnvelope } from "../../types/a2a";
import { BaseAgent } from "../base.agent";

/**
 * ResearchAgent — factor research, strategy generation, and interpretation.
 *
 * Responsibilities:
 * - Subscribe to TASK_ASSIGN for research tasks
 * - Invoke ResearchConnector via ACP for factor computation / model training
 * - Generate StrategyVersion candidates based on research findings
 * - Write ResearchExperiment and FactorDefinition records
 * - Emit MEMORY_WRITE for significant factor discoveries
 * - Support SKILL-based research templates (e.g., momentum factor template)
 */
export class ResearchAgent extends BaseAgent {
  readonly role: AgentRole = "research";
  readonly subscriptions: A2AMessageType[] = ["TASK_ASSIGN", "MODEL_UPDATE"];

  protected async onInit(): Promise<void> {}

  protected async onMessage(msg: A2AMessageEnvelope): Promise<void> {
    switch (msg.messageType) {
      case "TASK_ASSIGN": {
        const payload = msg.payload as { taskType: string };
        if (payload.taskType === "run_research") {
          // TODO: run factor computation, generate strategy candidates
        }
        break;
      }
      case "MODEL_UPDATE":
        // TODO: update local model references
        break;
    }
  }

  protected async onShutdown(): Promise<void> {}
}

export const researchAgent = new ResearchAgent();
