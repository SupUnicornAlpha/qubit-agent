import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentInstance, agentStep, workflowRun } from "../../db/sqlite/schema";
import type { AgentLoopKind, LoopOptionsJson } from "../../types/loop";
import { parseLoopOptionsJson } from "../../types/loop";
import { stepStreamBus } from "../langgraph/event-stream";
import type { StepStreamEvent } from "../langgraph/state";
import type { DispatchToLoopParams, LoopDriver } from "./loop-driver";
import { parseCliLoopLine } from "./loop-protocol";
import { writeLoopRunArtifacts } from "./run-artifacts";

const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

const activeCliByRunId = new Map<string, ReturnType<typeof Bun.spawn>>();

export function cancelCliLoopRun(runId: string): boolean {
  const proc = activeCliByRunId.get(runId);
  if (!proc) return false;
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
  activeCliByRunId.delete(runId);
  return true;
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
}): Promise<void> {
  const db = await getDb();
  await db.insert(agentStep).values({
    id: randomUUID(),
    agentInstanceId: input.agentInstanceId,
    workflowRunId: input.workflowId,
    stepIndex: input.stepIndex,
    phase: "external",
    thought: input.thought,
    actionType: "cli_io",
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
}): Promise<void> {
  const db = await getDb();
  const definitionId = await readOrchestratorDefinitionId();
  const agentInstanceId = randomUUID();

  await db
    .update(workflowRun)
    .set({ status: "running" })
    .where(eq(workflowRun.id, params.workflowId));

  await db.insert(agentInstance).values({
    id: agentInstanceId,
    definitionId,
    workflowRunId: params.workflowId,
    status: "running",
    currentIteration: 0,
    startedAt: new Date().toISOString(),
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
  const baseArgs = params.kind === "claude_cli" ? ["-p", promptPath] : ["exec", promptPath];
  const args = [...(params.opts.extraArgs ?? []), ...baseArgs];

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

  publish("observe", { phase: "cli_spawn", command, args, runDir });

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
    await db
      .update(workflowRun)
      .set({ status: "failed", endedAt: new Date().toISOString() })
      .where(eq(workflowRun.id, params.workflowId));
    await db
      .update(agentInstance)
      .set({
        status: "error",
        endedAt: new Date().toISOString(),
        errorMessage: message.slice(0, 2000),
      })
      .where(eq(agentInstance.id, agentInstanceId));
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
      const parsed = parseCliLoopLine(line);
      if (parsed) {
        await appendAgentStep({
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
      await db
        .update(workflowRun)
        .set({ status: "failed", endedAt: new Date().toISOString() })
        .where(eq(workflowRun.id, params.workflowId));
      await db
        .update(agentInstance)
        .set({ status: "error", endedAt: new Date().toISOString(), errorMessage: `exit ${exit}` })
        .where(eq(agentInstance.id, agentInstanceId));
      publish("final", { status: "failed", exitCode: exit });
    } else {
      await db
        .update(workflowRun)
        .set({ status: "completed", endedAt: new Date().toISOString() })
        .where(eq(workflowRun.id, params.workflowId));
      await db
        .update(agentInstance)
        .set({ status: "stopped", endedAt: new Date().toISOString() })
        .where(eq(agentInstance.id, agentInstanceId));
      publish("final", { status: "completed", exitCode: exit });
    }
  } catch (e) {
    clearTimeout(killTimer);
    activeCliByRunId.delete(params.runId);
    const message = e instanceof Error ? e.message : String(e);
    publish("error", { message });
    await db
      .update(workflowRun)
      .set({ status: "failed", endedAt: new Date().toISOString() })
      .where(eq(workflowRun.id, params.workflowId));
    await db
      .update(agentInstance)
      .set({
        status: "error",
        endedAt: new Date().toISOString(),
        errorMessage: message.slice(0, 2000),
      })
      .where(eq(agentInstance.id, agentInstanceId));
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
}

export class ClaudeCliLoopDriver extends BaseCliLoopDriver {
  readonly kind = "claude_cli" as const;
}

export class CodexCliLoopDriver extends BaseCliLoopDriver {
  readonly kind = "codex_cli" as const;
}
