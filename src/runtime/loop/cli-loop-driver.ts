import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, workflowRun } from "../../db/sqlite/schema";
import type { AgentLoopKind, LoopOptionsJson } from "../../types/loop";
import { parseLoopOptionsJson } from "../../types/loop";
import { stepStreamBus } from "../langgraph/event-stream";
import type { StepStreamEvent } from "../langgraph/state";
import type { DispatchToLoopParams, LoopDriver } from "./loop-driver";
import { parseCliLoopLine, sniffNativeSessionId } from "./loop-protocol";
import { writeLoopRunArtifacts } from "./run-artifacts";
import { setWorkflowState } from "../workflow/workflow-state-machine";
/**
 * P2-B：cli-loop-driver 不再直接 `db.insert(agentStep) / .insert(agentInstance) /
 * .update(agentInstance) / .insert(toolCallLog)`；统一通过 external-loop-state
 * 五个 helper 写入。这样 cli driver / 未来其他外部 loop driver 看到的状态
 * 一致，update agent_instance 的字段拼写也不会再漂移。
 */
import {
  appendExternalLoopStep,
  markExternalLoopInstanceError,
  markExternalLoopInstanceStopped,
  recordExternalLoopToolCall,
  startExternalLoopInstance,
} from "./external-loop-state";

const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

const activeCliByRunId = new Map<string, ReturnType<typeof Bun.spawn>>();

/**
 * Phase 2.5：根据 CLI 类型和是否 resume 拼出 base args。
 * - 启动新会话：claude_cli -> `-p <prompt>`；codex_cli -> `exec <prompt>`
 * - 续跑：claude_cli -> `--resume <sessionId> -p <prompt>`；codex_cli -> `exec resume <sessionId>`
 */
function buildBaseCliArgs(
  kind: "claude_cli" | "codex_cli",
  promptPath: string,
  resumeSessionId?: string
): string[] {
  if (kind === "claude_cli") {
    return resumeSessionId ? ["--resume", resumeSessionId, "-p", promptPath] : ["-p", promptPath];
  }
  // codex_cli
  return resumeSessionId ? ["exec", "resume", resumeSessionId] : ["exec", promptPath];
}

async function persistCliSession(
  workflowId: string,
  sessionId: string,
  command: string
): Promise<void> {
  try {
    const db = await getDb();
    await db
      .update(workflowRun)
      .set({ cliSessionId: sessionId, cliLoopCommand: command })
      .where(eq(workflowRun.id, workflowId));
  } catch (err) {
    console.warn(
      "[cli-loop-driver] failed to persist cli_session_id:",
      err instanceof Error ? err.message : err
    );
  }
}

async function readOrchestratorDefinitionId(): Promise<string> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.role, "orchestrator"))
    .limit(1);
  return rows[0]?.id ?? "def-orchestrator";
}

function emitLine(params: {
  runId: string;
  workflowId: string;
  traceId: string;
  loopKind: AgentLoopKind;
  stepIndex: number;
  type: StepStreamEvent["type"];
  payload: Record<string, unknown>;
}): number {
  const event: StepStreamEvent = {
    runId: params.runId,
    workflowId: params.workflowId,
    traceId: params.traceId,
    role: "orchestrator",
    type: params.type,
    stepIndex: params.stepIndex,
    ts: Date.now(),
    payload: params.payload,
    loopKind: params.loopKind,
    source: "cli",
  };
  stepStreamBus.publish(event);
  return params.stepIndex + 1;
}

async function appendAgentStep(input: {
  agentInstanceId: string;
  workflowId: string;
  stepIndex: number;
  thought: string;
  actionJson: Record<string, unknown>;
}): Promise<string> {
  return appendExternalLoopStep({
    agentInstanceId: input.agentInstanceId,
    workflowRunId: input.workflowId,
    stepIndex: input.stepIndex,
    thought: input.thought,
    actionJson: input.actionJson,
  });
}

