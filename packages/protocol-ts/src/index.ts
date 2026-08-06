/**
 * @qubit/protocol-ts — wire types aligned with crates/qubit-protocol schemas.
 *
 * Source of truth: `crates/qubit-protocol/schemas/*.schema.json`
 * Regenerate schemas: `cargo run -p qubit-protocol --example export_schemas`
 *
 * This package stays thin: hand-synced subset used by Bun/UI. Full codegen
 * (json-schema-to-typescript) can replace this file later without touching Core.
 */

export type ExecutionKind = "primary" | "subagent" | "reactor";
export type InteractionMode = "agent" | "plan" | "goal" | "ask" | "diagnose";

export type DeliveryStatus =
  | "delivered"
  | "delivered_with_gaps"
  | "partial"
  | "failed"
  | "cancelled";

export interface DeliveryVerdict {
  status: DeliveryStatus;
  reasons: string[];
}

export type Lifecycle =
  | "accepted"
  | "running"
  | "awaiting_hitl"
  | "completed"
  | "failed"
  | "cancelled";

export interface TurnLlmStats {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  latency_ms?: number | null;
  model?: string | null;
  provider?: string | null;
}

export interface TurnView {
  turn_id: string;
  state: string;
  iteration: number;
  lifecycle?: Lifecycle | null;
  delivery?: DeliveryVerdict | null;
  answer_text?: string | null;
  llm_stats?: TurnLlmStats | null;
}

export interface SessionView {
  session_id: string;
  workspace_id: string;
  agent_instance_id: string;
  agent_spec_id: string;
  execution_kind: ExecutionKind;
  interaction_mode: InteractionMode;
  status: string;
  created_at_ms: number;
  updated_at_ms: number;
  event_seq: number;
}

export interface SessionSnapshot {
  session: SessionView;
  active_turn?: TurnView | null;
  plan?: unknown;
  invocations?: unknown[];
}

export interface AgentSpec {
  id: string;
  version: string;
  display_name: string;
  execution_kind: ExecutionKind;
  labels: string[];
  identity_prompt_ref: string;
  system_prompt?: string | null;
  default_recipe_id?: string | null;
  tool_surface_ref: string;
  model_ref?: string | null;
  max_iterations: number;
  hitl_profile_ref?: string | null;
  allowed_callers: unknown[];
  triggers: unknown[];
  enabled: boolean;
}

export interface RuntimeHealth {
  status: string;
  uptime_ms: number;
  active_turns: number;
  hitl_waiting: number;
  core_backend: string;
  degraded_reasons: string[];
  llm_model?: string | null;
  llm_base_url?: string | null;
  has_llm_key?: boolean;
}

/** RuntimeEvent wire shape (tag = type, snake_case). */
export type RuntimeEvent =
  | { type: "turn_started"; turn_id: string; seq: number; ts: number }
  | { type: "token"; turn_id: string; iteration: number; text: string; seq: number }
  | {
      type: "reasoning_token";
      turn_id: string;
      iteration: number;
      text: string;
      seq: number;
    }
  | {
      type: "tool_started";
      turn_id: string;
      call_id: string;
      name: string;
      args: unknown;
      seq: number;
    }
  | {
      type: "tool_finished";
      turn_id: string;
      call_id: string;
      ok: boolean;
      observation_ref: string;
      seq: number;
    }
  | { type: "hitl_requested"; prompt: unknown; inbox_id: string; seq: number }
  | { type: "plan_updated"; turn_id: string; plan: unknown; seq: number }
  | {
      type: "turn_completed";
      turn_id: string;
      lifecycle: Lifecycle;
      delivery: DeliveryVerdict;
      seq: number;
    }
  | {
      type: "turn_failed";
      turn_id: string;
      error: { code: string; message: string; data?: unknown };
      seq: number;
    }
  | { type: "runtime_degraded"; reason: string; seq: number };

export const PROTOCOL_SCHEMA_MANIFEST = "../../crates/qubit-protocol/schemas/manifest.json";

export const PRIME_TRANSPORT = {
  RPC: "/rpc",
  HEALTH: "/health",
  /** SSE RuntimeEvent stream (O1). Optional query: turn_id. Thin — no WS deps in Core. */
  EVENTS: "/events",
} as const;
