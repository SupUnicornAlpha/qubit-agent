/**
 * Prime CoreRuntime wire types (aligned with crates/qubit-protocol).
 * Bun side only — Rust is the source of truth for schemas.
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

/** Host-owned per-turn recall / context policy (`turn.start.context`). */
export interface TurnContextOpts {
  /** When false, skip auto memory.recall during assemble. Default true. */
  auto_recall?: boolean;
  /** Max hits kept per recall bucket after assembly. */
  recall_top_k?: number;
  include_finance_recall?: boolean;
  include_skill_recall?: boolean;
  include_general_recall?: boolean;
  /** Mark current user text authoritative; recall as optional background. */
  prioritize_current_goal?: boolean;
  /** Remove bootstrap memory/workspace tools from model surface after assemble. */
  strip_bootstrap_memory_tools?: boolean;
}

/** Defaults for Orchestrator chat turns — keep prior memory from dominating a new prompt. */
export const ORCHESTRATOR_TURN_CONTEXT: TurnContextOpts = {
  auto_recall: true,
  recall_top_k: 3,
  prioritize_current_goal: true,
  strip_bootstrap_memory_tools: true,
};

export interface AgentSpec {
  id: string;
  version: string;
  display_name: string;
  execution_kind: ExecutionKind;
  labels: string[];
  identity_prompt_ref: string;
  /** Full system prompt synced from agent_definition (Core prefers this over stub identity). */
  system_prompt?: string | null;
  default_recipe_id?: string | null;
  tool_surface_ref: string;
  model_ref?: string | null;
  max_iterations: number;
  hitl_profile_ref?: string | null;
  allowed_callers: Array<
    | { kind: "spec_id"; id: string }
    | { kind: "label"; label: string }
    | { kind: "execution_kind"; execution_kind: ExecutionKind }
  >;
  triggers: Array<
    | { kind: "queue"; topic: string; filter?: unknown }
    | { kind: "a2a"; capability: string }
    | { kind: "webhook"; path: string; secret_ref?: string }
    | { kind: "domain_event"; event_name: string }
    | { kind: "schedule"; cron: string }
  >;
  enabled: boolean;
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

export interface TurnView {
  turn_id: string;
  state: string;
  iteration: number;
  lifecycle?: string | null;
  delivery?: DeliveryVerdict | null;
  /** Final assistant text (set when turn completes). */
  answer_text?: string | null;
  /** Aggregated LLM usage (for Bun llm_call_log). */
  llm_stats?: {
    sample_count?: number;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
    latency_ms?: number | null;
    model?: string | null;
    provider?: string | null;
  } | null;
}

export interface SessionSnapshot {
  session: SessionView;
  active_turn?: TurnView | null;
  plan?: unknown;
  /** Core-internal agent.invoke ledger (RPC + L0 tool path). */
  invocations?: unknown[];
}

export interface RuntimeHealth {
  status: string;
  uptime_ms: number;
  active_turns: number;
  hitl_waiting: number;
  core_backend: string;
  degraded_reasons: string[];
}

export interface CoreRuntime {
  health(): Promise<RuntimeHealth>;
  listAgents(): Promise<{ agents: AgentSpec[] }>;
  upsertAgent(spec: AgentSpec): Promise<void>;
  createSession(req: {
    workspace_id?: string;
    agent_ref: string;
    interaction_mode?: InteractionMode;
    mode?: string;
  }): Promise<SessionView>;
  getSession(sessionId: string): Promise<SessionView>;
  setSessionMode?(req: {
    session_id: string;
    interaction_mode: InteractionMode;
  }): Promise<SessionView>;
  sessionSnapshot(sessionId: string): Promise<SessionSnapshot>;
  startTurn(req: {
    session_id: string;
    input: { text: string; attachments?: unknown[]; client_meta?: unknown };
    idempotency_key: string;
    /** Host-owned recall / context policy for this turn. */
    context?: TurnContextOpts;
  }): Promise<{ turn_id: string }>;
  cancelTurn(req: { session_id: string; turn_id: string }): Promise<void>;
  failTurn?(req: { session_id: string; turn_id: string }): Promise<void>;
  invokeAgent(req: Record<string, unknown>): Promise<Record<string, unknown>>;
  ingestTrigger(req: Record<string, unknown>): Promise<{ turn_id?: string | null }>;
  hitlRespond(req: {
    inbox_id: string;
    approved: boolean;
    selected_option_ids?: string[];
    free_form?: string;
    client_meta?: unknown;
  }): Promise<void>;
  hitlInboxList(req?: {
    workspace_id?: string;
    session_id?: string;
    pending_only?: boolean;
  }): Promise<
    Array<{
      inbox_id: string;
      turn_id: string;
      session_id: string;
      status: string;
      prompt?: { title?: string; body?: string };
    }>
  >;
}

export const PRIME_RPC = {
  RUNTIME_HEALTH: "runtime.health",
  SESSION_CREATE: "session.create",
  SESSION_GET: "session.get",
  SESSION_SET_MODE: "session.set_mode",
  SESSION_SNAPSHOT: "session.snapshot",
  TURN_START: "turn.start",
  TURN_CANCEL: "turn.cancel",
  TURN_FAIL: "turn.fail",
  AGENT_LIST: "agent.list",
  AGENT_UPSERT: "agent.upsert",
  AGENT_INVOKE: "agent.invoke",
  TRIGGER_INGEST: "trigger.ingest",
  HITL_RESPOND: "hitl.respond",
  HITL_INBOX_LIST: "hitl.inbox.list",
  EVENTS_SUBSCRIBE: "events.subscribe",
} as const;

/** Thin transport paths on qubit-app-server (O1). */
export { PRIME_TRANSPORT } from "@qubit/protocol-ts";
export type { RuntimeEvent as PrimeRuntimeEvent } from "@qubit/protocol-ts";