async function runExternalCli(params: {
  kind: "claude_cli" | "codex_cli";
  workflowId: string;
  projectId: string;
  goal: string;
  mode: string;
  runId: string;
  traceId: string;
  opts: LoopOptionsJson;
  /** Phase 2.5：当前是从持久化的 session 续跑还是全新启动。 */
  resumeSessionId?: string;
}): Promise<void> {
  const db = await getDb();
  const definitionId = await readOrchestratorDefinitionId();

  await setWorkflowState(params.workflowId, "running", { reason: "cli-loop-driver:start" });

  const agentInstanceId = await startExternalLoopInstance({
    definitionId,
    workflowRunId: params.workflowId,
  });

  const inject = params.opts.injectMcpBridge !== false;
  const { promptPath, runDir } = await writeLoopRunArtifacts({
    workflowId: params.workflowId,
    projectId: params.projectId,
    goal: params.goal,
    mode: params.mode,
    loopKind: params.kind,
    injectMcpBridge: inject,
  });

  const command = params.opts.command ?? (params.kind === "claude_cli" ? "claude" : "codex");
  const baseArgs = buildBaseCliArgs(params.kind, promptPath, params.resumeSessionId);
  const args = [...(params.opts.extraArgs ?? []), ...baseArgs];

  // Phase 2.5：第一次启动时把命令字符串落库（resume 命令不覆盖，保留 fresh-start 的 cli_loop_command）。
  if (!params.resumeSessionId) {
    try {
      await db
        .update(workflowRun)
        .set({ cliLoopCommand: `${command} ${args.join(" ")}` })
        .where(eq(workflowRun.id, params.workflowId));
    } catch {
      /* best-effort */
    }
  } else {
    try {
      await db
        .update(workflowRun)
        .set({
          cliSessionResumedCount: sql`${workflowRun.cliSessionResumedCount} + 1`,
        })
        .where(eq(workflowRun.id, params.workflowId));
    } catch {
      /* best-effort */
    }
  }

  const timeoutMs = params.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOut = params.opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  let seq = 0;
  const publish = (type: StepStreamEvent["type"], payload: Record<string, unknown>) => {
    seq = emitLine({
      runId: params.runId,
      workflowId: params.workflowId,
      traceId: params.traceId,
      loopKind: params.kind,
      stepIndex: seq,
      type,
      payload,
    });
  };

  publish("observe", {
    phase: "cli_spawn",
    command,
    args,
    runDir,
    ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
  });

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([command, ...args], {
      cwd: runDir,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    publish("error", { message: `spawn failed: ${message}` });
    await setWorkflowState(params.workflowId, "failed", { reason: "cli-loop-driver:spawn-fail" });
    await markExternalLoopInstanceError({ instanceId: agentInstanceId, message });
    publish("final", { status: "failed", reason: "spawn_error" });
    setTimeout(() => stepStreamBus.close(params.runId), 250);
    return;
  }

  activeCliByRunId.set(params.runId, proc);

  const killTimer = setTimeout(() => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }, timeoutMs);

  let outBytes = 0;
  let errBuf = "";

  let capturedSessionId: string | null = params.resumeSessionId ?? null;

  const processChunk = async (text: string, isErr: boolean) => {
    if (isErr) {
      errBuf += text;
      if (errBuf.length > 32_000) errBuf = errBuf.slice(-32_000);
      return;
    }
    outBytes += text.length;
    if (outBytes > maxOut) {
      publish("error", { message: "stdout exceeded maxOutputBytes" });
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      return;
    }
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      // Phase 2.5：先嗅探原生 stream-json 行的 session_id（Claude/Codex 均会产生），
      // 任意行命中就落一次库；后续重复命中相同 id 时跳过。
      if (!capturedSessionId) {
        const nativeSid = sniffNativeSessionId(line);
        if (nativeSid) {
          capturedSessionId = nativeSid;
          await persistCliSession(params.workflowId, nativeSid, command);
          publish("observe", { phase: "cli_session_captured", sessionId: nativeSid });
        }
      }
      const parsed = parseCliLoopLine(line);
      if (parsed) {
        // Phase 2.5：QUBIT 协议显式声明的 session 行——覆盖之前嗅到的 id，权威性更高
        if (parsed.type === "session" && parsed.sessionId) {
          if (capturedSessionId !== parsed.sessionId) {
            capturedSessionId = parsed.sessionId;
            await persistCliSession(params.workflowId, parsed.sessionId, command);
            publish("observe", {
              phase: "cli_session_declared",
              sessionId: parsed.sessionId,
            });
          }
          continue;
        }
        const stepId = await appendAgentStep({
          agentInstanceId,
          workflowId: params.workflowId,
          stepIndex: seq,
          thought: `cli:${parsed.type}`,
          actionJson: parsed as unknown as Record<string, unknown>,
        });
        if (parsed.type === "log") {
          seq = emitLine({
            runId: params.runId,
            workflowId: params.workflowId,
            traceId: params.traceId,
            loopKind: params.kind,
            stepIndex: seq,
            type: "observe",
            payload: { cli: "log", message: parsed.message },
          });
        } else if (parsed.type === "tool") {
          /**
           * 监控 V2 P2：CLI loop（claude_cli / codex_cli）通过 qubit.loop.v1 NDJSON
           * 发出的 tool 事件之前只发 SSE，不入 tool_call_log；监控页因此看不到
           * 外部 CLI loop 的工具调用统计。这里补一次最小写入：
           *   - toolKind 固定 'builtin'（无法精确区分 acp_connector/mcp/skill；
           *     仅说明这是 CLI loop 内部的工具调用）
           *   - status 'success' — CLI 行级粒度看不到执行成败，由后续 'error' 行兜底
           *   - latencyMs 1（占位；CLI 协议未携带）
           * 同 act.ts 已有的 tool_call_log 写入风格保持一致：失败仅 warn。
           */
          await recordExternalLoopToolCall({
            agentStepId: stepId,
            workflowRunId: params.workflowId,
            traceId: params.traceId,
            source: `cli_loop:${params.kind}`,
            toolName: parsed.tool ?? "unknown",
            payload: parsed.payload ?? null,
          });
          seq = emitLine({
            runId: params.runId,
            workflowId: params.workflowId,
            traceId: params.traceId,
            loopKind: params.kind,
            stepIndex: seq,
            type: "tool_call_start",
            payload: { tool: parsed.tool, payload: parsed.payload },
          });
        } else if (parsed.type === "error") {
          seq = emitLine({
            runId: params.runId,
            workflowId: params.workflowId,
            traceId: params.traceId,
            loopKind: params.kind,
            stepIndex: seq,
            type: "error",
            payload: { message: parsed.message },
          });
        } else if (parsed.type === "final") {
          seq = emitLine({
            runId: params.runId,
            workflowId: params.workflowId,
            traceId: params.traceId,
            loopKind: params.kind,
            stepIndex: seq,
            type: "final",
            payload: parsed.payload ?? { status: "completed" },
          });
        }
      } else {
        await appendAgentStep({
          agentInstanceId,
          workflowId: params.workflowId,
          stepIndex: seq,
          thought: "cli:stdout",
          actionJson: { line },
        });
        seq = emitLine({
          runId: params.runId,
          workflowId: params.workflowId,
          traceId: params.traceId,
          loopKind: params.kind,
          stepIndex: seq,
          type: "observe",
          payload: { cli: "stdout", line },
        });
      }
    }
  };

  const drainStream = async (stream: ReadableStream<Uint8Array> | null, isErr: boolean) => {
    if (!stream) return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let carry = "";
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        carry += dec.decode(value, { stream: true });
        const parts = carry.split("\n");
        carry = parts.pop() ?? "";
        for (const p of parts) {
          await processChunk(`${p}\n`, isErr);
        }
      }
      if (done) break;
    }
    if (carry) await processChunk(carry, isErr);
  };

  try {
    await drainStream(proc.stdout, false);
    await drainStream(proc.stderr, true);
    const exit = await proc.exited;
    clearTimeout(killTimer);
    activeCliByRunId.delete(params.runId);

    if (exit !== 0) {
      publish("error", {
        message: `cli exited with code ${exit}`,
        stderrTail: errBuf.slice(-4000),
      });
      await setWorkflowState(params.workflowId, "failed", {
        reason: `cli-loop-driver:exit=${exit}`,
      });
      await markExternalLoopInstanceError({
        instanceId: agentInstanceId,
        message: `exit ${exit}`,
      });
      publish("final", { status: "failed", exitCode: exit });
    } else {
      await setWorkflowState(params.workflowId, "completed", {
        reason: "cli-loop-driver:exit=0",
      });
      await markExternalLoopInstanceStopped(agentInstanceId);
      publish("final", { status: "completed", exitCode: exit });
    }
  } catch (e) {
    clearTimeout(killTimer);
    activeCliByRunId.delete(params.runId);
    const message = e instanceof Error ? e.message : String(e);
    publish("error", { message });
    await setWorkflowState(params.workflowId, "failed", {
      reason: "cli-loop-driver:runtime-error",
    });
    await markExternalLoopInstanceError({ instanceId: agentInstanceId, message });
    publish("final", { status: "failed", reason: "runtime_error" });
  } finally {
    setTimeout(() => stepStreamBus.close(params.runId), 250);
  }
}

