/**
 * Bun Host layer — external capabilities beside Rust Core.
 *
 * NOT a second Agent runtime. Core owns turns / HITL / delivery.
 * Host owns SSE projection, checkpoint row cleanup, tool-error taxonomy, bridges.
 */

export {
  deleteCheckpointSnapshotsForWorkflow,
  loadLatestCheckpointSnapshot,
  loadLatestSnapshotByRunId,
  type LoadedSnapshot,
} from "./checkpoint-snapshot";
export { stepStreamBus, type StepEventType, type StepStreamEvent } from "./event-stream";
export {
  buildMcpRetryHint,
  classifyToolError,
  type ToolErrorClass,
} from "./tool-error-classifier";
