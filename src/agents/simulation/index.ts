import type { AgentRole, A2AMessageType } from "../../types/entities";
import type { A2AMessageEnvelope } from "../../types/a2a";
import { BaseAgent } from "../base.agent";

/**
 * SimulationAgent — paper trading simulation and execution quality analysis.
 *
 * Responsibilities:
 * - Subscribe to TASK_ASSIGN for simulation start/stop
 * - Run strategy against a paper TradingAccount
 * - Invoke ExecutionConnector in paper mode for order routing
 * - Compute execution quality metrics (slippage, fill rate, latency)
 * - Write SimulationRun records; emit MEMORY_WRITE for execution profiles
 */
export class SimulationAgent extends BaseAgent {
  readonly role: AgentRole = "simulation";
  readonly subscriptions: A2AMessageType[] = ["TASK_ASSIGN", "ORDER_INTENT"];

  protected async onInit(): Promise<void> {}

  protected async onMessage(msg: A2AMessageEnvelope): Promise<void> {
    switch (msg.messageType) {
      case "TASK_ASSIGN": {
        const payload = msg.payload as { taskType: string };
        if (payload.taskType === "start_simulation") {
          // TODO: initialize paper account, start simulation loop
        }
        break;
      }
      case "ORDER_INTENT":
        // TODO: route to paper execution, simulate fill
        break;
    }
  }

  protected async onShutdown(): Promise<void> {}
}

export const simulationAgent = new SimulationAgent();
