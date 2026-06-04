/**
 * exec_call_log 写入服务
 *
 * 与 `tool_call_log` 1:1 同主键。act 节点已经把基础信息（tool_name / status /
 * latency / agent_definition_id）写到 tool_call_log；这里只补 exec 独有维度
 * （provider_id / binary / args / cwd / exit_code / stdout_bytes 等），让监控
 * 页可以按 binary / error_code / cwd 切片。
 *
 * 设计原则（与 mcp-call-log 同构）：
 *   - "best-effort"：写入失败不抛错，记 stderr 即可。tool_call_log 已经是权威记录，
 *     exec_call_log 是结构化加强，丢一条不影响业务。
 *   - "缺 toolCallId / agentStepId 时跳过"：脚本 / 单测 / loop driver 调 dispatch 时
 *     可能没传，要静默跳过而不是报错——保持 builtin handler 在所有路径都能跑。
 */

import { getDb } from "../../db/sqlite/client";
import { execCallLog } from "../../db/sqlite/schema";
import type { ExecResult } from "./types";

export interface ExecCallLogInput {
  toolCallId: string;
  agentStepId: string;
  workflowRunId: string;
  agentDefinitionId?: string | null;
  traceId?: string | null;

  providerId: string;
  execKind: "shell" | "cli_agent";
  binary: string;
  args: string[];
  cwd: string;
  stdinBytes?: number;

  result: ExecResult;
}

/**
 * 把 ExecResult 转成 status 枚举（与 tool_call_log 的 4 个枚举一致）。
 *
 * 映射逻辑：
 *   - 沙箱级拒绝（cwd_escape / shell_metachar / disallowed_subcommand /
 *     binary_not_registered）→ "sandbox_blocked"，让监控页和 sandbox_violation_log
 *     一样观察到"被治理拦下"
 *   - wall_timeout / output_truncated → "timeout"
 *   - 其他 ok=false → "error"
 *   - ok=true → "success"
 */
function deriveStatus(result: ExecResult): "success" | "error" | "timeout" | "sandbox_blocked" {
  if (result.ok) return "success";
  switch (result.error) {
    case "wall_timeout":
      return "timeout";
    case "cwd_escape":
    case "shell_metachar":
    case "disallowed_subcommand":
    case "binary_not_registered":
      return "sandbox_blocked";
    default:
      return "error";
  }
}

/**
 * 写一条 exec_call_log。
 *
 * 缺 toolCallId / agentStepId 时静默跳过（典型场景：脚本 / 测试直接调
 * dispatchBuiltinTool，act 不存在所以没生成 toolCallId）。
 *
 * 内部 try/catch，写入失败只打 stderr，不向上抛——避免 DB 故障打挂主调用链。
 */
export async function writeExecCallLog(input: ExecCallLogInput): Promise<void> {
  if (!input.toolCallId || !input.agentStepId) return;
  try {
    const db = await getDb();
    const stdoutBytes = Buffer.byteLength(input.result.stdout ?? "", "utf-8");
    const stderrBytes = Buffer.byteLength(input.result.stderr ?? "", "utf-8");
    await db.insert(execCallLog).values({
      id: input.toolCallId,
      workflowRunId: input.workflowRunId,
      agentStepId: input.agentStepId,
      agentDefinitionId: input.agentDefinitionId ?? null,
      traceId: input.traceId ?? null,
      retryCount: 0,

      providerId: input.providerId,
      execKind: input.execKind,
      binary: input.binary,

      argsJson: input.args,
      cwd: input.cwd,
      stdinBytes: input.stdinBytes ?? 0,

      exitCode: input.result.exitCode,
      stdoutBytes,
      stderrBytes,
      truncated: input.result.truncated ? 1 : 0,

      status: deriveStatus(input.result),
      errorCode: input.result.error ?? null,
      errorDetail: input.result.errorDetail ?? null,
      latencyMs: input.result.elapsedMs,
    });
  } catch (e) {
    // best-effort；不打挂主调用链
    console.error(
      `[exec_call_log] write failed for toolCallId=${input.toolCallId}: ${(e as Error).message}`
    );
  }
}
