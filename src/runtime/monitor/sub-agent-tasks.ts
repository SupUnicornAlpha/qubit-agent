export type SubAgentTaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface SubAgentTaskRecord {
  id: string;
  source: "a2a_assignment" | "agent_execution";
  taskId: string | null;
  taskType: string | null;
  traceId: string | null;
  projectId: string;
  sessionId: string | null;
  sessionTitle: string | null;
  workflowRunId: string;
  workflowGoal: string;
  workflowStatus: string;
  instanceId: string;
  agentRole: string;
  agentName: string;
  parentInstanceId: string | null;
  parentAgentRole: string | null;
  parentAgentName: string | null;
  a2aContext: string | null;
  status: SubAgentTaskStatus;
  title: string;
  summary: string | null;
  currentIteration: number;
  stepCount: number;
  latestPhase: string | null;
  latestStepAt: string | null;
  assignedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface SubAgentTaskWorkflowRow {
  id: string;
  projectId: string;
  sessionId: string | null;
  goal: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

export interface SubAgentTaskInstanceRow {
  id: string;
  definitionId: string;
  workflowRunId: string;
  status: string;
  currentIteration: number;
  startedAt: string | null;
  endedAt: string | null;
  errorMessage: string | null;
}

export interface SubAgentTaskDefinitionRow {
  id: string;
  role: string;
  name: string;
}

export interface SubAgentTaskMessageRow {
  id: string;
  workflowRunId: string;
  traceId: string;
  senderInstanceId: string;
  receiverInstanceId: string | null;
  messageType: string;
  payloadJson: unknown;
  createdAt: string;
}

export interface SubAgentTaskStepRow {
  agentInstanceId: string;
  workflowRunId: string;
  phase: string;
  stepIndex: number;
  createdAt: string;
}

type BuildSubAgentTasksInput = {
  workflows: SubAgentTaskWorkflowRow[];
  instances: SubAgentTaskInstanceRow[];
  definitions: SubAgentTaskDefinitionRow[];
  messages: SubAgentTaskMessageRow[];
  steps: SubAgentTaskStepRow[];
  sessionTitles?: Map<string, string>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function clipped(value: string | null, limit = 180): string | null {
  if (!value) return null;
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function resolveTitle(
  payload: Record<string, unknown>,
  agentName: string,
  taskType: string | null
): { title: string; summary: string | null } {
  const params = asRecord(payload.params);
  const goal = asText(params.goal);
  const message = asText(params.message);
  const context = asText(params.context);
  const ticker = asText(params.ticker);
  const title =
    clipped(goal, 120) ??
    clipped(message, 120) ??
    (ticker ? `${agentName} · ${ticker}` : null) ??
    `${agentName} · ${taskType || "agent task"}`;
  const summaryCandidate =
    goal && goal !== title ? goal : message && message !== title ? message : context;
  return { title, summary: clipped(summaryCandidate, 220) };
}

function resolveStatus(input: {
  workflowStatus: string;
  instanceStatus: string;
  instanceEndedAt: string | null;
  resultPayload: Record<string, unknown> | undefined;
}): SubAgentTaskStatus {
  if (input.resultPayload) {
    return input.resultPayload.success === false ? "failed" : "completed";
  }
  if (input.instanceStatus === "error" || input.workflowStatus === "failed") return "failed";
  if (input.workflowStatus === "cancelled") return "cancelled";
  if (input.workflowStatus === "awaiting_approval") return "waiting";
  if (
    input.instanceStatus === "stopped" ||
    input.instanceEndedAt ||
    input.workflowStatus === "completed"
  ) {
    return "completed";
  }
  if (input.instanceStatus === "running" || input.workflowStatus === "running") return "running";
  return "pending";
}

function resultError(payload?: Record<string, unknown>): string | null {
  if (!payload || payload.success !== false) return null;
  return clipped(asText(payload.errorMessage), 500);
}

/**
 * 把项目内 A2A 委派和普通 Agent 实例收敛成简洁模式的“任务”。
 *
 * A2A 委派优先：Agent pool 的 receiver 实例可能不属于当前 workflow，不能只按
 * agent_instance.workflow_run_id 关联。没有 TASK_ASSIGN 的本地/团队实例再作为兜底补入。
 */
export function buildSubAgentTasks(input: BuildSubAgentTasksInput): SubAgentTaskRecord[] {
  const workflowById = new Map(input.workflows.map((row) => [row.id, row]));
  const definitionById = new Map(input.definitions.map((row) => [row.id, row]));
  const instanceById = new Map(input.instances.map((row) => [row.id, row]));
  const taskResultByKey = new Map<string, SubAgentTaskMessageRow>();
  const stepsByExecution = new Map<string, { count: number; latest: SubAgentTaskStepRow | null }>();

  for (const step of input.steps) {
    const key = `${step.workflowRunId}:${step.agentInstanceId}`;
    const current = stepsByExecution.get(key) ?? { count: 0, latest: null };
    current.count += 1;
    if (!current.latest || step.createdAt > current.latest.createdAt) current.latest = step;
    stepsByExecution.set(key, current);
  }

  for (const message of input.messages) {
    if (message.messageType !== "TASK_RESULT") continue;
    const payload = asRecord(message.payloadJson);
    const taskId = asText(payload.taskId);
    if (!taskId) continue;
    const key = `${message.workflowRunId}:${message.senderInstanceId}:${taskId}`;
    const previous = taskResultByKey.get(key);
    if (!previous || message.createdAt > previous.createdAt) taskResultByKey.set(key, message);
  }

  const records: SubAgentTaskRecord[] = [];
  const assignedExecutionKeys = new Set<string>();
  const assignments = input.messages
    .filter((message) => message.messageType === "TASK_ASSIGN" && message.receiverInstanceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  for (const assignment of assignments) {
    const workflow = workflowById.get(assignment.workflowRunId);
    const instance = assignment.receiverInstanceId
      ? instanceById.get(assignment.receiverInstanceId)
      : undefined;
    const definition = instance ? definitionById.get(instance.definitionId) : undefined;
    if (!workflow || !instance || !definition || definition.role === "orchestrator") continue;

    const payload = asRecord(assignment.payloadJson);
    const taskId = asText(payload.taskId);
    const taskType = asText(payload.taskType);
    const result =
      taskId !== null ? taskResultByKey.get(`${workflow.id}:${instance.id}:${taskId}`) : undefined;
    const resultPayload = result ? asRecord(result.payloadJson) : undefined;
    const stepStats = stepsByExecution.get(`${workflow.id}:${instance.id}`);
    const copy = resolveTitle(payload, definition.name, taskType);
    const parentInstance = instanceById.get(assignment.senderInstanceId);
    const parentDefinition = parentInstance
      ? definitionById.get(parentInstance.definitionId)
      : undefined;
    const params = asRecord(payload.params);
    assignedExecutionKeys.add(`${workflow.id}:${instance.id}`);

    records.push({
      id: assignment.id,
      source: "a2a_assignment",
      taskId,
      taskType,
      traceId: assignment.traceId,
      projectId: workflow.projectId,
      sessionId: workflow.sessionId,
      sessionTitle: workflow.sessionId
        ? (input.sessionTitles?.get(workflow.sessionId) ?? null)
        : null,
      workflowRunId: workflow.id,
      workflowGoal: workflow.goal,
      workflowStatus: workflow.status,
      instanceId: instance.id,
      agentRole: definition.role,
      agentName: definition.name,
      parentInstanceId: parentInstance?.id ?? assignment.senderInstanceId,
      parentAgentRole: parentDefinition?.role ?? null,
      parentAgentName: parentDefinition?.name ?? null,
      a2aContext: clipped(asText(params.context), 500),
      status: resolveStatus({
        workflowStatus: workflow.status,
        instanceStatus: instance.status,
        instanceEndedAt: instance.endedAt,
        resultPayload,
      }),
      title: copy.title,
      summary: copy.summary,
      currentIteration: instance.currentIteration,
      stepCount: stepStats?.count ?? 0,
      latestPhase: stepStats?.latest?.phase ?? null,
      latestStepAt: stepStats?.latest?.createdAt ?? null,
      assignedAt: assignment.createdAt,
      completedAt: result?.createdAt ?? instance.endedAt ?? workflow.endedAt,
      errorMessage: resultError(resultPayload) ?? clipped(instance.errorMessage, 500),
    });
  }

  for (const instance of input.instances) {
    const workflow = workflowById.get(instance.workflowRunId);
    const definition = definitionById.get(instance.definitionId);
    if (!workflow || !definition || definition.role === "orchestrator") continue;
    const executionKey = `${workflow.id}:${instance.id}`;
    if (assignedExecutionKeys.has(executionKey)) continue;
    const stepStats = stepsByExecution.get(executionKey);

    records.push({
      id: `agent:${workflow.id}:${instance.id}`,
      source: "agent_execution",
      taskId: null,
      taskType: null,
      traceId: null,
      projectId: workflow.projectId,
      sessionId: workflow.sessionId,
      sessionTitle: workflow.sessionId
        ? (input.sessionTitles?.get(workflow.sessionId) ?? null)
        : null,
      workflowRunId: workflow.id,
      workflowGoal: workflow.goal,
      workflowStatus: workflow.status,
      instanceId: instance.id,
      agentRole: definition.role,
      agentName: definition.name,
      parentInstanceId: null,
      parentAgentRole: null,
      parentAgentName: null,
      a2aContext: null,
      status: resolveStatus({
        workflowStatus: workflow.status,
        instanceStatus: instance.status,
        instanceEndedAt: instance.endedAt,
        resultPayload: undefined,
      }),
      title: `${definition.name} · ${clipped(workflow.goal, 120) ?? "agent task"}`,
      summary: null,
      currentIteration: instance.currentIteration,
      stepCount: stepStats?.count ?? 0,
      latestPhase: stepStats?.latest?.phase ?? null,
      latestStepAt: stepStats?.latest?.createdAt ?? null,
      assignedAt: instance.startedAt ?? workflow.startedAt,
      completedAt: instance.endedAt ?? workflow.endedAt,
      errorMessage: clipped(instance.errorMessage, 500),
    });
  }

  return records.sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
}
