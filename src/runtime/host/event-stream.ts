/**
 * Bun Host SSE step-stream bus.
 *
 * Host observability surface — not an Agent runtime. Wired via `ports/step-stream`.
 */

import { clientEventBus, projectStepStreamToClientEvent } from "../conversation/client-event-bus";
import { getTurnBindingByWorkflow } from "../conversation/turn-binding";
import { setStepStreamPorts } from "../ports/step-stream";
import type { StepStreamEvent } from "./step-stream-types";

export type { StepEventType, StepStreamEvent } from "./step-stream-types";

type StreamController = ReadableStreamDefaultController<Uint8Array>;

/** How long (ms) to keep buffered events after the run is closed, for late subscribers. */
const BUFFER_TTL_MS = 120_000; // 2 minutes

/**
 * SSE 心跳间隔。Bun.serve idleTimeout 上限 255s；这里取一个明显小于它的值
 * （25s），保证：
 *   - 即使后端 LLM 推理长时间无 token 输出，连接也不会被 Bun 或上游代理判定为 idle。
 *   - 发送的是 SSE 注释行 `: hb\n\n`，EventSource 客户端按规范会直接忽略。
 */
const SSE_HEARTBEAT_MS = 25_000;

interface RunBuffer {
  events: StepStreamEvent[];
  /** null = still running; number = timestamp when close() was called */
  closedAt: number | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Workflow 级（跨 runId）firehose 的 late-join 缓冲上限。
 */
const WORKFLOW_BUFFER_CAP = 400;

class StepStreamBus {
  private controllersByRun = new Map<string, Set<StreamController>>();
  private bufferByRun = new Map<string, RunBuffer>();
  private controllersByWorkflow = new Map<string, Set<StreamController>>();
  private workflowBuffer = new Map<string, StepStreamEvent[]>();
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
      // Ignore already-closed stream errors.
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

  private encodeEvent(event: StepStreamEvent): Uint8Array {
    return this.encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private getOrCreateBuffer(runId: string): RunBuffer {
    const existing = this.bufferByRun.get(runId);
    if (existing) return existing;
    const buf: RunBuffer = { events: [], closedAt: null, cleanupTimer: null };
    this.bufferByRun.set(runId, buf);
    return buf;
  }

  createSseStream(runId: string): ReadableStream<Uint8Array> {
    let currentController: StreamController | null = null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        currentController = controller;
        const buf = this.bufferByRun.get(runId);
        try {
          controller.enqueue(this.encoder.encode(": stream-open\n\n"));
          if (buf) {
            for (const evt of buf.events) {
              controller.enqueue(this.encodeEvent(evt));
            }
            if (buf.closedAt !== null) {
              this.safeClose(controller);
              return;
            }
          }
        } catch {
          // ignore enqueue on aborted stream
        }
        const set = this.controllersByRun.get(runId) ?? new Set<StreamController>();
        set.add(controller);
        this.controllersByRun.set(runId, set);
        this.startHeartbeat(controller);
      },
      cancel: () => {
        if (!currentController) return;
        const set = this.controllersByRun.get(runId);
        if (!set) return;
        set.delete(currentController);
        this.safeClose(currentController);
        if (set.size === 0) this.controllersByRun.delete(runId);
      },
    });
  }

  createWorkflowSseStream(workflowId: string): ReadableStream<Uint8Array> {
    let currentController: StreamController | null = null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        currentController = controller;
        try {
          controller.enqueue(this.encoder.encode(": stream-open\n\n"));
          const buf = this.workflowBuffer.get(workflowId);
          if (buf) {
            for (const evt of buf) controller.enqueue(this.encodeEvent(evt));
          }
        } catch {
          // ignore enqueue on aborted stream
        }
        const set = this.controllersByWorkflow.get(workflowId) ?? new Set<StreamController>();
        set.add(controller);
        this.controllersByWorkflow.set(workflowId, set);
        this.startHeartbeat(controller);
      },
      cancel: () => {
        if (!currentController) return;
        const set = this.controllersByWorkflow.get(workflowId);
        if (!set) return;
        set.delete(currentController);
        this.safeClose(currentController);
        if (set.size === 0) {
          this.controllersByWorkflow.delete(workflowId);
          this.workflowBuffer.delete(workflowId);
        }
      },
    });
  }

  publish(event: StepStreamEvent): void {
    const buf = this.getOrCreateBuffer(event.runId);
    buf.events.push(event);

    const data = this.encodeEvent(event);

    const set = this.controllersByRun.get(event.runId);
    if (set) {
      for (const controller of set) {
        try {
          controller.enqueue(data);
        } catch {
          // ignore broken stream
        }
      }
    }

    const wfBuf = this.workflowBuffer.get(event.workflowId) ?? [];
    wfBuf.push(event);
    if (wfBuf.length > WORKFLOW_BUFFER_CAP) wfBuf.splice(0, wfBuf.length - WORKFLOW_BUFFER_CAP);
    this.workflowBuffer.set(event.workflowId, wfBuf);

    const wfSet = this.controllersByWorkflow.get(event.workflowId);
    if (wfSet) {
      for (const controller of wfSet) {
        try {
          controller.enqueue(data);
        } catch {
          // ignore broken stream
        }
      }
    }

    const binding = getTurnBindingByWorkflow(event.workflowId);
    if (binding) {
      const clientEv = projectStepStreamToClientEvent(event, {
        sessionId: binding.sessionId,
        turnId: binding.turnId,
      });
      if (clientEv) clientEventBus.publish(clientEv);
    }
  }

  close(runId: string): void {
    const buf = this.getOrCreateBuffer(runId);
    if (buf.closedAt === null) {
      buf.closedAt = Date.now();
    }
    if (buf.cleanupTimer === null) {
      buf.cleanupTimer = setTimeout(() => {
        this.bufferByRun.delete(runId);
      }, BUFFER_TTL_MS);
    }

    const set = this.controllersByRun.get(runId);
    if (!set) return;
    for (const c of set) this.safeClose(c);
    this.controllersByRun.delete(runId);
  }
}

export const stepStreamBus = new StepStreamBus();

setStepStreamPorts({
  publish: (event) => {
    stepStreamBus.publish(event as never);
  },
});
