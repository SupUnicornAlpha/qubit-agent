/**
 * Docker adapter for Harness' guarded developer profile.
 *
 * This module intentionally has no host-process fallback. A caller that opts
 * into `guarded-container` either gets a constrained Docker process or a
 * structured failure. Allowlisted network access is admitted only through an
 * operator-provisioned proxy network; incomplete proxy setup remains closed.
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExecProvider, ExecResult } from "../exec/types";
import { type HarnessSandboxProfile, getBuiltinHarnessSandboxProfile } from "./sandbox-profile";

const WALL_CLOCK_BUFFER_MS = 1_000;
const MIN_TIMEOUT_MS = 100;
const SAFE_IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._/@:+-]*$/;

export type HarnessContainerExecution = {
  profile: HarnessSandboxProfile;
  /** Image must be pre-provisioned by the operator; the adapter never pulls one. */
  image: string;
  /** Proxy deployment contract: it must enforce allowedHosts by DNS/SNI. */
  egressProxy?: HarnessEgressProxyContract;
};

export type HarnessEgressProxyContract = {
  url: string;
  network: string;
  allowedHosts: string[];
};

export type HarnessContainerExecutionResolution =
  | { configured: false }
  | { configured: true; execution: HarnessContainerExecution }
  | { configured: true; error: string; errorDetail: string };

/**
 * Operator-only rollout switch for existing exec providers.
 *
 * A profile is intentionally incomplete until both the immutable image and the
 * exact command allowlist are supplied. This prevents an environment toggle
 * from accidentally exposing every host binary in a developer workflow.
 */
