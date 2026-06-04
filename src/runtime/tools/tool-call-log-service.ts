/**
 * tool_call_log / mcp_call_log 两张表的统一写入服务。
 *
 * P1-G 收敛：之前 `langgraph/nodes/act.ts` 直接 `db.insert(...) / .update(...)`
 * 散写日志表共 7 处，每处都要重复处理"mcp 可能为空 → 不写 mcp_call_log"和
 * "成功/失败/超时对应不同 status 字符串"的细节。本文件把 ACT 节点对工具
 * 调用日志的所有写入聚合成 5 个语义化函数：
 *   - recordToolCallStart      工具调用开始（同时初始化 tool_call_log /
 *                              mcp_call_log，status 先记 "success" + latency=1，
 *                              终态由后续 record* 覆盖）
 *   - recordToolCallSandboxBlocked 沙箱拒绝
 *   - recordToolCallTimeout    工具超时（sandbox.enforceToolTimeout 兜底）
 *   - recordToolCallError      工具失败（mcp / connector / builtin 三个来源）
 *   - recordToolCallSuccess    工具成功
 *
 * Schema 收敛 C5-1（2026-06）：原来还会同步写入 `acp_call` 表保留一份
 * caller / target / intent 维度的"事件性"审计；但全仓代码扫描后该表 4 个 insert
 * 之外**仅 `langgraph/minimum-acceptance.ts` 这个一次性脚本读取**，0 个 monitor
 * 端点 / 0 个前端组件消费。同样字段（status / latency / errorCode）已落在
 * tool_call_log 与 mcp_call_log，acp_call 退化为"持续写入但没有任何聚合查询"的
 * 冗余表，遂随 migration 0069 一同删除。
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { mcpCallLog, toolCallLog } from "../../db/sqlite/schema";

export type ToolTargetKind = "mcp" | "tool" | "connector";
export type ToolKind = "mcp" | "builtin" | "acp_connector";
export type ToolErrorSource = "mcp" | "connector" | "builtin" | "unknown";

export interface RecordToolCallStartInput {
  toolCallId: string;
  agentStepId: string;
  workflowRunId: string;
  traceId: string;
  /**
   * 监控 v3 P0：直接落 agent_definition_id 到 tool_call_log / mcp_call_log，
   * 避免按 Agent 切分 timeseries 时要 3 跳 join。
   * 可选——CLI loop / 老代码未提供时保持 NULL。
   */
  agentDefinitionId?: string | null;
  targetName: string;
  toolKind: ToolKind;
  targetKind: ToolTargetKind;
  /** 仅 MCP 路径需要：serverName / toolName / arguments */
  mcp?: { serverName: string; toolName: string; arguments?: unknown };
  /**
   * 仅 MCP 路径用：调用时已知的 transport (stdio/http/ws)。
   * dispatcher 自己最清楚，所以 act.ts 传 undefined 时也能后续 update 补；
   * 本期 act 直接传 dispatcher 配置里的 transport。
   */
  mcpTransport?: string | null;
  /**
   * 仅 MCP 路径用：调用发起前快照的熔断状态。
   * 失败复盘时关键 —— 看出来这次失败是"真的失败"还是"短路返回"。
   */
  mcpCircuitState?: "closed" | "open" | "half_open" | null;
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
    /** 监控 v3 P0：冗余 agent_definition_id 让按 Agent 切分 timeseries 走单表索引 */
    agentDefinitionId: input.agentDefinitionId ?? null,
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
      /** 监控 v3 P0：同上，冗余以利于按 Agent 切分 */
      agentDefinitionId: input.agentDefinitionId ?? null,
      serverName: input.mcp.serverName,
      toolName: input.mcp.toolName,
      /** 监控 V2 P1：traceId 跨表对齐 tool_call_log，便于「同次工具调用」聚合 */
      traceId: input.traceId,
      retryCount: 0,
      /** 监控 v3 P0：transport / circuitState 复盘字段；未知时保持 null 不影响其它统计 */
      transport: input.mcpTransport ?? null,
      circuitState: input.mcpCircuitState ?? null,
      requestJson: {
        reasonText: input.reasonText,
        arguments: input.mcp.arguments,
      },
      status: "success",
      latencyMs: 1,
    });
  }
}

/**
 * 终态 helper 的最小公共输入。Schema 收敛 C5-1 之后，原本只为 `acp_call` 服务的
 * caller / target / intent / agentStepId 字段已不再需要 —— 这些维度都能从
 * tool_call_log（toolName / requestJson.targetKind / agentStepId 列）或
 * agent_step → agent_instance 反查到。
 */
interface BaseFinalizeInput {
  toolCallId: string;
  /** 仅决定是否需要同步 update mcp_call_log；非 MCP 路径不写 mcp_call_log */
  hasMcp: boolean;
}

export interface RecordToolCallSandboxBlockedInput extends BaseFinalizeInput {
  reason: string;
  violationType?: string | undefined;
}

export async function recordToolCallSandboxBlocked(
  input: RecordToolCallSandboxBlockedInput
): Promise<void> {
  const db = await getDb();
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

export interface RecordToolCallTimeoutInput extends BaseFinalizeInput {
  latencyMs: number;
  reason: string;
  violationType?: string | undefined;
}

export async function recordToolCallTimeout(input: RecordToolCallTimeoutInput): Promise<void> {
  const db = await getDb();
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

export interface RecordToolCallErrorInput extends BaseFinalizeInput {
  latencyMs: number;
  errorSource: ToolErrorSource;
  errorMessage: string;
}

export async function recordToolCallError(input: RecordToolCallErrorInput): Promise<void> {
  const db = await getDb();
  const errorCode = `${input.errorSource}_call_failed`;

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

export interface RecordToolCallSuccessInput extends BaseFinalizeInput {
  latencyMs: number;
  responsePayload: Record<string, unknown>;
}

export async function recordToolCallSuccess(input: RecordToolCallSuccessInput): Promise<void> {
  const db = await getDb();
  await db
    .update(toolCallLog)
    .set({
      status: "success",
      latencyMs: input.latencyMs,
      responseJson: input.responsePayload,
    })
    .where(eq(toolCallLog.id, input.toolCallId));

  if (input.hasMcp) {
    await db
      .update(mcpCallLog)
      .set({
        status: "success",
        latencyMs: input.latencyMs,
        responseJson: input.responsePayload,
      })
      .where(eq(mcpCallLog.id, input.toolCallId));
  }
}
