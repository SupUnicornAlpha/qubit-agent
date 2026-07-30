import type { StepStreamEvent } from "./state";

type StreamController = ReadableStreamDefaultController<Uint8Array>;

/** How long (ms) to keep buffered events after the run is closed, for late subscribers. */
const BUFFER_TTL_MS = 120_000; // 2 minutes

/**
 * SSE 心跳间隔。Bun.serve idleTimeout 上限 255s；这里取一个明显小于它的值
 * （25s），保证：
 *   - 即使后端 LLM 推理长时间无 token 输出（reason 节点跑 60s+ 完全正常），
 *     连接也不会被 Bun 或上游代理判定为 idle。
 *   - 发送的是 SSE 注释行 `: hb\n\n`，EventSource 客户端按规范会直接忽略，
 *     不会冒充成 event。
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
 *
 * 研究团队一个 workflow 下有多个 agent run，每个 run 高频吐 token；这里不按 run 全量缓存
 * （那有 per-run buffer 兜底），只为 workflow 订阅者保留最近 N 条做"刚连上时的补帧"，
 * 满了丢最旧，避免长跑团队把内存撑爆。
 */
const WORKFLOW_BUFFER_CAP = 400;

class StepStreamBus {
  private controllersByRun = new Map<string, Set<StreamController>>();
  /** Per-run event ring buffer for late-joining SSE subscribers. */
  private bufferByRun = new Map<string, RunBuffer>();
  /**
   * Workflow 级订阅者：把同一 workflowId 下所有 run 的事件 fan-in 到一条 SSE，
   * 供研究团队页"逐字看 Orchestrator/各 agent 输出"用（事件自带 role 供前端路由）。
   */
  private controllersByWorkflow = new Map<string, Set<StreamController>>();
  private workflowBuffer = new Map<string, StepStreamEvent[]>();
  /** 每个 controller 的 heartbeat timer，用于 cancel / close 时清理。 */
  private heartbeatByController = new WeakMap<StreamController, ReturnType<typeof setInterval>>();
  private encoder = new TextEncoder();

  private safeClose(controller: StreamController): void {
    /** 关连接前先把 heartbeat timer 停掉，避免 timer leak / 触发 enqueue-on-closed */
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

  /**
   * 每 SSE_HEARTBEAT_MS 给 controller 推一行 SSE 注释；客户端 EventSource 会忽略，
   * 但 Bun 和上游代理认为连接还活着 → 不会触发 idleTimeout 切断。
   */
  private startHeartbeat(controller: StreamController): void {
    const timer = setInterval(() => {
      try {
        controller.enqueue(this.encoder.encode(`: hb ${Date.now()}\n\n`));
      } catch {
        /** stream 已被对端关闭：直接停 timer，下一轮 enqueue 也跑不动 */
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
          // Replay all buffered events so late subscribers catch up.
          if (buf) {
            for (const evt of buf.events) {
              controller.enqueue(this.encodeEvent(evt));
            }
            // If the run already finished, close the stream immediately after replay.
            if (buf.closedAt !== null) {
              this.safeClose(controller);
              return;
            }
          }
        } catch {
          // ignore enqueue on aborted stream
        }
        // Register for future events.
        const set = this.controllersByRun.get(runId) ?? new Set<StreamController>();
        set.add(controller);
        this.controllersByRun.set(runId, set);
        /** 启动 heartbeat：让连接绝不触达 Bun.serve idleTimeout 上限 */
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

  /**
   * Workflow 级 firehose：订阅某 workflowId 下所有 run 的事件（跨 agent）。
   * 与 createSseStream(runId) 平行；前端按 event.role/runId 自行路由到对应 agent 气泡。
   * 不随单个 run close 而关闭——团队多 run 期间保持常驻，由客户端断开 / 心跳兜底。
   */
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
          // 无人订阅即释放 late-join 缓冲，避免 workflowBuffer Map 随历史 workflow 无界增长。
          this.workflowBuffer.delete(workflowId);
        }
      },
    });
  }

  publish(event: StepStreamEvent): void {
    // Buffer for late subscribers.
    const buf = this.getOrCreateBuffer(event.runId);
    buf.events.push(event);

    const data = this.encodeEvent(event);

    // Forward to per-run subscribers.
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

    // Fan-in to workflow-level subscribers + capped late-join buffer.
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
  }

  close(runId: string): void {
    // Mark buffer as closed so late subscribers get an immediate EOF after replay.
    const buf = this.getOrCreateBuffer(runId);
    if (buf.closedAt === null) {
      buf.closedAt = Date.now();
    }
    // Schedule cleanup.
    if (buf.cleanupTimer === null) {
      buf.cleanupTimer = setTimeout(() => {
        this.bufferByRun.delete(runId);
      }, BUFFER_TTL_MS);
    }

    // Close active subscribers.
    const set = this.controllersByRun.get(runId);
    if (!set) return;
    for (const c of set) this.safeClose(c);
    this.controllersByRun.delete(runId);
  }
}

export const stepStreamBus = new StepStreamBus();

