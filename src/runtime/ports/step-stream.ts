/**
 * Emitter port — tools publish step events without importing react/event-stream.
 * Wired at boot; lazy default binds the react bus on first use.
 */

export type StepStreamPublishEvent = {
  runId: string;
  workflowId: string;
  traceId: string;
  role: string;
  type: string;
  stepIndex: number;
  ts: number;
  payload: Record<string, unknown>;
};

export type StepStreamPorts = {
  publish: (event: StepStreamPublishEvent) => void;
};

let _ports: StepStreamPorts | null = null;

export function setStepStreamPorts(ports: StepStreamPorts): void {
  _ports = ports;
}

export function getStepStreamPorts(): StepStreamPorts {
  if (_ports) return _ports;
  const ports: StepStreamPorts = {
    publish(event) {
      void import("../react/event-stream")
        .then(({ stepStreamBus }) => {
          stepStreamBus.publish(event as never);
        })
        .catch((error) => {
          console.warn(
            `[step-stream-port] publish failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
    },
  };
  _ports = ports;
  return ports;
}
