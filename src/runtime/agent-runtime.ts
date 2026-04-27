import { randomUUID } from "node:crypto";
import type { A2AMessageEnvelope } from "../types/a2a";
import { a2aRouter } from "../messaging/a2a";
import type {
  RuntimeAgentDefinition,
  RuntimeAgentInstance,
  RuntimeHandlerContext,
  RuntimeRoleHandler,
} from "./types";

/**
 * AgentRuntime
 * One shared runtime loop for all roles. Role behavior is injected by handler.
 */
export class AgentRuntime {
  readonly definition: RuntimeAgentDefinition;
  readonly instance: RuntimeAgentInstance;

  private readonly handler: RuntimeRoleHandler;
  private readonly unsubscribeFns: Array<() => void> = [];
  private readonly iterationByWorkflow = new Map<string, number>();
  private running = false;

  constructor(definition: RuntimeAgentDefinition, handler: RuntimeRoleHandler) {
    this.definition = definition;
    this.handler = handler;
    this.instance = {
      instanceId: randomUUID(),
      definitionId: definition.id,
      role: definition.role,
      status: "idle",
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    for (const type of this.definition.subscriptions) {
      const unsub = a2aRouter.on(type, async (msg) => this.processMessage(msg));
      this.unsubscribeFns.push(unsub);
    }

    this.instance.status = "running";
    this.running = true;

    if (this.handler.onInit) {
      await this.handler.onInit(this.buildContext());
    }

    console.log(
      `[AgentRuntime:${this.definition.role}] instance=${this.instance.instanceId} started.`
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    for (const unsub of this.unsubscribeFns) unsub();
    this.unsubscribeFns.length = 0;

    if (this.handler.onShutdown) {
      await this.handler.onShutdown(this.buildContext());
    }

    this.instance.status = "stopped";
    this.running = false;
    console.log(
      `[AgentRuntime:${this.definition.role}] instance=${this.instance.instanceId} stopped.`
    );
  }

  async processMessage(msg: A2AMessageEnvelope): Promise<void> {
    if (!this.running) return;

    // receiverAgent is treated as runtime instance id in V1.2 runtime mode
    if (msg.receiverAgent && msg.receiverAgent !== this.instance.instanceId) {
      return;
    }

    try {
      const iteration = this.markIteration(msg.workflowId);
      if (iteration > this.definition.maxIterations) {
        await this.send({
          workflowId: msg.workflowId,
          traceId: msg.traceId,
          receiverAgent: msg.senderAgent,
          messageType: "ALERT",
          payload: {
            alertType: "iteration_exceeded",
            severity: "error",
            message: `max_iterations exceeded for role=${this.definition.role}`,
            metadata: {
              maxIterations: this.definition.maxIterations,
              current: iteration,
            },
          },
          priority: 95,
        });
        return;
      }

      await this.handler.onMessage(this.buildContext(), msg);
    } catch (err) {
      this.instance.status = "error";
      console.error(
        `[AgentRuntime:${this.definition.role}] failed to process message ${msg.messageType}:`,
        err
      );
    }
  }

  markIteration(workflowId: string): number {
    const next = (this.iterationByWorkflow.get(workflowId) ?? 0) + 1;
    this.iterationByWorkflow.set(workflowId, next);
    return next;
  }

  async send(
    params: Omit<A2AMessageEnvelope, "messageId" | "createdAt" | "senderAgent">
  ): Promise<void> {
    await a2aRouter.send({
      ...params,
      senderAgent: this.instance.instanceId,
    });
  }

  private buildContext(): RuntimeHandlerContext {
    return {
      definition: this.definition,
      instance: this.instance,
      send: (params) => this.send(params),
      markIteration: (workflowId) => this.markIteration(workflowId),
    };
  }
}

