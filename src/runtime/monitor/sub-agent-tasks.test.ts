import { describe, expect, test } from "bun:test";
import { buildSubAgentTasks } from "./sub-agent-tasks";

const workflow = {
  id: "wf-1",
  projectId: "project-1",
  sessionId: "session-1",
  goal: "分析东山精密近期行情与新闻",
  status: "running",
  startedAt: "2026-07-23T01:00:00.000Z",
  endedAt: null,
};

const definitions = [
  { id: "def-orch", role: "orchestrator", name: "编排器" },
  { id: "def-news", role: "news_event", name: "新闻 Agent" },
  { id: "def-tech", role: "analyst_technical", name: "技术面 Agent" },
];

describe("buildSubAgentTasks", () => {
  test("关联 A2A 委派与结果，并支持 receiver 来自 Agent pool workflow", () => {
    const rows = buildSubAgentTasks({
      workflows: [workflow],
      definitions,
      instances: [
        {
          id: "orch-1",
          definitionId: "def-orch",
          workflowRunId: "wf-1",
          status: "running",
          currentIteration: 1,
          startedAt: workflow.startedAt,
          endedAt: null,
          errorMessage: null,
        },
        {
          id: "news-pool-1",
          definitionId: "def-news",
          workflowRunId: "pool-workflow",
          status: "idle",
          currentIteration: 2,
          startedAt: "2026-07-01T00:00:00.000Z",
          endedAt: null,
          errorMessage: null,
        },
      ],
      messages: [
        {
          id: "assign-1",
          workflowRunId: "wf-1",
          traceId: "trace-news-1",
          senderInstanceId: "orch-1",
          receiverInstanceId: "news-pool-1",
          messageType: "TASK_ASSIGN",
          payloadJson: {
            taskId: "task-news",
            taskType: "topology_dispatch",
            params: { goal: "收集近 7 天新闻", context: "仅使用最近 7 天的可靠来源" },
          },
          createdAt: "2026-07-23T01:01:00.000Z",
        },
        {
          id: "result-1",
          workflowRunId: "wf-1",
          traceId: "trace-news-1",
          senderInstanceId: "news-pool-1",
          receiverInstanceId: "orch-1",
          messageType: "TASK_RESULT",
          payloadJson: { taskId: "task-news", success: true, result: {} },
          createdAt: "2026-07-23T01:02:00.000Z",
        },
      ],
      steps: [
        {
          workflowRunId: "wf-1",
          agentInstanceId: "news-pool-1",
          phase: "observe",
          stepIndex: 2,
          createdAt: "2026-07-23T01:01:30.000Z",
        },
      ],
      sessionTitles: new Map([["session-1", "东山精密研究"]]),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "assign-1",
      source: "a2a_assignment",
      taskId: "task-news",
      traceId: "trace-news-1",
      workflowRunId: "wf-1",
      sessionId: "session-1",
      sessionTitle: "东山精密研究",
      agentRole: "news_event",
      parentInstanceId: "orch-1",
      parentAgentRole: "orchestrator",
      parentAgentName: "编排器",
      a2aContext: "仅使用最近 7 天的可靠来源",
      title: "收集近 7 天新闻",
      status: "completed",
      stepCount: 1,
      latestPhase: "observe",
    });
  });

  test("补齐没有 TASK_ASSIGN 的非 Orchestrator 实例，并排除 Orchestrator", () => {
    const rows = buildSubAgentTasks({
      workflows: [{ ...workflow, status: "failed", endedAt: "2026-07-23T01:03:00.000Z" }],
      definitions,
      instances: [
        {
          id: "orch-1",
          definitionId: "def-orch",
          workflowRunId: "wf-1",
          status: "error",
          currentIteration: 1,
          startedAt: workflow.startedAt,
          endedAt: "2026-07-23T01:03:00.000Z",
          errorMessage: "orchestrator failed",
        },
        {
          id: "tech-1",
          definitionId: "def-tech",
          workflowRunId: "wf-1",
          status: "error",
          currentIteration: 3,
          startedAt: "2026-07-23T01:01:00.000Z",
          endedAt: "2026-07-23T01:03:00.000Z",
          errorMessage: "K 线数据不可用",
        },
      ],
      messages: [],
      steps: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "agent:wf-1:tech-1",
      source: "agent_execution",
      agentRole: "analyst_technical",
      status: "failed",
      errorMessage: "K 线数据不可用",
    });
  });
});
