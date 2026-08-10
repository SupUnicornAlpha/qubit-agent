import { sandboxExecutor } from "../sandbox-executor";
import { runPythonSandbox } from "../sandbox/python-sandbox";
import type { BuiltinToolHandler } from "./types";

export const PYTHON_HANDLER: BuiltinToolHandler = async (ctx, params) => {
  const code = typeof params.code === "string" ? params.code : "";
  if (!code.trim()) throw new Error("code.run_python: code is required");
  const vars =
    params.vars && typeof params.vars === "object" && !Array.isArray(params.vars)
      ? (params.vars as Record<string, unknown>)
      : {};
  const timeoutSec =
    typeof params.timeout_sec === "number" && params.timeout_sec > 0 ? params.timeout_sec : 30;
  const maxStdoutBytes =
    typeof params.max_stdout_bytes === "number" && params.max_stdout_bytes > 0
      ? params.max_stdout_bytes
      : 65_536;
  const returnVar =
    typeof params.return_var === "string" && params.return_var.length > 0
      ? params.return_var
      : undefined;
  const dangerous = params.dangerous === true;
  const policy = dangerous ? await sandboxExecutor.loadPolicy(ctx.definition) : null;
  if (dangerous && policy?.pythonSandbox.mode !== "container") {
    throw new Error(
      "code.run_python: dangerous=true requires this agent's sandbox policy to configure pythonSandbox.mode='container'"
    );
  }
  return runPythonSandbox(
    {
      code,
      vars,
      timeoutSec,
      maxStdoutBytes,
      ...(returnVar ? { returnVar } : {}),
    },
    dangerous && policy ? policy.pythonSandbox : undefined
  );
};
