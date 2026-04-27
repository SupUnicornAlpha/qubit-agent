import type { StepStreamEvent } from "./state";

type StreamController = ReadableStreamDefaultController<Uint8Array>;

class StepStreamBus {
  private controllersByRun = new Map<string, Set<StreamController>>();
  private encoder = new TextEncoder();

  createSseStream(runId: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const set = this.controllersByRun.get(runId) ?? new Set<StreamController>();
        set.add(controller);
        this.controllersByRun.set(runId, set);
      },
      cancel: () => {
        const set = this.controllersByRun.get(runId);
        if (!set) return;
        for (const c of set) c.close();
        this.controllersByRun.delete(runId);
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
    for (const c of set) c.close();
    this.controllersByRun.delete(runId);
  }
}

export const stepStreamBus = new StepStreamBus();

