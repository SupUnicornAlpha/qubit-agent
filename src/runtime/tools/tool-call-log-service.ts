/**
 * tool_call_log / mcp_call_log / acp_call 三张表的统一写入服务。
 *
 * P1-G 收敛：之前 `langgraph/nodes/act.ts` 直接 `db.insert(...) / .update(...)`
 * 散写这 3 张表共 7 处，每处都要重复处理"mcp 可能为空 → 不写 mcp_call_log"和
 * "acp 失败/超时/成功对应不同 status 字符串"的细节。本文件把 ACT 节点对工具
 * 调用日志的所有写入聚合成 5 个语义化函数：
 *   - recordToolCallStart      工具调用开始（同时初始化 tool_call_log /
 *                              mcp_call_log，status 先记 "success" + latency=1，
 *                              终态由后续 record* 覆盖）
 *   - recordToolCallSandboxBlocked 沙箱拒绝
 *   - recordToolCallTimeout    工具超时（sandbox.enforceToolTimeout 兜底）
 *   - recordToolCallError      工具失败（mcp / connector / builtin 三个来源）
 *   - recordToolCallSuccess    工具成功
 *
 * 行为与 P0-4 / P1-D 完全一致；仅是把 db 写入逻辑搬出 act.ts。act.ts 只负责
 * 业务编排（参数解析 / sandbox check / 调度 / SSE emit / observation 构造）。
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { acpCall, mcpCallLog, toolCallLog } from "../../db/sqlite/schema";

export type ToolTargetKind = "mcp" | "tool" | "connector";
export type ToolKind = "mcp" | "builtin" | "acp_connector";
export type ToolErrorSource = "mcp" | "connector" | "builtin" | "unknown";

export interface RecordToolCallStartInput {
  toolCallId: string;
  agentStepId: string;
  workflowRunId: string;
  traceId: string;
  targetName: string;
  toolKind: ToolKind;
  targetKind: ToolTargetKind;
  /** 仅 MCP 路径需要：serverName / toolName / arguments */
  mcp?: { serverName: string; toolName: string; arguments?: unknown };
  reasonText: string;
  contextMemory?: unknown;
}

/**
 * 初始化 tool_call_log（必写）+ mcp_call_log（仅 MCP 路径写）。两条记录在
 * 写入时都先标 status="success" + latencyMs=1，后续 record* 函数会按真实终态
 * update 覆盖。这种"乐观初始化"是 P0-4 之前的设计，保留以兼容现有监控查询。
 */
export async function recordToolCallStart(input: RecordToolCallStartInput): Promise<void> {
  const db = await getDb();
  await db.insert(toolCallLog).values({
    id: input.toolCallId,
    agentStepId: input.agentStepId,
    /**
     * 监控 V2 P1：直接写 workflow_run_id / trace_id，避免 /tools/summary 等
     * 跨工作流查询被迫 join agent_step。
     */
    workflowRunId: input.workflowRunId,
    traceId: input.traceId,
    retryCount: 0,
    toolName: input.targetName,
    toolKind: input.toolKind,
    requestJson: {
      reasonText: input.reasonText,
      contextMemory: input.contextMemory,
      targetKind: input.targetKind,
      mcp: input.mcp ?? null,
    },
    status: "success",
    latencyMs: 1,
  });
  if (input.mcp) {
    await db.insert(mcpCallLog).values({
      id: input.toolCallId,
      workflowRunId: input.workflowRunId,
      agentStepId: input.agentStepId,
      serverName: input.mcp.serverName,
      toolName: input.mcp.toolName,
      /** 监控 V2 P1：traceId 跨表对齐 tool_call_log，便于「同次工具调用」聚合 */
      traceId: input.traceId,
      retryCount: 0,
      requestJson: {
        reasonText: input.reasonText,
        arguments: input.mcp.arguments,
      },
      status: "success",
      latencyMs: 1,
    });
  }
}

interface BaseAcpInsertInput {
  acpId: string;
  toolCallId: string;
  workflowRunId: string;
  traceId: string;
  agentStepId: string;
  callerInstanceId: string;
  targetKind: ToolTargetKind;
  targetName: string;
  intent: string;
  hasMcp: boolean;
}

export interface RecordToolCallSandboxBlockedInput extends BaseAcpInsertInput {
  reason: string;
  violationType?: string | undefined;
}

