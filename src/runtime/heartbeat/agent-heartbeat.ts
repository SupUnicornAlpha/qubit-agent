/**
 * Agent 心跳：把一个 workflow 内每个 agent_instance 的"活跃度"计算出来，
 * 给前端拓扑画布 / 会话流 / monitor 面板共用。
 *
 * 数据来源：agent_instance + 该 instance 最近一条 agent_step。
 * silenceMs 越大 → 该 agent 越像"卡住"；前端按阈值（30s/120s）变色。
 *
 * 这里不引入新表也不改 schema —— 用现有 agent_step.createdAt 作为隐含心跳。
 *
 * 该模块同时支持：
 *   - 一次性 polling（GET /agent-heartbeats）：路由直接调 computeWorkflowHeartbeat
 *   - SSE 推流（GET /agent-heartbeats/stream）：heartbeatStreamBus 共享 4s tick
 *     给所有 listener 推同一份 snapshot，多个前端 tab 订阅 N 个 workflow 时也
 *     不会乘 N 倍跑 DB
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentInstance, agentStep, workflowRun } from "../../db/sqlite/schema";

export interface AgentHeartbeat {
  instanceId: string;
  role: string;
  name: string;
  status: string;
  currentIteration: number;
  lastPhase: string | null;
  lastStepIndex: number | null;
  lastStepAt: string | null;
  silenceMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  alive: boolean;
}

export interface WorkflowHeartbeatSnapshot {
  workflowRunId: string;
  status: string;
  heartbeats: AgentHeartbeat[];
  summary: {
    aliveAgents: number;
    totalAgents: number;
    lastStepAt: string | null;
    silenceMs: number | null;
    totalSteps: number;
    asOf: string;
  };
}

export type WorkflowHeartbeatResult =
  | { kind: "ok"; snapshot: WorkflowHeartbeatSnapshot }
  | { kind: "not_found" };

/**
 * 计算单个 workflow 的心跳 snapshot。每次调用是一个 DB 查询批次，控制在 N+2
 * 次（N=活跃 instance 数量级，典型 ≤ 10）。
 */
export async function computeWorkflowHeartbeat(
  workflowRunId: string
): Promise<WorkflowHeartbeatResult> {
  const db = await getDb();

  const wfRow = await db
    .select({ id: workflowRun.id, status: workflowRun.status })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
  if (!wfRow[0]) return { kind: "not_found" };

  const instances = await db
    .select({
      instanceId: agentInstance.id,
      definitionId: agentInstance.definitionId,
      status: agentInstance.status,
      currentIteration: agentInstance.currentIteration,
      startedAt: agentInstance.startedAt,
      endedAt: agentInstance.endedAt,
      role: agentDefinition.role,
      name: agentDefinition.name,
    })
    .from(agentInstance)
    .innerJoin(agentDefinition, eq(agentDefinition.id, agentInstance.definitionId))
    .where(eq(agentInstance.workflowRunId, workflowRunId));

  const nowMs = Date.now();
  const heartbeats: AgentHeartbeat[] = [];

  for (const inst of instances) {
    const lastStepRows = await db
      .select({
        phase: agentStep.phase,
        stepIndex: agentStep.stepIndex,
        createdAt: agentStep.createdAt,
      })
      .from(agentStep)
      .where(
        and(
          eq(agentStep.agentInstanceId, inst.instanceId),
          eq(agentStep.workflowRunId, workflowRunId)
        )
      )
      .orderBy(desc(agentStep.createdAt))
      .limit(1);
    const last = lastStepRows[0];
    const lastStepAt = last?.createdAt ?? inst.startedAt ?? null;
    const silenceMs =
      lastStepAt && !inst.endedAt ? Math.max(0, nowMs - new Date(lastStepAt).getTime()) : null;
    const alive = inst.status !== "stopped" && !inst.endedAt;
    heartbeats.push({
      instanceId: inst.instanceId,
      role: inst.role,
      name: inst.name,
      status: inst.status,
      currentIteration: inst.currentIteration ?? 0,
      lastPhase: last?.phase ?? null,
      lastStepIndex: last?.stepIndex ?? null,
      lastStepAt: lastStepAt ?? null,
      silenceMs,
      startedAt: inst.startedAt ?? null,
      endedAt: inst.endedAt ?? null,
      alive,
    });
  }

  const aliveCount = heartbeats.filter((h) => h.alive).length;
  const summaryRow = await db
    .select({
      lastStepAt: sql<string | null>`MAX(${agentStep.createdAt})`,
      totalSteps: sql<number>`COUNT(*)`,
    })
    .from(agentStep)
    .where(eq(agentStep.workflowRunId, workflowRunId));
  const wfLastStepAt = summaryRow[0]?.lastStepAt ?? null;
  const wfSilenceMs = wfLastStepAt ? Math.max(0, nowMs - new Date(wfLastStepAt).getTime()) : null;

  return {
    kind: "ok",
    snapshot: {
      workflowRunId,
      status: wfRow[0].status,
      heartbeats,
      summary: {
        aliveAgents: aliveCount,
        totalAgents: heartbeats.length,
        lastStepAt: wfLastStepAt,
        silenceMs: wfSilenceMs,
        totalSteps: Number(summaryRow[0]?.totalSteps ?? 0),
        asOf: new Date(nowMs).toISOString(),
      },
    },
  };
}

