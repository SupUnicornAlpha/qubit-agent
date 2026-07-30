/**
 * Turn ↔ Run 绑定：供 StepStream → ClientEvent 投影查找 sessionId/turnId。
 */

export interface TurnRunBinding {
  sessionId: string;
  turnId: string;
  workflowRunId: string;
  agentRunId?: string;
  turnMode?: string;
}

const byWorkflow = new Map<string, TurnRunBinding>();
const byTurn = new Map<string, TurnRunBinding>();

export function registerTurnRunBinding(binding: TurnRunBinding): void {
  byWorkflow.set(binding.workflowRunId, binding);
  byTurn.set(binding.turnId, binding);
}

export function getTurnBindingByWorkflow(workflowRunId: string): TurnRunBinding | undefined {
  return byWorkflow.get(workflowRunId);
}

export function getTurnBindingByTurn(turnId: string): TurnRunBinding | undefined {
  return byTurn.get(turnId);
}

export function clearTurnBindingForWorkflow(workflowRunId: string): void {
  const b = byWorkflow.get(workflowRunId);
  if (!b) return;
  byWorkflow.delete(workflowRunId);
  byTurn.delete(b.turnId);
}
