import type { A2AMessageEnvelope } from "../../types/a2a";
import type { RuntimeAgentDefinition } from "../types";

export type StepEventType =
  | "token"
  | "tool_call_start"
  | "tool_call_end"
  | "observe"
  | "step_persisted"
  | "hitl_request"
  | "final"
  | "error"
  // Coding-Agent 体验改造（docs/CODING_AGENT_EXPERIENCE_DESIGN.md P1）：
  // plan = 编排器对用户可见的分步计划/TODO 快照；tool_rationale = 调用工具前的「为何调/预期」。
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
  loopKind?: import("../../types/loop").AgentLoopKind;
  source?: "native" | "cli" | "a2a";
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

  /**
   * P2 优先级（Round 7 复盘 2026-06-08）：artifact gate 已 push back 多少次。
   *
   * 当 LLM 输出 `{"tool":"none"}` 想停机但 scenario 的 requiredArtifacts 还没满足，
   * act 节点会阻止 finalResponse 写入并把 hint 塞进 observation，让 graph 回 reason
   * 再跑一轮。为防死循环，最多 push back 2 次；超过就放行（写 finalResponse），让评测
   * 真实记录"未落库 → A-1=0"，而不是把工作流卡死。
   *
   * undefined / 0 = 还没触发过；max 2（详见 act.ts MAX_ARTIFACT_GATE_RETRIES）。
   */
  artifactGapRetryCount?: number;
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