abstract class BaseCliLoopDriver implements LoopDriver {
  abstract readonly kind: "claude_cli" | "codex_cli";

  async dispatchTask(params: DispatchToLoopParams): Promise<{ runId: string }> {
    const runId = randomUUID();
    const traceId = params.traceId ?? randomUUID();
    const db = await getDb();
    const wfRows = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, params.workflowId))
      .limit(1);
    const wf = wfRows[0];
    if (!wf) throw new Error(`workflow not found: ${params.workflowId}`);

    const opts = parseLoopOptionsJson(wf.loopOptionsJson);

    void runExternalCli({
      kind: this.kind,
      workflowId: params.workflowId,
      projectId: wf.projectId,
      goal: wf.goal,
      mode: wf.mode,
      runId,
      traceId,
      opts,
    });

    return { runId };
  }

  /**
   * Phase 2.5：用持久化的 cli_session_id 拉起 CLI 续跑。
   * - 若 workflow_run.cli_session_id 为空，返回 { resumed: false } 由调用方降级处理；
   * - 不抛 workflow not found 之类的硬错误，sweep 调用方需要尽量保持鲁棒。
   */
  async resumeWorkflow(params: {
    workflowId: string;
    traceId?: string;
  }): Promise<{ runId: string; resumed: boolean; sessionId?: string }> {
    const db = await getDb();
    const wfRows = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, params.workflowId))
      .limit(1);
    const wf = wfRows[0];
    if (!wf) return { runId: "", resumed: false };
    if (!wf.cliSessionId) return { runId: "", resumed: false };

    const runId = randomUUID();
    const traceId = params.traceId ?? randomUUID();
    const opts = parseLoopOptionsJson(wf.loopOptionsJson);

    void runExternalCli({
      kind: this.kind,
      workflowId: params.workflowId,
      projectId: wf.projectId,
      goal: wf.goal,
      mode: wf.mode,
      runId,
      traceId,
      opts,
      resumeSessionId: wf.cliSessionId,
    });

    return { runId, resumed: true, sessionId: wf.cliSessionId };
  }
}

export class ClaudeCliLoopDriver extends BaseCliLoopDriver {
  readonly kind = "claude_cli" as const;
}

export class CodexCliLoopDriver extends BaseCliLoopDriver {
  readonly kind = "codex_cli" as const;
}
