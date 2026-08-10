/** Docker-backed execution for code which may be actively hostile to Python. */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config";
import type { PythonSandboxPolicy } from "../sandbox-executor";
import type { PythonSandboxRequest, PythonSandboxResponse } from "./python-sandbox";

const RUNNER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../python_connectors/code_container_runner.py"
);
const PACKAGE_SPEC = /^[A-Za-z0-9_.+!<>=:~-]+$/;

export function buildContainerPythonArgs(input: {
  policy: PythonSandboxPolicy;
  containerName: string;
  wheelhousePath?: string;
}): string[] {
  const { policy } = input;
  const args = [
    "docker",
    "run",
    "--rm",
    "-i",
    "--name",
    input.containerName,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    "65534:65534",
    "--pids-limit",
    String(policy.pidsLimit),
    "--memory",
    `${policy.memoryMiB}m`,
    "--cpus",
    String(policy.cpuCount),
    "--workdir",
    "/sandbox",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${policy.tmpfsMiB}m`,
    "--env",
    "PYTHONDONTWRITEBYTECODE=1",
    "--mount",
    `type=bind,src=${RUNNER_PATH},dst=/opt/qubit/code_container_runner.py,readonly`,
  ];
  if (input.wheelhousePath) {
    args.push("--mount", `type=bind,src=${input.wheelhousePath},dst=/opt/wheels,readonly`);
  }
  args.push(policy.image, "python3", "/opt/qubit/code_container_runner.py");
  return args;
}

function resolveWheelhouse(relative: string): string | undefined {
  if (!relative) return undefined;
  if (relative.includes("..") || relative.startsWith("/") || relative.startsWith("\\")) {
    throw new Error("python sandbox wheelhouse must be relative to <dataDir>/sandbox-wheels");
  }
  const root = resolve(config.dataDir, "sandbox-wheels");
  const path = resolve(root, relative);
  if (!path.startsWith(`${root}/`) || !existsSync(path)) {
    throw new Error(`python sandbox wheelhouse not found: ${relative}`);
  }
  return path;
}

export async function runContainerPythonSandbox(
  req: PythonSandboxRequest,
  policy: PythonSandboxPolicy
): Promise<PythonSandboxResponse> {
  if (policy.mode !== "container")
    throw new Error("container Python sandbox is not enabled by policy");
  if (!existsSync(RUNNER_PATH)) throw new Error(`container sandbox runner missing: ${RUNNER_PATH}`);
  if (!policy.packages.every((p) => PACKAGE_SPEC.test(p))) {
    throw new Error("python sandbox packages contain an unsupported package specifier");
  }
  const wheelhouse = resolveWheelhouse(policy.wheelhouse);
  if (policy.packages.length > 0 && !wheelhouse) {
    throw new Error("declared Python packages require a policy wheelhouse");
  }
  const containerName = `qubit-py-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const args = buildContainerPythonArgs({
    policy,
    containerName,
    ...(wheelhouse ? { wheelhousePath: wheelhouse } : {}),
  });
  const payload = JSON.stringify({
    code: req.code,
    vars: req.vars ?? {},
    packages: policy.packages,
    max_stdout_bytes: req.maxStdoutBytes ?? 65_536,
    ...(req.returnVar ? { return_var: req.returnVar } : {}),
  });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    });
  } catch (error) {
    return failure("container_unavailable", error);
  }
  const stdin = proc.stdin as { write(data: string): void; end(): void };
  stdin.write(payload);
  stdin.end();
  const timeoutMs = Math.min(120, Math.max(1, req.timeoutSec ?? 30)) * 1000 + 5_000;
  const work = Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  const winner = await Promise.race([
    work,
    new Promise<"timeout">((done) => setTimeout(() => done("timeout"), timeoutMs)),
  ]);
  if (winner === "timeout") {
    try {
      Bun.spawn(["docker", "kill", containerName], { stdout: "ignore", stderr: "ignore" });
    } catch {
      /* best effort */
    }
    try {
      proc.kill();
    } catch {
      /* best effort */
    }
    return {
      ok: false,
      stdout: "",
      result: null,
      elapsedMs: timeoutMs,
      rowsInResult: 0,
      error: "wall_timeout",
    };
  }
  const [stdout, stderr, exitCode] = winner;
  try {
    const parsed = JSON.parse(stdout.trim()) as {
      ok: boolean;
      stdout?: string;
      result?: unknown;
      elapsed_ms?: number;
      rows_in_result?: number;
      error?: string;
      trace?: string;
    };
    return {
      ok: parsed.ok,
      stdout: parsed.stdout ?? "",
      result: parsed.result ?? null,
      elapsedMs: parsed.elapsed_ms ?? 0,
      rowsInResult: parsed.rows_in_result ?? 0,
      ...(parsed.ok
        ? {}
        : {
            error: parsed.error ?? "container_error",
            ...(parsed.trace ? { trace: parsed.trace } : {}),
          }),
    };
  } catch {
    return {
      ok: false,
      stdout: "",
      result: null,
      elapsedMs: 0,
      rowsInResult: 0,
      error: `container_exit_${exitCode}`,
      trace: (stderr || stdout).trim().slice(0, 1500),
    };
  }
}

function failure(error: string, detail: unknown): PythonSandboxResponse {
  return {
    ok: false,
    stdout: "",
    result: null,
    elapsedMs: 0,
    rowsInResult: 0,
    error,
    trace: detail instanceof Error ? detail.message : String(detail),
  };
}
