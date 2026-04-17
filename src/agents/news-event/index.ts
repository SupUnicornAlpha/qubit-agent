import type { AgentRole, A2AMessageType } from "../../types/entities";
import type { A2AMessageEnvelope } from "../../types/a2a";
import { BaseAgent } from "../base.agent";

/**
 * NewsEventAgent — news/announcement collection, event extraction, and scoring.
 *
 * Responsibilities:
 * - Subscribe to TASK_ASSIGN for news fetch requests
 * - Invoke DataConnector (news source) via ACP
 * - Extract structured events and compute sentiment scores
 * - Write NewsEvent records to SQLite
 * - Emit MEMORY_WRITE for significant events (e.g., earnings surprises)
 */
export class NewsEventAgent extends BaseAgent {
  readonly role: AgentRole = "news_event";
  readonly subscriptions: A2AMessageType[] = ["TASK_ASSIGN"];

  protected async onInit(): Promise<void> {}

  protected async onMessage(msg: A2AMessageEnvelope): Promise<void> {
    if (msg.messageType !== "TASK_ASSIGN") return;
    const payload = msg.payload as { taskType: string };
    if (payload.taskType !== "fetch_news") return;

    // TODO: invoke news DataConnector, extract events, write to DB
  }

  protected async onShutdown(): Promise<void> {}
}

export const newsEventAgent = new NewsEventAgent();
