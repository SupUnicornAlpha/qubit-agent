/**
 * 外部 loop driver（claude_cli / codex_cli / 未来 ollama-cli 等）状态写入服务。
 *
 * P2-B：之前 `cli-loop-driver.ts` 内 `db.insert(agentStep) / db.insert(agentInstance)
 * / db.update(agentInstance) / db.insert(toolCallLog)` 散写 1+4+1+1 = 7 处，
 * 每次 update agent_instance 的 set 字段都得手动拼一遍，极易和 graph / a2a 路径
 * 的写法漂移。这里把"外部 loop 视角"的 agent_step / agent_instance /
 * tool_call_log 写入收敛成 5 个语义化函数：
 *   - startExternalLoopInstance       新 agent_instance：running + currentIteration=0
 *   - markExternalLoopInstanceStopped exit=0 时把 instance 标 stopped
 *   - markExternalLoopInstanceError   spawn / exit !=0 / runtime error 时标 error
 *   - appendExternalLoopStep          cli 解析出的协议行 / 原始 stdout 行落库
 *   - recordExternalLoopToolCall      cli 解析出的 tool 事件落 tool_call_log
 *
 * 与 `tool-call-log-service.ts`（P1-G 抽出）的区别：那里专门服务 LangGraph
 * act 节点（强依赖 acpCall / mcpCallLog 联动），不契合外部 loop 没有 ACP 的
 * 上下文。本服务是为"外部 process 视角"补的轻量等价物，**只写 tool_call_log
 * 一张表**，避免误造假 ACP 记录。
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentInstance, agentStep, toolCallLog } from "../../db/sqlite/schema";

const ERROR_MESSAGE_MAX_LEN = 2000;

function truncateError(message: string): string {
  return message.length > ERROR_MESSAGE_MAX_LEN
    ? message.slice(0, ERROR_MESSAGE_MAX_LEN)
    : message;
}

export interface StartExternalLoopInstanceInput {
  definitionId: string;
  workflowRunId: string;
}

/** 创建一条 running 的 agent_instance；返回新 instanceId（uuid）。 */
export async function startExternalLoopInstance(
  input: StartExternalLoopInstanceInput,
): Promise<string> {
  const db = await getDb();
  const id = randomUUID();
  await db.insert(agentInstance).values({
    id,
    definitionId: input.definitionId,
    workflowRunId: input.workflowRunId,
    status: "running",
    currentIteration: 0,
    startedAt: new Date().toISOString(),
  });
  return id;
}

/** exit code 0 路径：把 instance 标 stopped + endedAt now */
export async function markExternalLoopInstanceStopped(instanceId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(agentInstance)
    .set({ status: "stopped", endedAt: new Date().toISOString() })
    .where(eq(agentInstance.id, instanceId));
}

export interface MarkExternalLoopInstanceErrorInput {
  instanceId: string;
  message: string;
}

/** spawn / runtime / exit !=0 都走这条；errorMessage 自动截断到 2000 字。 */
export async function markExternalLoopInstanceError(
  input: MarkExternalLoopInstanceErrorInput,
): Promise<void> {
  const db = await getDb();
  await db
    .update(agentInstance)
    .set({
      status: "error",
      endedAt: new Date().toISOString(),
      errorMessage: truncateError(input.message),
    })
    .where(eq(agentInstance.id, input.instanceId));
}

export interface AppendExternalLoopStepInput {
  agentInstanceId: string;
  workflowRunId: string;
  stepIndex: number;
  thought: string;
  actionJson: Record<string, unknown>;
}

/** 写一条 phase='external' 的 agent_step；返回新 stepId（uuid）。 */
export async function appendExternalLoopStep(
  input: AppendExternalLoopStepInput,
): Promise<string> {
  const db = await getDb();
  const id = randomUUID();
  await db.insert(agentStep).values({
    id,
    agentInstanceId: input.agentInstanceId,
    workflowRunId: input.workflowRunId,
    stepIndex: input.stepIndex,
    phase: "external",
    thought: input.thought,
    actionType: "cli_io",
    actionJson: input.actionJson,
  });
  return id;
}

export interface RecordExternalLoopToolCallInput {
  agentStepId: string;
  workflowRunId: string;
  traceId: string;
  /** 触发源标识，例如 'cli_loop:claude_cli' */
  source: string;
  toolName: string;
  payload?: unknown;
}

/**
 * 外部 loop 的工具调用日志（仅写 tool_call_log）。
 *
 * - status 固定 'success'：CLI 协议行粒度看不到执行成败，由后续 'error' 行兜底
 * - latencyMs 1：CLI 协议未携带延迟，占位
 * - toolKind 'builtin'：外部 loop 无法精确区分 acp_connector/mcp/skill；
 *   仅说明这是 loop 内部调用
 * - 不写 mcp_call_log / acp_call：避免误造假的 ACP / MCP 记录污染监控
 * - 写失败仅 warn 不抛：监控类副作用不挡主流程
 */
export async function recordExternalLoopToolCall(
  input: RecordExternalLoopToolCallInput,
): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(toolCallLog).values({
      id: randomUUID(),
      agentStepId: input.agentStepId,
      workflowRunId: input.workflowRunId,
      traceId: input.traceId,
      retryCount: 0,
      toolName: input.toolName,
      toolKind: "builtin",
      requestJson: {
        source: input.source,
        payload: input.payload ?? null,
      },
      status: "success",
      latencyMs: 1,
    });
  } catch (e) {
    console.warn(
      `[external-loop-state] tool_call_log insert failed (tool=${input.toolName}): ${(e as Error).message}`,
    );
  }
}