/** 返回写入的 acp_call.id（对外保留，方便 SSE / observation 关联） */
export async function recordToolCallSandboxBlocked(
  input: RecordToolCallSandboxBlockedInput,
): Promise<void> {
  const db = await getDb();
  await db.insert(acpCall).values({
    id: input.acpId,
    workflowRunId: input.workflowRunId,
    traceId: input.traceId,
    agentStepId: input.agentStepId,
    callerInstanceId: input.callerInstanceId,
    targetKind: input.targetKind,
    targetName: input.targetName,
    intent: input.intent,
    status: "blocked_by_sandbox",
    errorCode:
      input.violationType ??
      (input.targetKind === "mcp"
        ? "mcp_not_allowed"
        : input.targetKind === "connector"
          ? "connector_not_allowed"
          : "tool_not_allowed"),
  });

  await db
    .update(toolCallLog)
    .set({
      status: "sandbox_blocked",
      errorMessage: input.reason ?? "blocked by sandbox",
    })
    .where(eq(toolCallLog.id, input.toolCallId));

  if (input.hasMcp) {
    await db
      .update(mcpCallLog)
      .set({
        status: "sandbox_blocked",
        errorCode: input.violationType ?? "mcp_not_allowed",
        responseJson: { reason: input.reason ?? "blocked by sandbox" },
      })
      .where(eq(mcpCallLog.id, input.toolCallId));
  }
}

export interface RecordToolCallTimeoutInput extends BaseAcpInsertInput {
  latencyMs: number;
  reason: string;
  violationType?: string | undefined;
}

export async function recordToolCallTimeout(input: RecordToolCallTimeoutInput): Promise<void> {
  const db = await getDb();
  await db.insert(acpCall).values({
    id: input.acpId,
    workflowRunId: input.workflowRunId,
    traceId: input.traceId,
    agentStepId: input.agentStepId,
    callerInstanceId: input.callerInstanceId,
    targetKind: input.targetKind,
    targetName: input.targetName,
    intent: input.intent,
    status: "timeout",
    latencyMs: input.latencyMs,
    errorCode: input.violationType ?? "timeout",
  });

  await db
    .update(toolCallLog)
    .set({
      status: "timeout",
      latencyMs: input.latencyMs,
      errorMessage: input.reason ?? "tool timeout",
    })
    .where(eq(toolCallLog.id, input.toolCallId));

  if (input.hasMcp) {
    await db
      .update(mcpCallLog)
      .set({
        status: "timeout",
        latencyMs: input.latencyMs,
        errorCode: input.violationType ?? "timeout",
        responseJson: { reason: input.reason ?? "tool timeout" },
      })
      .where(eq(mcpCallLog.id, input.toolCallId));
  }
}

export interface RecordToolCallErrorInput extends BaseAcpInsertInput {
  latencyMs: number;
  errorSource: ToolErrorSource;
  errorMessage: string;
}

export async function recordToolCallError(input: RecordToolCallErrorInput): Promise<void> {
  const db = await getDb();
  const errorCode = `${input.errorSource}_call_failed`;

  await db.insert(acpCall).values({
    id: input.acpId,
    workflowRunId: input.workflowRunId,
    traceId: input.traceId,
    agentStepId: input.agentStepId,
    callerInstanceId: input.callerInstanceId,
    targetKind: input.targetKind,
    targetName: input.targetName,
    intent: input.intent,
    status: "error",
    latencyMs: input.latencyMs,
    errorCode,
  });

  await db
    .update(toolCallLog)
    .set({
      status: "error",
      latencyMs: input.latencyMs,
      errorMessage: input.errorMessage,
      responseJson: {
        toolError: true,
        errorSource: input.errorSource,
        errorMessage: input.errorMessage,
      },
    })
    .where(eq(toolCallLog.id, input.toolCallId));

  if (input.hasMcp) {
    await db
      .update(mcpCallLog)
      .set({
        status: "failed",
        latencyMs: input.latencyMs,
        errorCode,
        responseJson: { errorMessage: input.errorMessage },
      })
      .where(eq(mcpCallLog.id, input.toolCallId));
  }
}

export interface RecordToolCallSuccessInput extends BaseAcpInsertInput {
  latencyMs: number;
  responsePayload: Record<string, unknown>;
}

export async function recordToolCallSuccess(input: RecordToolCallSuccessInput): Promise<void> {
  const db = await getDb();
  await db.insert(acpCall).values({
    id: input.acpId,
    workflowRunId: input.workflowRunId,
    traceId: input.traceId,
    agentStepId: input.agentStepId,
    callerInstanceId: input.callerInstanceId,
    targetKind: input.targetKind,
    targetName: input.targetName,
    intent: input.intent,
    status: "success",
    latencyMs: input.latencyMs,
  });

  await db
    .update(toolCallLog)
    .set({
      status: "success",
      latencyMs: input.latencyMs,
      responseJson: { ...input.responsePayload, acpId: input.acpId },
    })
    .where(eq(toolCallLog.id, input.toolCallId));

  if (input.hasMcp) {
    await db
      .update(mcpCallLog)
      .set({
        status: "success",
        latencyMs: input.latencyMs,
        responseJson: { ...input.responsePayload, acpId: input.acpId },
      })
      .where(eq(mcpCallLog.id, input.toolCallId));
  }
}
