import { describe, expect, test } from "bun:test";
import { resolveReviewedHarnessRunner } from "./reviewed-runner";

const provider = {
  id: "pdf-renderer",
  kind: "shell" as const,
  description: "test",
  command: "render-pdf",
  outputProtocol: "text" as const,
  defaultTimeoutMs: 10_000,
  maxOutputBytes: 1_024,
  envAllowlist: [],
  workdirStrategy: "workflow-scoped" as const,
};

describe("reviewed Harness runner", () => {
  test("refuses a configured runner until its container policy is complete", () => {
    const result = resolveReviewedHarnessRunner(provider, {
      QUBIT_HARNESS_REVIEWED_RUNNERS_JSON: JSON.stringify([
        {
          runnerId: "pdf-v1",
          providerId: "pdf-renderer",
          packageId: "example.docs",
          enabled: true,
          requiredApproval: "command-execution",
        },
      ]),
    });
    expect(result).toMatchObject({ configured: true, error: "reviewed_runner_container_required" });
  });

  test("binds approved providers to a guarded container instead of host execution", () => {
    const result = resolveReviewedHarnessRunner(provider, {
      QUBIT_HARNESS_REVIEWED_RUNNERS_JSON: JSON.stringify([
        {
          runnerId: "pdf-v1",
          providerId: "pdf-renderer",
          packageId: "example.docs",
          enabled: true,
          requiredApproval: "command-execution",
        },
      ]),
      QUBIT_HARNESS_EXEC_PROFILE: "guarded-container",
      QUBIT_HARNESS_EXEC_IMAGE: "qubit-pdf:1.0.0",
      QUBIT_HARNESS_EXEC_COMMANDS: "render-pdf",
      QUBIT_HARNESS_EGRESS_PROXY_URL: "http://qubit-egress:3128",
      QUBIT_HARNESS_EGRESS_PROXY_NETWORK: "qubit-egress",
      QUBIT_HARNESS_EGRESS_ALLOWED_HOSTS: "fonts.example.com",
    });
    expect(result).toMatchObject({ configured: true, execution: { image: "qubit-pdf:1.0.0" } });
  });
});
