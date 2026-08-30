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

/**
 * Host domain routes for external capabilities and platform services.
 * Existing direct exports above remain stable for compatibility.
 */
export * as autoInstaller from "./auto-installer";
export * as bootstrap from "./bootstrap";
export * as config from "./config";
export * as environment from "./environment";
export * as exec from "./exec";
export * as externalCall from "./external-call";
export * as fsi from "./fsi";
export * as heartbeat from "./heartbeat";
export * as integrations from "./integrations";
export * as llm from "./llm";
export * as market from "./market";
export * as mcp from "./mcp";
export * as plugins from "./plugins";
export * as ports from "./ports";
export * as prime from "./prime";
export * as provider from "./provider";
export * as sandbox from "./sandbox";
export * as workspace from "./workspace";
export * as util from "./util";
export * as researchTeam from "./research-team";
