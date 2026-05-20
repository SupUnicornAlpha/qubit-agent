import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { a2aMessage, workflowRun } from "../db/sqlite/schema";
import { a2aRouter } from "../messaging/a2a";
import type { A2AMessageEnvelope } from "../types/a2a";
import { A2A_POOL_WORKFLOW_ID } from "./a2a/constants";
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
export interface AgentRuntimeOptions {
  /** When set, must match agent_instance.id (used by A2A pool). */
  instanceId?: string;
}

export class AgentRuntime {
  readonly definition: RuntimeAgentDefinition;
  readonly instance: RuntimeAgentInstance;

  private readonly handler: RuntimeRoleHandler;
  private readonly unsubscribeFns: Array<() => void> = [];
  private readonly iterationByWorkflow = new Map<string, number>();
  private running = false;

  constructor(
    definition: RuntimeAgentDefinition,
    handler: RuntimeRoleHandler,
    options?: AgentRuntimeOptions
  ) {
    this.definition = definition;
    this.handler = handler;
    this.instance = {
      instanceId: options?.instanceId ?? randomUUID(),
      definitionId: definition.id,
      role: definition.role,
      status: "idle",
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Phase 2.6：进程重启后，把"还没结束的 workflow"在本 instance 上累计接收过的消息数
    // 回填到 iterationByWorkflow，让 max-iterations 防护跨重启依然有效。
    await this.restoreIterationCounters();

    for (const type of this.definition.subscriptions) {
      const unsub = a2aRouter.on(type, async (msg) => this.processMessage(msg));
      this.unsubscribeFns.push(unsub);
    }

    this.instance.status = "running";
    this.running = true;

    if (this.handler.onInit) {
      await this.handler.onInit(this.buildContext());
    }

    const restoredSuffix =
      this.iterationByWorkflow.size > 0
        ? ` Restored ${this.iterationByWorkflow.size} iteration counter(s).`
        : "";
    console.log(
      `[AgentRuntime:${this.definition.role}] instance=${this.instance.instanceId} started.${restoredSuffix}`
    );
  }

  /**
   * Phase 2.6：用 `a2a_message` 表里发给本 instance 的消息数作为 iteration 计数底数。
   *
   * 严格意义上，`markIteration` 在内存中每收到一条 A2A 消息 +1；持久层等价于
   * `SELECT count(*) FROM a2a_message WHERE receiver_instance_id = self GROUP BY workflow_run_id`。
   * 仅回填还在跑的 workflow（status in pending/running 且 ended_at IS NULL）。
   *
   * 注：persistA2AMessage 会跳过 sender 为非 UUID 的消息（如 "system"），所以是 best-effort
   * 下限——重启后再来的几条消息可能再加 1~2，仍能正确触发 max-iterations 兜底。
   */
  private async restoreIterationCounters(): Promise<void> {
    try {
      const db = await getDb();
      const rows = await db
        .select({
          workflowRunId: a2aMessage.workflowRunId,
          cnt: sql<number>`count(*)`.as("cnt"),
        })
        .from(a2aMessage)
        .innerJoin(workflowRun, eq(workflowRun.id, a2aMessage.workflowRunId))
        .where(
          and(
            eq(a2aMessage.receiverInstanceId, this.instance.instanceId),
            or(eq(workflowRun.status, "running"), eq(workflowRun.status, "pending")),
            isNull(workflowRun.endedAt),
            ne(workflowRun.id, A2A_POOL_WORKFLOW_ID)
          )
        )
        .groupBy(a2aMessage.workflowRunId);
      for (const row of rows) {
        if (row.workflowRunId && row.cnt > 0) {
          this.iterationByWorkflow.set(row.workflowRunId, row.cnt);
        }
      }
    } catch (err) {
      console.warn(
        `[AgentRuntime:${this.definition.role}] failed to restore iteration counters:`,
        err instanceof Error ? err.message : err
      );
    }
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

    if (msg.receiverAgent) {
      const forInstance = msg.receiverAgent === this.instance.instanceId;
      const forRole = msg.receiverAgent === this.definition.role;
      if (!forInstance && !forRole) return;
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
