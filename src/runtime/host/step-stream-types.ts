/**
 * Bun Host step-stream event types.
 *
 * These are **not** a TS Agent Core. Rust Core owns the turn loop; the Host
 * publishes/observes SSE frames for IDE / Team UI / CLI drivers.
 */

import type { AgentLoopKind } from "../../types/loop";

export type StepEventType =
  | "token"
  /** 供应商隐藏思考增量（reasoning_content 等）；不进正文，仅 UI 虚框 */
  | "reasoning_token"
  | "tool_call_start"
  | "tool_call_end"
  | "observe"
  | "step_persisted"
  | "hitl_request"
  | "final"
  | "error"
  | "plan"
  | "tool_rationale";

export interface StepStreamEvent {
  runId: string;
  workflowId: string;
  traceId: string;
  role: string;
  type: StepEventType;
  stepIndex: number;
  ts: number;
  payload: Record<string, unknown>;
  /** When set, identifies which agent loop produced this frame (native vs external CLI). */
  loopKind?: AgentLoopKind;
  source?: "native" | "cli" | "a2a";
}
