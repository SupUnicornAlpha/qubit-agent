export type SubAgentTaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface SubAgentTaskRecord {
  id: string;
  source: "workflow" | "a2a_assignment" | "agent_execution";
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
  preferInstanceTerminal?: boolean;
}): SubAgentTaskStatus {
  if (input.resultPayload) {
    return input.resultPayload.success === false ? "failed" : "completed";
  }
  if (input.preferInstanceTerminal) {
    if (input.instanceStatus === "error") return "failed";
    if (input.instanceStatus === "stopped" || input.instanceEndedAt) return "completed";
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
  const result = asRecord(payload.result);
  const reason = asText(result.reason);
  const usedTokens = Number(result.usedTokens);
  const maxTotalTokens = Number(result.maxTotalTokens);
  const budgetDetail =
    reason === "token_budget_exhausted" &&
    Number.isFinite(usedTokens) &&
    Number.isFinite(maxTotalTokens)
      ? `Token 预算耗尽（本轮任务树已使用 ${usedTokens} / ${maxTotalTokens}）`
      : null;
  return clipped(
    asText(payload.errorMessage) ??
      asText(result.errorMessage) ??
      asText(result.error) ??
      asText(result.message) ??
      budgetDetail ??
      reason,
    500
  );
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
  const workflowFailureById = new Map<
    string,
    { createdAt: string; payload: Record<string, unknown> }
  >();
  const stepsByExecution = new Map<string, { count: number; latest: SubAgentTaskStepRow | null }>();
  const executionInstancesByDefinition = new Map<string, SubAgentTaskInstanceRow[]>();

  for (const instance of input.instances) {
    const key = `${instance.workflowRunId}:${instance.definitionId}`;
    const bucket = executionInstancesByDefinition.get(key) ?? [];
    bucket.push(instance);
    executionInstancesByDefinition.set(key, bucket);
  }

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

    const sender = instanceById.get(message.senderInstanceId);
    const senderDefinition = sender ? definitionById.get(sender.definitionId) : undefined;
    if (senderDefinition?.role === "orchestrator" && payload.success === false) {
      const previousFailure = workflowFailureById.get(message.workflowRunId);
      if (!previousFailure || message.createdAt > previousFailure.createdAt) {
        workflowFailureById.set(message.workflowRunId, {
          createdAt: message.createdAt,
          payload,
        });
      }
    }
  }

  const records: SubAgentTaskRecord[] = [];
  const assignedExecutionKeys = new Set<string>();
  const orchestratorByWorkflow = new Map<
    string,
    { instance: SubAgentTaskInstanceRow; definition: SubAgentTaskDefinitionRow }
  >();

  for (const instance of input.instances) {
    const definition = definitionById.get(instance.definitionId);
    if (!definition || definition.role !== "orchestrator") continue;
    const previous = orchestratorByWorkflow.get(instance.workflowRunId);
    const currentStartedAt = instance.startedAt ?? "";
    const previousStartedAt = previous?.instance.startedAt ?? "";
    if (!previous || currentStartedAt >= previousStartedAt) {
      orchestratorByWorkflow.set(instance.workflowRunId, { instance, definition });
    }
  }

  // 简洁模式的“任务”首先是 workflow 主任务，而不只是被委派的子 Agent。
  // 即使一个对话只运行了 Orchestrator，也必须能从任务页找到并回到对应对话。
  for (const workflow of input.workflows) {
    const orchestrator = orchestratorByWorkflow.get(workflow.id);
    const instance = orchestrator?.instance;
    const definition = orchestrator?.definition;
    const stepStats = instance ? stepsByExecution.get(`${workflow.id}:${instance.id}`) : undefined;

    records.push({
      id: `workflow:${workflow.id}`,
      source: "workflow",
      taskId: null,
      taskType: "workflow",
      traceId: null,
      projectId: workflow.projectId,
      sessionId: workflow.sessionId,
      sessionTitle: workflow.sessionId
        ? (input.sessionTitles?.get(workflow.sessionId) ?? null)
        : null,
      workflowRunId: workflow.id,
      workflowGoal: workflow.goal,
      workflowStatus: workflow.status,
      instanceId: instance?.id ?? "",
      agentRole: definition?.role ?? "orchestrator",
      agentName: definition?.name ?? "Orchestrator",
      parentInstanceId: null,
      parentAgentRole: null,
      parentAgentName: null,
      a2aContext: null,
      status: resolveStatus({
        workflowStatus: workflow.status,
        instanceStatus: instance?.status ?? workflow.status,
        instanceEndedAt: instance?.endedAt ?? workflow.endedAt,
        resultPayload: undefined,
      }),
      title: workflow.goal,
      summary: null,
      currentIteration: instance?.currentIteration ?? 0,
      stepCount: stepStats?.count ?? 0,
      latestPhase: stepStats?.latest?.phase ?? null,
      latestStepAt: stepStats?.latest?.createdAt ?? null,
      assignedAt: workflow.startedAt,
      completedAt: workflow.endedAt ?? instance?.endedAt ?? null,
      errorMessage:
        resultError(workflowFailureById.get(workflow.id)?.payload) ??
        clipped(instance?.errorMessage ?? null, 500),
    });
  }

  const assignments = input.messages
    .filter((message) => message.messageType === "TASK_ASSIGN" && message.receiverInstanceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const assignedDefinitionKeys = new Set<string>();

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
    /**
     * TASK_ASSIGN 指向常驻 pool instance，executeAgentReact 则为这次调用创建 workflow
     * 内的 execution instance。用 definition + 启动时间把两者配对，任务卡片才能展示
     * 真实步骤数，又不把 execution instance 作为第二条重复任务暴露出来。
     */
    const assignmentTime = Date.parse(assignment.createdAt);
    const executionInstance = (
      executionInstancesByDefinition.get(`${workflow.id}:${definition.id}`) ?? []
    )
      .filter((candidate) => candidate.id !== instance.id && candidate.startedAt)
      .map((candidate) => ({
        candidate,
        distance: Math.abs(Date.parse(candidate.startedAt ?? "") - assignmentTime),
      }))
      .filter((entry) => Number.isFinite(entry.distance) && entry.distance <= 5_000)
      .sort((a, b) => a.distance - b.distance)[0]?.candidate;
    const stepInstance = executionInstance ?? instance;
    const stepStats = stepsByExecution.get(`${workflow.id}:${stepInstance.id}`);
    const copy = resolveTitle(payload, definition.name, taskType);
    const parentInstance = instanceById.get(assignment.senderInstanceId);
    const parentDefinition = parentInstance
      ? definitionById.get(parentInstance.definitionId)
      : undefined;
    const params = asRecord(payload.params);
    assignedExecutionKeys.add(`${workflow.id}:${instance.id}`);
    assignedDefinitionKeys.add(`${workflow.id}:${definition.id}`);

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
      currentIteration: stepInstance.currentIteration,
      stepCount: stepStats?.count ?? 0,
      latestPhase: stepStats?.latest?.phase ?? null,
      latestStepAt: stepStats?.latest?.createdAt ?? null,
      assignedAt: assignment.createdAt,
      completedAt:
        result?.createdAt ?? executionInstance?.endedAt ?? instance.endedAt ?? workflow.endedAt,
      errorMessage:
        resultError(resultPayload) ??
        clipped(executionInstance?.errorMessage ?? instance.errorMessage, 500),
    });
  }

  for (const instance of input.instances) {
    const workflow = workflowById.get(instance.workflowRunId);
    const definition = definitionById.get(instance.definitionId);
    if (!workflow || !definition || definition.role === "orchestrator") continue;
    const executionKey = `${workflow.id}:${instance.id}`;
    if (assignedExecutionKeys.has(executionKey)) continue;
    // A2A handler 会为一次 TASK_ASSIGN 创建独立 execution instance，而消息本身引用
    // 常驻 Agent pool instance。两者 definition 相同但 instanceId 不同；任务页应以
    // TASK_ASSIGN/TASK_RESULT 为第一事实来源，隐藏这个内部执行镜像，避免同一任务显示两次。
    if (assignedDefinitionKeys.has(`${workflow.id}:${definition.id}`)) continue;
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
        preferInstanceTerminal: true,
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