export function resolveHarnessContainerExecutionFromEnv(
  env: Record<string, string | undefined> = process.env
): HarnessContainerExecutionResolution {
  const profileId = env.QUBIT_HARNESS_EXEC_PROFILE?.trim();
  if (!profileId) return { configured: false };
  const profile = getBuiltinHarnessSandboxProfile(profileId);
  if (!profile || profile.runtime !== "container") {
    return {
      configured: true,
      error: "harness_sandbox_profile_invalid",
      errorDetail: `QUBIT_HARNESS_EXEC_PROFILE must reference a container profile (got: ${profileId})`,
    };
  }
  const image = env.QUBIT_HARNESS_EXEC_IMAGE?.trim();
  if (!image) {
    return {
      configured: true,
      error: "container_image_missing",
      errorDetail:
        "QUBIT_HARNESS_EXEC_IMAGE is required when QUBIT_HARNESS_EXEC_PROFILE is enabled",
    };
  }
  const allowedCommands = (env.QUBIT_HARNESS_EXEC_COMMANDS ?? "")
    .split(",")
    .map((command) => command.trim())
    .filter(Boolean);
  if (allowedCommands.length === 0) {
    return {
      configured: true,
      error: "command_allowlist_missing",
      errorDetail: "QUBIT_HARNESS_EXEC_COMMANDS must list the permitted container commands",
    };
  }
  const allowedHosts = (env.QUBIT_HARNESS_EGRESS_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const proxyUrl = env.QUBIT_HARNESS_EGRESS_PROXY_URL?.trim();
  const proxyNetwork = env.QUBIT_HARNESS_EGRESS_PROXY_NETWORK?.trim();
  if (
    profile.network === "allowlist" &&
    (!proxyUrl || !proxyNetwork || allowedHosts.length === 0)
  ) {
    return {
      configured: true,
      error: "egress_proxy_missing",
      errorDetail:
        "QUBIT_HARNESS_EGRESS_PROXY_URL, QUBIT_HARNESS_EGRESS_PROXY_NETWORK and QUBIT_HARNESS_EGRESS_ALLOWED_HOSTS are required for allowlisted network access",
    };
  }
  if (proxyUrl && !isSafeProxyUrl(proxyUrl)) {
    return {
      configured: true,
      error: "egress_proxy_invalid",
      errorDetail: "proxy URL must be http(s) without credentials",
    };
  }
  if (proxyNetwork && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(proxyNetwork)) {
    return {
      configured: true,
      error: "egress_proxy_network_invalid",
      errorDetail: "proxy network name is invalid",
    };
  }
  return {
    configured: true,
    execution: {
      image,
      profile: { ...profile, allowedCommands, allowedHosts },
      ...(profile.network === "allowlist"
        ? {
            egressProxy: { url: proxyUrl as string, network: proxyNetwork as string, allowedHosts },
          }
        : {}),
    },
  };
}

export type HarnessContainerAdmission =
  | { ok: true }
  | { ok: false; error: string; errorDetail: string };

export function admitHarnessContainerExec(input: {
  execution: HarnessContainerExecution;
  provider: ExecProvider;
  cwd: string;
}): HarnessContainerAdmission {
  const { profile } = input.execution;
  if (profile.runtime !== "container") {
    return deny("container_required", `sandbox profile "${profile.id}" is not a container profile`);
  }
  if (profile.process !== "allowlist") {
    return deny("process_not_allowed", `sandbox profile "${profile.id}" forbids child processes`);
  }
  if (!profile.allowedCommands.includes(input.provider.command)) {
    return deny(
      "command_not_allowlisted",
      `command "${input.provider.command}" is not allowed by sandbox profile "${profile.id}"`
    );
  }
  if (!SAFE_IMAGE.test(input.execution.image)) {
    return deny("container_image_invalid", "container image contains unsupported characters");
  }
  if (!isAbsolute(input.cwd) || !existsSync(input.cwd)) {
    return deny("workspace_unavailable", `container workspace does not exist: ${input.cwd}`);
  }
  if (profile.network === "allowlist" && profile.allowedHosts.length === 0) {
    return deny(
      "network_allowlist_empty",
      "network allowlist profile requires one or more allowed hosts"
    );
  }
  if (profile.network === "allowlist" && !input.execution.egressProxy) {
    return deny(
      "egress_proxy_missing",
      "network allowlists require an operator-provisioned egress proxy"
    );
  }
  return { ok: true };
}

/** Produces Docker argv only; it does not execute or perform an image pull. */
export function buildHarnessContainerExecArgs(input: {
  execution: HarnessContainerExecution;
  provider: ExecProvider;
  args: string[];
  cwd: string;
  containerName: string;
  /** Allows deterministic argument tests; runtime uses the invoking non-root uid. */
  containerUser?: string;
}): string[] {
  const { profile } = input.execution;
  const workspace = resolve(input.cwd);
  const mount =
    profile.filesystem === "read-only"
      ? `type=bind,src=${workspace},dst=/workspace,readonly`
      : `type=bind,src=${workspace},dst=/workspace`;
  return [
    "docker",
    "run",
    "--rm",
    "-i",
    "--name",
    input.containerName,
    "--network",
    input.execution.egressProxy?.network ?? "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    input.containerUser ?? nonRootWorkspaceUser(),
    "--pids-limit",
    String(profile.limits.pidsLimit),
    "--memory",
    `${profile.limits.memoryMiB}m`,
    "--cpus",
    String(profile.limits.cpuCount),
    "--workdir",
    "/workspace",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--mount",
    mount,
    ...(input.execution.egressProxy
      ? [
          "--env",
          `HTTP_PROXY=${input.execution.egressProxy.url}`,
          "--env",
          `HTTPS_PROXY=${input.execution.egressProxy.url}`,
          "--env",
          "NO_PROXY=localhost,127.0.0.1",
          "--env",
          `QUBIT_EGRESS_ALLOWED_HOSTS=${input.execution.egressProxy.allowedHosts.join(",")}`,
        ]
      : []),
    input.execution.image,
    input.provider.command,
    ...input.args,
  ];
}

export async function runHarnessContainerExec(input: {
  execution: HarnessContainerExecution;
  provider: ExecProvider;
  args: string[];
  cwd: string;
  stdinText?: string;
  timeoutMs?: number;
}): Promise<ExecResult> {
  const startedAt = Date.now();
  const admission = admitHarnessContainerExec(input);
  if (!admission.ok) return failed(startedAt, admission.error, admission.errorDetail);

  const containerName = `qubit-hx-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const command = buildHarnessContainerExecArgs({ ...input, containerName });
  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? input.provider.defaultTimeoutMs, MIN_TIMEOUT_MS),
    input.provider.defaultTimeoutMs,
    input.execution.profile.limits.maxWallClockMs
  );

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      cwd: input.cwd,
      // Do not pass host credentials or ambient configuration into the container.
      env: { PATH: process.env.PATH ?? "" },
      stdin: input.stdinText !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return failed(startedAt, "container_unavailable", `Docker spawn failed: ${message(error)}`);
  }

  if (input.stdinText !== undefined && proc.stdin) {
    try {
      const stdin = proc.stdin as { write(data: string): void; end(): void };
      stdin.write(input.stdinText);
      stdin.end();
    } catch {
      // The program may exit before stdin is written.
    }
  }

  const wallTimeoutMs = timeoutMs + WALL_CLOCK_BUFFER_MS;
  const work = Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  const winner = await Promise.race([
    work,
    new Promise<"timeout">((done) => setTimeout(() => done("timeout"), wallTimeoutMs)),
  ]);
  if (winner === "timeout") {
    try {
      Bun.spawn(["docker", "kill", containerName], { stdout: "ignore", stderr: "ignore" });
    } catch {
      // Best effort only; --rm handles cleanup after Docker notices the process exit.
    }
    try {
      proc.kill();
    } catch {
      // Best effort only.
    }
    return failed(
      startedAt,
      "wall_timeout",
      `container killed after ${wallTimeoutMs}ms (timeoutMs=${timeoutMs} + ${WALL_CLOCK_BUFFER_MS}ms buffer)`
    );
  }

  const [stdoutRaw, stderrRaw, exitCode] = winner;
  const limit = Math.min(
    input.provider.maxOutputBytes,
    input.execution.profile.limits.maxOutputBytes
  );
  const totalBytes = Buffer.byteLength(stdoutRaw, "utf-8") + Buffer.byteLength(stderrRaw, "utf-8");
  const truncated = totalBytes > limit;
  return {
    ok: exitCode === 0 && !truncated,
    exitCode,
    stdout: truncated ? truncateUtf8(stdoutRaw, Math.floor(limit * 0.7)) : stdoutRaw,
    stderr: truncated ? truncateUtf8(stderrRaw, Math.floor(limit * 0.3)) : stderrRaw,
    truncated,
    elapsedMs: Date.now() - startedAt,
    ...(truncated
      ? { error: "output_truncated", errorDetail: `output exceeded ${limit} bytes` }
      : exitCode !== 0
        ? { error: "nonzero_exit", errorDetail: `container exit code ${exitCode}` }
        : {}),
  };
}

function deny(error: string, errorDetail: string): HarnessContainerAdmission {
  return { ok: false, error, errorDetail };
}

function isSafeProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function failed(startedAt: number, error: string, errorDetail: string): ExecResult {
  return {
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    truncated: false,
    elapsedMs: Date.now() - startedAt,
    error,
    errorDetail,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(value, "utf-8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString("utf-8")}\n…[truncated]`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Preserve write access to an explicitly mounted workspace without running the
 * container as root. On normal desktop/server installs the current uid/gid owns
 * the workspace. Root-launched hosts intentionally fall back to nobody.
 */
function nonRootWorkspaceUser(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
  if (typeof uid === "number" && uid > 0 && typeof gid === "number" && gid > 0) {
    return `${uid}:${gid}`;
  }
  return "65534:65534";
}
