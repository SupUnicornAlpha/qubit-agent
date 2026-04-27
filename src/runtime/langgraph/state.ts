import type { A2AMessageEnvelope } from "../../types/a2a";
import type { RuntimeAgentDefinition } from "../types";

export type StepEventType =
  | "token"
  | "tool_call_start"
  | "tool_call_end"
  | "observe"
  | "step_persisted"
  | "final"
  | "error";

export interface StepStreamEvent {
  runId: string;
  workflowId: string;
  traceId: string;
  role: string;
  type: StepEventType;
  stepIndex: number;
  ts: number;
  payload: Record<string, unknown>;
}

export interface AgentGraphState {
  runId: string;
  workflowId: string;
  traceId: string;
  agentDefinition: RuntimeAgentDefinition;
  inboundMessage: A2AMessageEnvelope;

  // runtime state
  iteration: number;
  contextMemory: Record<string, unknown>;
  plannedAction: string | null;
  reasonText: string | null;
  toolCalls: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;

  // output
  finalResponse: Record<string, unknown> | null;
  events: StepStreamEvent[];
}

export function createInitialGraphState(input: {
  runId: string;
  workflowId: string;
  traceId: string;
  agentDefinition: RuntimeAgentDefinition;
  inboundMessage: A2AMessageEnvelope;
}): AgentGraphState {
  return {
    runId: input.runId,
    workflowId: input.workflowId,
    traceId: input.traceId,
    agentDefinition: input.agentDefinition,
    inboundMessage: input.inboundMessage,
    iteration: 0,
    contextMemory: {},
    plannedAction: null,
    reasonText: null,
    toolCalls: [],
    observations: [],
    finalResponse: null,
    events: [],
  };
}

