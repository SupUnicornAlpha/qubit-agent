type DebateStreamController = ReadableStreamDefaultController<Uint8Array>;

export interface DebateStreamEvent {
  workflowRunId: string;
  sessionId: string;
  type: "debate_start" | "debate_turn" | "debate_verdict" | "debate_end";
  ts: number;
  payload: Record<string, unknown>;
}

class DebateStreamBus {
  private controllersByWorkflow = new Map<string, Set<DebateStreamController>>();
  private encoder = new TextEncoder();

  createSseStream(workflowRunId: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const set = this.controllersByWorkflow.get(workflowRunId) ?? new Set<DebateStreamController>();
        set.add(controller);
        this.controllersByWorkflow.set(workflowRunId, set);
      },
      cancel: () => {
        const set = this.controllersByWorkflow.get(workflowRunId);
        if (!set) return;
        for (const c of set) c.close();
        this.controllersByWorkflow.delete(workflowRunId);
      },
    });
  }

  publish(event: DebateStreamEvent): void {
    const set = this.controllersByWorkflow.get(event.workflowRunId);
    if (!set) return;
    const data = this.encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const c of set) {
      try {
        c.enqueue(data);
      } catch {
        // ignore broken stream
      }
    }
  }

  close(workflowRunId: string): void {
    const set = this.controllersByWorkflow.get(workflowRunId);
    if (!set) return;
    for (const c of set) c.close();
    this.controllersByWorkflow.delete(workflowRunId);
  }
}

export const debateStreamBus = new DebateStreamBus();
