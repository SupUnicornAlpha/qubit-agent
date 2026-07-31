import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import { a2aTaskEvent, project, workflowRun, workspace } from "../../../db/sqlite/schema";
import type { TaskAssignPayload } from "../../../types/a2a";
import {
  completeA2ATask,
  createA2ATask,
  getA2ATask,
  listA2ATaskEvents,
  listA2ATasksForWorkflow,
  listOpenA2ATasksForWorkflow,
  markA2ATaskWorking,
  recordA2ATaskProgress,
  waitForA2ATaskTerminal,
} from "../a2a-task-service";
import { buildTaskResult } from "../task-result";

let workflowId = "";

function taskPayload(taskId: string): TaskAssignPayload {
  return {
    taskId,
    taskType: "topology_dispatch",
    assignedRole: "market_data",
    goal: "获取 603986 的实时行情",
    params: { goal: "获取 603986 的实时行情" },
  };
}

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  const db = await getDb();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  workflowId = randomUUID();
  await db.insert(workspace).values({ id: workspaceId, name: "A2A test", owner: "test" });
  await db.insert(project).values({
    id: projectId,
    workspaceId,
    name: "A2A test",
    marketScope: "CN",
  });
  await db.insert(workflowRun).values({
    id: workflowId,
    projectId,
    goal: "A2A durable task test",
    mode: "research",
  });
});

describe("durable internal A2A task protocol", () => {
  test("persists ordered lifecycle events and keeps task creation idempotent", async () => {
    const taskId = randomUUID();
    const input = {
      workflowId,
      traceId: randomUUID(),
      senderAgentId: randomUUID(),
      receiverAgentId: randomUUID(),
      receiverRole: "market_data" as const,
      payload: taskPayload(taskId),
    };
    const first = await createA2ATask(input);
    const duplicate = await createA2ATask(input);
    expect(duplicate.id).toBe(first.id);
    expect(first.status).toBe("submitted");

    await markA2ATaskWorking(taskId);
    await recordA2ATaskProgress(taskId, {
      taskId,
      phase: "act",
      iteration: 2,
      role: "market_data",
    });
    await completeA2ATask(
      taskId,
      buildTaskResult(taskId, "market_data", {
        status: "completed",
        result: { lastPrice: 12.34 },
        durationMs: 18,
      })
    );

    const task = await getA2ATask(taskId);
    expect(task).toMatchObject({ status: "completed", revision: 3, result: { lastPrice: 12.34 } });
    const db = await getDb();
    const events = await db
      .select()
      .from(a2aTaskEvent)
      .where(eq(a2aTaskEvent.taskId, taskId))
      .orderBy(asc(a2aTaskEvent.sequence));
    expect(events.map((event) => `${event.sequence}:${event.eventType}`)).toEqual([
      "0:submitted",
      "1:working",
      "2:progress",
      "3:completed",
    ]);
    expect((await listA2ATasksForWorkflow(workflowId)).map((item) => item.id)).toContain(taskId);
    expect((await listA2ATaskEvents(taskId, 1)).map((event) => event.sequence)).toEqual([2, 3]);
  });

  test("a waiting parent settles from durable input_required state instead of timing out", async () => {
    const taskId = randomUUID();
    await createA2ATask({
      workflowId,
      traceId: randomUUID(),
      senderAgentId: randomUUID(),
      receiverAgentId: randomUUID(),
      receiverRole: "market_data",
      payload: taskPayload(taskId),
    });
    await completeA2ATask(
      taskId,
      buildTaskResult(taskId, "market_data", {
        status: "awaiting_approval",
        errorCode: "awaiting_approval",
        errorMessage: "需要补充授权",
        result: { prompt: "请选择数据源" },
        durationMs: 1,
      })
    );
    const waited = await waitForA2ATaskTerminal(taskId, { timeoutMs: 100, leaseMs: 100 });
    expect(waited.timedOut).toBe(false);
    expect(waited.task?.status).toBe("input_required");
  });

  test("an explicit failed result stays failed even if a buggy sender sets success", async () => {
    const taskId = randomUUID();
    await createA2ATask({
      workflowId,
      traceId: randomUUID(),
      senderAgentId: randomUUID(),
      receiverAgentId: randomUUID(),
      receiverRole: "market_data",
      payload: taskPayload(taskId),
    });
    await completeA2ATask(taskId, {
      taskId,
      status: "failed",
      success: true,
      result: { partialEvidence: true },
      errorCode: "max_iterations",
      errorMessage: "partial evidence is not completion",
      durationMs: 1,
    });
    expect((await getA2ATask(taskId))?.status).toBe("failed");
  });

  test("persists a resource-limited result as partial, never completed", async () => {
    const taskId = randomUUID();
    await createA2ATask({
      workflowId,
      traceId: randomUUID(),
      senderAgentId: randomUUID(),
      receiverAgentId: randomUUID(),
      receiverRole: "market_data",
      payload: taskPayload(taskId),
    });
    await completeA2ATask(
      taskId,
      buildTaskResult(taskId, "market_data", {
        status: "partial",
        errorCode: "max_iterations",
        errorMessage: "保留了部分已验证行情，但达到轮次上限",
        result: { partialEvidence: true },
        durationMs: 1,
      })
    );
    expect((await getA2ATask(taskId))?.status).toBe("partial");
    expect((await listOpenA2ATasksForWorkflow(workflowId)).map((task) => task.id)).not.toContain(
      taskId
    );
  });

  test("lists only unfinished child tasks for a workflow terminal transition", async () => {
    const openId = randomUUID();
    const completeId = randomUUID();
    for (const taskId of [openId, completeId]) {
      await createA2ATask({
        workflowId,
        traceId: randomUUID(),
        senderAgentId: randomUUID(),
        receiverAgentId: randomUUID(),
        receiverRole: "market_data",
        payload: taskPayload(taskId),
      });
    }
    await completeA2ATask(
      completeId,
      buildTaskResult(completeId, "market_data", { status: "completed", durationMs: 1 })
    );
    expect((await listOpenA2ATasksForWorkflow(workflowId)).map((task) => task.id)).toEqual([
      openId,
    ]);
  });
});
