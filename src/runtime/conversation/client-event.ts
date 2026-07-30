/**
 * 统一客户端事件（docs/agent-contracts/06-session-turn-protocol.md §5）
 * 由 stepStream / HITL / turn 生命周期投影；version=1。
 */

export const CLIENT_EVENT_VERSION = 1 as const;

export type ClientEventType =
  | "turn.started"
  | "item.delta"
  | "item.completed"
  | "approval.requested"
  | "turn.completed"
  | "turn.failed";

export interface ClientEventItem {
  id: string;
  kind: string;
  payload: unknown;
}

export interface ClientEvent {
  version: typeof CLIENT_EVENT_VERSION;
  sessionId: string;
  turnId: string;
  /** primary Run = workflowRunId */
  runId: string;
  type: ClientEventType;
  item?: ClientEventItem;
  ts: number;
}

export function makeClientEvent(
  partial: Omit<ClientEvent, "version" | "ts"> & { ts?: number }
): ClientEvent {
  return {
    version: CLIENT_EVENT_VERSION,
    sessionId: partial.sessionId,
    turnId: partial.turnId,
    runId: partial.runId,
    type: partial.type,
    ...(partial.item ? { item: partial.item } : {}),
    ts: partial.ts ?? Date.now(),
  };
}
