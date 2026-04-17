import type { AgentRole, A2AMessageType } from "../../types/entities";
import type { A2AMessageEnvelope, MemoryWritePayload } from "../../types/a2a";
import { BaseAgent } from "../base.agent";
import { createMemoryRouter } from "../../connectors/memory/memory.router";
import type { MemoryRouter } from "../../connectors/memory/memory.router";

/**
 * MemoryAgent — multi-layer memory read/write, retrieval, and TTL governance.
 *
 * Architecture:
 * - Owns the MemoryRouter, which routes between Native and External connectors
 * - Receives MEMORY_WRITE messages from all other agents
 * - Provides memory retrieval on demand (via direct call, not A2A — low latency)
 * - Handles TTL cleanup for session memory
 * - Logs all external sync operations to memory_sync_log
 */
export class MemoryAgent extends BaseAgent {
  readonly role: AgentRole = "memory";
  readonly subscriptions: A2AMessageType[] = ["MEMORY_WRITE", "TASK_ASSIGN"];

  private router: MemoryRouter;

  constructor() {
    super();
    this.router = createMemoryRouter({
      writeMode: "native_only",
      fallbackToNative: true,
    });
  }

  protected async onInit(): Promise<void> {
    // TODO: load memory_backend_config from DB and configure router accordingly
    // Start TTL cleanup interval for session memory
    setInterval(() => this._cleanupExpiredSessions(), 15 * 60 * 1000);
  }

  protected async onMessage(msg: A2AMessageEnvelope): Promise<void> {
    switch (msg.messageType) {
      case "MEMORY_WRITE": {
        const payload = msg.payload as MemoryWritePayload;
        await this.router.add(JSON.stringify(payload.content), {
          layer: payload.layer,
          asofTime: payload.asofTime,
          memoryType: payload.memoryType,
          ...(payload.metadata ?? {}),
        });
        break;
      }
      case "TASK_ASSIGN": {
        const payload = msg.payload as { taskType: string };
        if (payload.taskType === "memory_search") {
          // TODO: run search and emit TASK_RESULT
        }
        break;
      }
    }
  }

  protected async onShutdown(): Promise<void> {}

  getRouter(): MemoryRouter {
    return this.router;
  }

  private async _cleanupExpiredSessions(): Promise<void> {
    try {
      const { sessionStore } = await import("../../connectors/memory/native/session.store");
      await sessionStore.deleteExpired();
    } catch (err) {
      console.warn("[MemoryAgent] Session cleanup failed:", err);
    }
  }
}

export const memoryAgent = new MemoryAgent();
