import type { StepStreamEvent } from "./state";

type StreamController = ReadableStreamDefaultController<Uint8Array>;

/** How long (ms) to keep buffered events after the run is closed, for late subscribers. */
const BUFFER_TTL_MS = 120_000; // 2 minutes

interface RunBuffer {
  events: StepStreamEvent[];
  /** null = still running; number = timestamp when close() was called */
  closedAt: number | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

class StepStreamBus {
  private controllersByRun = new Map<string, Set<StreamController>>();
  /** Per-run event ring buffer for late-joining SSE subscribers. */
  private bufferByRun = new Map<string, RunBuffer>();
  private encoder = new TextEncoder();

  private safeClose(controller: StreamController): void {
    try {
      controller.close();
    } catch {
      // Ignore already-closed stream errors.
    }
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

  publish(event: StepStreamEvent): void {
    // Buffer for late subscribers.
    const buf = this.getOrCreateBuffer(event.runId);
    buf.events.push(event);

    // Forward to active subscribers.
    const set = this.controllersByRun.get(event.runId);
    if (!set) return;
    const data = this.encodeEvent(event);
    for (const controller of set) {
      try {
        controller.enqueue(data);
      } catch {
        // ignore broken stream
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