/**
 * 当 workflow 进入终态后停止 SSE tick；这里把"终态"判定收口在一处避免散落。
 */
export function isWorkflowTerminalStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "stopped" ||
    status === "canceled" ||
    status === "cancelled"
  );
}

// ─── SSE bus ─────────────────────────────────────────────────────────────────

type StreamController = ReadableStreamDefaultController<Uint8Array>;

/** 心跳推流 tick 间隔。跟前端原来 polling 4s 一致，避免改 UX 节奏。 */
const HEARTBEAT_TICK_MS = 4_000;
/** SSE 注释 keepalive 间隔（< Bun.serve idleTimeout 上限），EventSource 会忽略。 */
const SSE_KEEPALIVE_MS = 25_000;
/** workflow 终态后保持流多久再 close（兼容前端 onmessage 处理"终态"消息后再断）。 */
const FINAL_DRAIN_MS = 10_000;

interface RunStream {
  workflowRunId: string;
  controllers: Set<StreamController>;
  tickTimer: ReturnType<typeof setInterval> | null;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  drainTimer: ReturnType<typeof setTimeout> | null;
  lastPayload: WorkflowHeartbeatSnapshot | null;
}

class HeartbeatStreamBus {
  private streamsByRun = new Map<string, RunStream>();
  private encoder = new TextEncoder();

