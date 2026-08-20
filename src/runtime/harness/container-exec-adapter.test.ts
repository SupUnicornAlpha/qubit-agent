import { describe, expect, test } from "bun:test";
import {
  admitHarnessContainerExec,
  buildHarnessContainerExecArgs,
  resolveHarnessContainerExecutionFromEnv,
} from "./container-exec-adapter";
import { getBuiltinHarnessSandboxProfile } from "./sandbox-profile";

const guarded = getBuiltinHarnessSandboxProfile("guarded-container");
if (!guarded) throw new Error("guarded-container profile missing");

const provider = {
  id: "rg",
  kind: "shell" as const,
  description: "test ripgrep",
  command: "rg",
  outputProtocol: "text" as const,
  defaultTimeoutMs: 30_000,
  maxOutputBytes: 64_000,
  envAllowlist: [],
  workdirStrategy: "workflow-scoped" as const,
};

describe("Harness guarded container execution", () => {
  test("builds a no-network, unprivileged, resource-bounded Docker command", () => {
    const args = buildHarnessContainerExecArgs({
      execution: {
        image: "registry.example/qubit-harness:2026.08",
        profile: { ...guarded, allowedCommands: ["rg"] },
      },
      provider,
      args: ["financial-harness", "."],
      cwd: "/tmp/qubit-workspace",
      containerName: "qubit-hx-test",
      containerUser: "65534:65534",
    });
    expect(args.slice(0, 5)).toEqual(["docker", "run", "--rm", "-i", "--name"]);
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("--read-only");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args).toContain("no-new-privileges:true");
    expect(args[args.indexOf("--user") + 1]).toBe("65534:65534");
    expect(args.some((value) => value.includes("dst=/workspace"))).toBe(true);
    expect(args.slice(-3)).toEqual(["rg", "financial-harness", "."]);
  });

  test("rejects commands which the explicit profile has not allowlisted", () => {
    const result = admitHarnessContainerExec({
      execution: { image: "qubit-harness:stable", profile: guarded },
      provider,
      cwd: process.cwd(),
    });
    expect(result).toEqual({
      ok: false,
      error: "command_not_allowlisted",
      errorDetail: 'command "rg" is not allowed by sandbox profile "guarded-container"',
    });
  });

  test("fails closed when an allowlisted container has no proxy contract", () => {
    const result = admitHarnessContainerExec({
      execution: {
        image: "qubit-harness:stable",
        profile: { ...guarded, allowedCommands: ["rg"], allowedHosts: ["api.example.com"] },
      },
      provider,
      cwd: process.cwd(),
    });
    expect(result).toMatchObject({ ok: false, error: "egress_proxy_missing" });
  });

  test("requires an explicit immutable image and command allowlist for rollout", () => {
    expect(
      resolveHarnessContainerExecutionFromEnv({ QUBIT_HARNESS_EXEC_PROFILE: "guarded-container" })
    ).toMatchObject({ configured: true, error: "container_image_missing" });
    expect(
      resolveHarnessContainerExecutionFromEnv({
        QUBIT_HARNESS_EXEC_PROFILE: "guarded-container",
        QUBIT_HARNESS_EXEC_IMAGE: "qubit-harness:stable",
      })
    ).toMatchObject({ configured: true, error: "command_allowlist_missing" });
    expect(
      resolveHarnessContainerExecutionFromEnv({
        QUBIT_HARNESS_EXEC_PROFILE: "guarded-container",
        QUBIT_HARNESS_EXEC_IMAGE: "qubit-harness:stable",
        QUBIT_HARNESS_EXEC_COMMANDS: "rg,git",
      })
    ).toMatchObject({ configured: true, error: "egress_proxy_missing" });
    const resolution = resolveHarnessContainerExecutionFromEnv({
      QUBIT_HARNESS_EXEC_PROFILE: "guarded-container",
      QUBIT_HARNESS_EXEC_IMAGE: "qubit-harness:stable",
      QUBIT_HARNESS_EXEC_COMMANDS: "rg,git",
      QUBIT_HARNESS_EGRESS_PROXY_URL: "http://qubit-egress:3128",
      QUBIT_HARNESS_EGRESS_PROXY_NETWORK: "qubit-egress",
      QUBIT_HARNESS_EGRESS_ALLOWED_HOSTS: "api.example.com,files.example.com",
    });
    expect(resolution).toMatchObject({
      configured: true,
      execution: {
        image: "qubit-harness:stable",
        profile: {
          allowedCommands: ["rg", "git"],
          allowedHosts: ["api.example.com", "files.example.com"],
        },
      },
    });
    if ("execution" in resolution) {
      const args = buildHarnessContainerExecArgs({
        execution: resolution.execution,
        provider,
        args: ["--version"],
        cwd: "/tmp/qubit-workspace",
        containerName: "qubit-hx-proxy",
      });
      expect(args[args.indexOf("--network") + 1]).toBe("qubit-egress");
      expect(args).toContain("HTTPS_PROXY=http://qubit-egress:3128");
    }
  });
});
