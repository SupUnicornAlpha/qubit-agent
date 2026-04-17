import { randomUUID } from "node:crypto";
import type { A2AMessageType, AgentRole } from "../types/entities";
import type { A2AMessageEnvelope } from "../types/a2a";
import { a2aRouter } from "../messaging/a2a";

export interface AgentConfig {
  id?: string;
  version?: string;
}

export interface AgentContext {
  workflowId: string;
  sessionId: string;
  traceId: string;
}

/**
 * BaseAgent — abstract base class for all QUBIT agents.
 *
 * Each concrete agent must declare:
 *   - `role`: its AgentRole
 *   - `subscriptions`: which A2A message types it handles
 *   - `onMessage(msg)`: message handler
 *   - `onInit()`: startup logic
 *   - `onShutdown()`: teardown logic
 */
export abstract class BaseAgent {
  readonly id: string;
  readonly version: string;
  abstract readonly role: AgentRole;
  abstract readonly subscriptions: A2AMessageType[];

  protected running = false;
  private unsubscribeFns: Array<() => void> = [];

  constructor(config: AgentConfig = {}) {
    this.id = config.id ?? randomUUID();
    this.version = config.version ?? "1.0.0";
  }

  async start(): Promise<void> {
    await this.onInit();
    for (const type of this.subscriptions) {
      const unsub = a2aRouter.on(type, (msg) => this._handleMessage(msg));
      this.unsubscribeFns.push(unsub);
    }
    this.running = true;
    console.log(`[Agent:${this.role}] ${this.id} started.`);
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubscribeFns) unsub();
    this.unsubscribeFns = [];
    await this.onShutdown();
    this.running = false;
    console.log(`[Agent:${this.role}] ${this.id} stopped.`);
  }

  protected async send(
    params: Omit<A2AMessageEnvelope, "messageId" | "createdAt" | "senderAgent">
  ): Promise<void> {
    await a2aRouter.send({
      ...params,
      senderAgent: this.id,
    });
  }

  private async _handleMessage(msg: A2AMessageEnvelope): Promise<void> {
    try {
      await this.onMessage(msg);
    } catch (err) {
      console.error(
        `[Agent:${this.role}] Error handling message [${msg.messageType}]:`,
        err
      );
    }
  }

  protected abstract onInit(): Promise<void>;
  protected abstract onMessage(msg: A2AMessageEnvelope): Promise<void>;
  protected abstract onShutdown(): Promise<void>;
}
