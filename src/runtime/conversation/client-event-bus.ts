/**
 * Session 级 ClientEvent 总线 + StepStream → ClientEvent 投影。
 */

import type { StepStreamEvent } from "../react/state";
import { type ClientEvent, makeClientEvent } from "./client-event";

type StreamController = ReadableStreamDefaultController<Uint8Array>;

const SSE_HEARTBEAT_MS = 25_000;
const SESSION_BUFFER_CAP = 500;

interface SessionBuffer {
  events: ClientEvent[];
}

class ClientEventBus {
  private controllersBySession = new Map<string, Set<StreamController>>();
  private bufferBySession = new Map<string, SessionBuffer>();
  private heartbeatByController = new WeakMap<StreamController, ReturnType<typeof setInterval>>();
  private encoder = new TextEncoder();

  private safeClose(controller: StreamController): void {
    const timer = this.heartbeatByController.get(controller);
    if (timer !== undefined) {
      clearInterval(timer);
      this.heartbeatByController.delete(controller);
    }
    try {
      controller.close();
    } catch {
      /* already closed */
    }
  }

  private startHeartbeat(controller: StreamController): void {
    const timer = setInterval(() => {
      try {
        controller.enqueue(this.encoder.encode(`: hb ${Date.now()}\n\n`));
      } catch {
        clearInterval(timer);
        this.heartbeatByController.delete(controller);
      }
    }, SSE_HEARTBEAT_MS);
    this.heartbeatByController.set(controller, timer);
  }

  private encode(event: ClientEvent): Uint8Array {
    return this.encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  publish(event: ClientEvent): void {
    const buf = this.bufferBySession.get(event.sessionId) ?? { events: [] };
    buf.events.push(event);
    if (buf.events.length > SESSION_BUFFER_CAP) {
      buf.events.splice(0, buf.events.length - SESSION_BUFFER_CAP);
    }
    this.bufferBySession.set(event.sessionId, buf);

    const set = this.controllersBySession.get(event.sessionId);
    if (!set) return;
    const data = this.encode(event);
    for (const controller of set) {
      try {
        controller.enqueue(data);
      } catch {
        /* ignore */
      }
    }
  }

  createSessionSseStream(sessionId: string): ReadableStream<Uint8Array> {
    let currentController: StreamController | null = null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        currentController = controller;
        try {
          controller.enqueue(this.encoder.encode(": stream-open\n\n"));
          const buf = this.bufferBySession.get(sessionId);
          if (buf) {
            for (const ev of buf.events) {
              controller.enqueue(this.encode(ev));
            }
          }
        } catch {
          /* ignore */
        }
        const set = this.controllersBySession.get(sessionId) ?? new Set<StreamController>();
        set.add(controller);
        this.controllersBySession.set(sessionId, set);
        this.startHeartbeat(controller);
      },
      cancel: () => {
        if (!currentController) return;
        const set = this.controllersBySession.get(sessionId);
        if (!set) return;
        set.delete(currentController);
        this.safeClose(currentController);
        if (set.size === 0) this.controllersBySession.delete(sessionId);
      },
    });
  }
}

export const clientEventBus = new ClientEventBus();

export interface ProjectStepContext {
  sessionId: string;
  turnId: string;
}

/**
 * 将内部 StepStreamEvent 投影为 ClientEvent；无法映射时返回 null。
 */
export function projectStepStreamToClientEvent(
  event: StepStreamEvent,
  ctx: ProjectStepContext
): ClientEvent | null {
  const base = {
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    runId: event.workflowId,
    ts: event.ts,
  };

  if (event.type === "hitl_request") {
    return makeClientEvent({
      ...base,
      type: "approval.requested",
      item: {
        id: String((event.payload as { requestId?: string }).requestId ?? event.stepIndex),
        kind: "approval",
        payload: event.payload,
      },
    });
  }

  if (event.type === "token" || event.type === "plan" || event.type === "tool_rationale") {
    return makeClientEvent({
      ...base,
      type: "item.delta",
      item: {
        id: `${event.runId}:${event.stepIndex}:${event.type}`,
        kind: event.type,
        payload: event.payload,
      },
    });
  }

  if (
    event.type === "tool_call_start" ||
    event.type === "tool_call_end" ||
    event.type === "observe" ||
    event.type === "step_persisted"
  ) {
    return makeClientEvent({
      ...base,
      type: "item.completed",
      item: {
        id: `${event.runId}:${event.stepIndex}:${event.type}`,
        kind: event.type,
        payload: event.payload,
      },
    });
  }

  if (event.type === "final") {
    return makeClientEvent({
      ...base,
      type: "turn.completed",
      item: {
        id: `${event.runId}:final`,
        kind: "final",
        payload: event.payload,
      },
    });
  }

  if (event.type === "error") {
    return makeClientEvent({
      ...base,
      type: "turn.failed",
      item: {
        id: `${event.runId}:error`,
        kind: "error",
        payload: event.payload,
      },
    });
  }

  return null;
}

/** 发布 turn.started（在 createConversationTurn 成功后调用） */
export function publishTurnStarted(input: {
  sessionId: string;
  turnId: string;
  runId: string;
  turnMode: string;
  agentRunId?: string;
}): void {
  clientEventBus.publish(
    makeClientEvent({
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.runId,
      type: "turn.started",
      item: {
        id: input.turnId,
        kind: "turn",
        payload: {
          turnMode: input.turnMode,
          ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
        },
      },
    })
  );
}
