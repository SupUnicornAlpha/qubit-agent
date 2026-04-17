import type { AgentRole, A2AMessageType } from "../../types/entities";
import type { A2AMessageEnvelope } from "../../types/a2a";
import { BaseAgent } from "../base.agent";

/**
 * MarketDataAgent — market data collection, quality assessment, and snapshot management.
 *
 * Responsibilities:
 * - Subscribe to TASK_ASSIGN for data fetch requests
 * - Invoke DataConnector via ACP to pull bars, ticks, fundamentals
 * - Validate data quality and emit quality_score
 * - Write DatasetSnapshot records to SQLite
 * - Store Parquet files to local FS for DuckDB querying
 */
export class MarketDataAgent extends BaseAgent {
  readonly role: AgentRole = "market_data";
  readonly subscriptions: A2AMessageType[] = ["TASK_ASSIGN"];

  protected async onInit(): Promise<void> {
    // TODO: register default DataConnectors from config
  }

  protected async onMessage(msg: A2AMessageEnvelope): Promise<void> {
    if (msg.messageType !== "TASK_ASSIGN") return;
    const payload = msg.payload as { taskType: string };
    if (payload.taskType !== "fetch_market_data") return;

    // TODO: dispatch to DataConnector via ACP, write snapshot, report TASK_RESULT
  }

  protected async onShutdown(): Promise<void> {}
}

export const marketDataAgent = new MarketDataAgent();
