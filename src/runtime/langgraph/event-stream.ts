import type { StepStreamEvent } from "./state";

type StreamController = ReadableStreamDefaultController<Uint8Array>;

class StepStreamBus {
  private controllersByRun = new Map<string, Set<StreamController>>();
  private encoder = new TextEncoder();

  private safeClose(controller: StreamController): void {
    try {
      controller.close();
    } catch {
      // Ignore already-closed stream errors.
    }
  }

  createSseStream(runId: string): ReadableStream<Uint8Array> {
    let currentController: StreamController | null = null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        currentController = controller;
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
    const set = this.controllersByRun.get(event.runId);
    if (!set) return;
    const data = this.encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const controller of set) {
      try {
        controller.enqueue(data);
      } catch {
        // ignore broken stream
      }
    }
  }

  close(runId: string): void {
    const set = this.controllersByRun.get(runId);
    if (!set) return;
    for (const c of set) this.safeClose(c);
    this.controllersByRun.delete(runId);
  }
}

export const stepStreamBus = new StepStreamBus();