  private encodeEvent(name: string, data: unknown): Uint8Array {
    return this.encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private safeEnqueue(controller: StreamController, chunk: Uint8Array): boolean {
    try {
      controller.enqueue(chunk);
      return true;
    } catch {
      return false;
    }
  }

  private safeClose(controller: StreamController): void {
    try {
      controller.close();
    } catch {
      // ignore double close
    }
  }

  private async tick(state: RunStream): Promise<void> {
    if (state.controllers.size === 0) return;
    const result = await computeWorkflowHeartbeat(state.workflowRunId).catch((err) => {
      console.error(
        "[heartbeat-stream] computeWorkflowHeartbeat failed",
        err instanceof Error ? err.message : err
      );
      return { kind: "not_found" as const };
    });
    if (result.kind === "not_found") {
      this.broadcast(state, "heartbeat_error", {
        workflowRunId: state.workflowRunId,
        error: "workflow_not_found",
      });
      this.scheduleClose(state);
      return;
    }
    state.lastPayload = result.snapshot;
    this.broadcast(state, "heartbeat", result.snapshot);

    /** workflow 已落入终态：再发一条 heartbeat_end 并安排延迟 close */
    if (isWorkflowTerminalStatus(result.snapshot.status)) {
      this.broadcast(state, "heartbeat_end", {
        workflowRunId: state.workflowRunId,
        status: result.snapshot.status,
      });
      this.scheduleClose(state);
    }
  }

  private broadcast(state: RunStream, name: string, data: unknown): void {
    const chunk = this.encodeEvent(name, data);
    const dead: StreamController[] = [];
    for (const c of state.controllers) {
      if (!this.safeEnqueue(c, chunk)) dead.push(c);
    }
    for (const c of dead) state.controllers.delete(c);
  }

  private scheduleClose(state: RunStream): void {
    if (state.drainTimer != null) return;
    state.drainTimer = setTimeout(() => {
      this.shutdown(state);
    }, FINAL_DRAIN_MS);
  }

  private shutdown(state: RunStream): void {
    if (state.tickTimer) {
      clearInterval(state.tickTimer);
      state.tickTimer = null;
    }
    if (state.keepaliveTimer) {
      clearInterval(state.keepaliveTimer);
      state.keepaliveTimer = null;
    }
    if (state.drainTimer) {
      clearTimeout(state.drainTimer);
      state.drainTimer = null;
    }
    for (const c of state.controllers) this.safeClose(c);
    state.controllers.clear();
    this.streamsByRun.delete(state.workflowRunId);
  }

  private getOrCreate(workflowRunId: string): RunStream {
    let state = this.streamsByRun.get(workflowRunId);
    if (state) return state;
    state = {
      workflowRunId,
      controllers: new Set(),
      tickTimer: null,
      keepaliveTimer: null,
      drainTimer: null,
      lastPayload: null,
    };
    this.streamsByRun.set(workflowRunId, state);
    return state;
  }

  private ensureTimers(state: RunStream): void {
    if (state.tickTimer == null) {
      state.tickTimer = setInterval(() => {
        void this.tick(state);
      }, HEARTBEAT_TICK_MS);
    }
    if (state.keepaliveTimer == null) {
      state.keepaliveTimer = setInterval(() => {
        const chunk = this.encoder.encode(`: hb ${Date.now()}\n\n`);
        const dead: StreamController[] = [];
        for (const c of state.controllers) {
          if (!this.safeEnqueue(c, chunk)) dead.push(c);
        }
        for (const c of dead) state.controllers.delete(c);
      }, SSE_KEEPALIVE_MS);
    }
  }

  createSseStream(workflowRunId: string): ReadableStream<Uint8Array> {
    const state = this.getOrCreate(workflowRunId);
    let currentController: StreamController | null = null;
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        currentController = controller;
        state.controllers.add(controller);

        try {
          this.safeEnqueue(controller, this.encoder.encode(": stream-open\n\n"));

          /** 立即推一条 snapshot：让前端不用等第一个 4s tick */
          if (state.lastPayload) {
            this.safeEnqueue(controller, this.encodeEvent("heartbeat", state.lastPayload));
          } else {
            const initial = await computeWorkflowHeartbeat(workflowRunId);
            if (initial.kind === "ok") {
              state.lastPayload = initial.snapshot;
              this.safeEnqueue(controller, this.encodeEvent("heartbeat", initial.snapshot));
              if (isWorkflowTerminalStatus(initial.snapshot.status)) {
                this.safeEnqueue(
                  controller,
                  this.encodeEvent("heartbeat_end", {
                    workflowRunId,
                    status: initial.snapshot.status,
                  })
                );
                /** 终态 workflow：单条快照就够了，不再开 timer，下面延迟关闭 */
                state.controllers.delete(controller);
                this.safeClose(controller);
                if (state.controllers.size === 0) this.streamsByRun.delete(workflowRunId);
                return;
              }
            } else {
              this.safeEnqueue(
                controller,
                this.encodeEvent("heartbeat_error", {
                  workflowRunId,
                  error: "workflow_not_found",
                })
              );
              state.controllers.delete(controller);
              this.safeClose(controller);
              if (state.controllers.size === 0) this.streamsByRun.delete(workflowRunId);
              return;
            }
          }
        } catch (err) {
          console.error("[heartbeat-stream] initial push failed", err);
        }

        this.ensureTimers(state);
      },
      cancel: () => {
        if (!currentController) return;
        state.controllers.delete(currentController);
        this.safeClose(currentController);
        if (state.controllers.size === 0) {
          /** 没人订阅了，立刻停 timer 释放资源；下次有人来再起 */
          if (state.tickTimer) {
            clearInterval(state.tickTimer);
            state.tickTimer = null;
          }
          if (state.keepaliveTimer) {
            clearInterval(state.keepaliveTimer);
            state.keepaliveTimer = null;
          }
          /** 不删 streamsByRun：保留 lastPayload 让短暂重连能秒拿；
           *  drainTimer 没到的话仍然继续走 */
        }
      },
    });
  }

  /** 测试 / shutdown 手动调用，断所有连接清 timer。 */
  closeAll(): void {
    for (const state of [...this.streamsByRun.values()]) {
      this.shutdown(state);
    }
  }
}

export const heartbeatStreamBus = new HeartbeatStreamBus();
