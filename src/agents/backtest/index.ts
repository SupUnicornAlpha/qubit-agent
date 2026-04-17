import type { AgentRole, A2AMessageType } from "../../types/entities";
import type { A2AMessageEnvelope } from "../../types/a2a";
import { BaseAgent } from "../base.agent";

/**
 * BacktestAgent — backtest orchestration and result standardization.
 *
 * Responsibilities:
 * - Subscribe to TASK_ASSIGN for backtest requests
 * - Invoke BacktestConnector via ACP (Backtrader / vn.py / Lean)
 * - Normalize performance metrics into standard BacktestPerformance schema
 * - Write BacktestRun records to SQLite; store result artifacts to FS
 * - Emit MEMORY_WRITE for notable backtest conclusions
 */
export class BacktestAgent extends BaseAgent {
  readonly role: AgentRole = "backtest";
  readonly subscriptions: A2AMessageType[] = ["TASK_ASSIGN"];

  protected async onInit(): Promise<void> {}

  protected async onMessage(msg: A2AMessageEnvelope): Promise<void> {
    if (msg.messageType !== "TASK_ASSIGN") return;
    const payload = msg.payload as { taskType: string };
    if (payload.taskType !== "run_backtest") return;

    // TODO: invoke BacktestConnector, normalize results, write to DB
  }

  protected async onShutdown(): Promise<void> {}
}

export const backtestAgent = new BacktestAgent();
