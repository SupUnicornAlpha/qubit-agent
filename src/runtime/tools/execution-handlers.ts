import { writeExecCallLog } from "../exec/exec-call-log";
import { getExecProvider } from "../exec/registry";
import { checkArgs, checkCwdScope, renderArgTemplate, runExec } from "../exec/runner";
import type { ExecResult } from "../exec/types";
import type { BuiltinToolHandler } from "./types";

/** Sandboxed local-command and external CLI-agent handlers. */
export const EXECUTION_HANDLERS: Record<string, BuiltinToolHandler> = {
  // 设计要点：
  //   - act 节点已自动跑 sandbox.checkToolCall（工具名层白名单）
  //   - 这里再做 binary 层白名单（必须在 EXEC_PROVIDERS 中注册）+ cwd 边界 + arg 元字符防御
  //   - 错误统一返回 ExecResult 结构（ok=false + error code），不 throw，让 ReAct 自纠错
  /**
   * shell.exec — 让 agent 直接调用本地 CLI（git/jq/duckdb/rg/...）。
   *
   * 调用形态：
   *   { tool: "shell.exec", params: {
   *       binary: "duckdb",
   *       args: ["-c", "SELECT count(*) FROM 'bars.parquet'"],
   *       cwd: "/Users/.../projects/<pid>/workflows/<runId>",
   *       timeoutMs: 30000   // 可选
   *   } }
   *
   * cwd 必须落在 provider.workdirStrategy 限定的根目录下，
   * args 走数组形式不经 shell（防注入）。
   *
   * 所有路径（含治理拦截）都落 exec_call_log，让监控页能看到"被拦下"的次数。
   */
  "shell.exec": async (ctx, params) => {
    const binary = String(params.binary ?? "").trim();
    if (!binary) throw new Error("shell.exec: binary is required");

    const argsRaw = params.args;
    const args = Array.isArray(argsRaw)
      ? argsRaw.map((a) => (typeof a === "string" ? a : String(a)))
      : [];
    const cwd = String(params.cwd ?? "").trim();
    const stdinText = typeof params.stdinText === "string" ? params.stdinText : undefined;
    const stdinBytes = stdinText ? Buffer.byteLength(stdinText, "utf-8") : 0;

    const logBase = {
      toolCallId: ctx.toolCallId ?? "",
      agentStepId: ctx.agentStepId ?? "",
      workflowRunId: ctx.workflowId,
      agentDefinitionId: ctx.definition.id,
      traceId: ctx.traceId,
      providerId: binary,
      execKind: "shell" as const,
      binary,
      args,
      cwd,
      stdinBytes,
    };
    const earlyResult = (result: ExecResult): ExecResult => {
      void writeExecCallLog({ ...logBase, result });
      return result;
    };

    const provider = await getExecProvider(binary, "shell");
    if (!provider) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "binary_not_registered",
        errorDetail: `binary "${binary}" is not in EXEC_PROVIDERS; register it in $dataDir/exec-providers.json or pick from the built-in list (git/jq/rg/duckdb)`,
      });
    }

    if (!cwd) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "cwd_escape",
        errorDetail: "shell.exec: cwd is required (must be absolute path within workdir scope)",
      });
    }

    const cwdCheck = checkCwdScope(cwd, provider, {
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      workflowId: ctx.workflowId,
    });
    if (!cwdCheck.ok) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "cwd_escape",
        errorDetail: cwdCheck.reason ?? "cwd escape",
      });
    }

    const argCheck = checkArgs(provider, args);
    if (!argCheck.ok) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: argCheck.reason?.includes("subcommand") ? "disallowed_subcommand" : "shell_metachar",
        errorDetail: argCheck.reason ?? "arg rejected",
      });
    }

    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : undefined;

    const result = await runExec({
      provider,
      args,
      cwd,
      ...(stdinText !== undefined ? { stdinText } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      toolCallContext: {
        ...(ctx.workflowId ? { workflowId: ctx.workflowId } : {}),
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
      },
    });
    void writeExecCallLog({
      ...logBase,
      providerId: provider.id,
      binary: provider.command,
      result,
    });
    return result;
  },

  /**
   * cli_agent.run — 把外部 agentic CLI（claude-code / aider / codex）作为子智能体调用。
   *
   * 调用形态：
   *   { tool: "cli_agent.run", params: {
   *       agentId: "claude-code",
   *       task: "在 src/runtime/factor/ 下新增 risk_parity 因子，参考已有 alpha101 风格",
   *       cwd: "/Users/.../projects/<pid>/workflows/<runId>",
   *       files: ["src/runtime/factor/momentum.ts"],   // 可选：通过 argTemplate {files...} 展开
   *       timeoutMs: 600000   // 可选
   *   } }
   *
   * 与 shell.exec 的差别：
   *   - args 不由 LLM 自由组装，而是从 provider.argTemplate 渲染（占位符 {prompt}/{cwd}/{files...}）
   *   - 默认超时长（5-10 分钟）；输出截断阈值高（256KB）
   *   - lifecycle=unsafe，UI 应高亮警示
   */
  "cli_agent.run": async (ctx, params) => {
    const agentId = String(params.agentId ?? "").trim();
    if (!agentId) throw new Error("cli_agent.run: agentId is required");

    const task = String(params.task ?? "").trim();
    const cwd = String(params.cwd ?? "").trim();
    const filesRaw = params.files;
    const files = Array.isArray(filesRaw)
      ? filesRaw.filter((f): f is string => typeof f === "string" && f.length > 0)
      : undefined;

    const logBase = {
      toolCallId: ctx.toolCallId ?? "",
      agentStepId: ctx.agentStepId ?? "",
      workflowRunId: ctx.workflowId,
      agentDefinitionId: ctx.definition.id,
      traceId: ctx.traceId,
      providerId: agentId,
      execKind: "cli_agent" as const,
      binary: agentId,
      args: [] as string[],
      cwd,
      stdinBytes: 0,
    };
    const earlyResult = (result: ExecResult, args: string[] = []): ExecResult => {
      void writeExecCallLog({ ...logBase, args, result });
      return result;
    };

    const provider = await getExecProvider(agentId, "cli_agent");
    if (!provider) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "binary_not_registered",
        errorDetail: `cli_agent "${agentId}" is not in EXEC_PROVIDERS (kind=cli_agent); built-in: claude-code, aider`,
      });
    }

    if (!task) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "exec_failed",
        errorDetail: "cli_agent.run: task is required (non-empty natural-language prompt)",
      });
    }

    if (!cwd) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "cwd_escape",
        errorDetail: "cli_agent.run: cwd is required (must be absolute path within workdir scope)",
      });
    }

    const cwdCheck = checkCwdScope(cwd, provider, {
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      workflowId: ctx.workflowId,
    });
    if (!cwdCheck.ok) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "cwd_escape",
        errorDetail: cwdCheck.reason ?? "cwd escape",
      });
    }

    const template = provider.argTemplate ?? ["{prompt}"];
    const args = renderArgTemplate(template, {
      prompt: task,
      cwd,
      ...(files ? { files } : {}),
    });

    const argCheck = checkArgs(provider, args);
    if (!argCheck.ok) {
      return earlyResult(
        {
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          truncated: false,
          elapsedMs: 0,
          error: "shell_metachar",
          errorDetail: `cli_agent.run: task or files triggered metachar check: ${argCheck.reason}`,
        },
        args
      );
    }

    const stdinText =
      provider.stdinTemplate !== undefined
        ? provider.stdinTemplate.replace(/\{prompt\}/g, task).replace(/\{cwd\}/g, cwd)
        : undefined;
    const stdinBytes = stdinText ? Buffer.byteLength(stdinText, "utf-8") : 0;
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : undefined;

    const result = await runExec({
      provider,
      args,
      cwd,
      ...(stdinText !== undefined ? { stdinText } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      toolCallContext: {
        ...(ctx.workflowId ? { workflowId: ctx.workflowId } : {}),
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
      },
    });
    void writeExecCallLog({
      ...logBase,
      providerId: provider.id,
      binary: provider.command,
      args,
      stdinBytes,
      result,
    });
    return result;
  },
};
