/**
 * Operator-reviewed executable extension registry.
 *
 * A signed declarative package may reference an `exec-provider`, but it can
 * never supply the command/image itself. Commands are admitted only when an
 * operator separately lists a matching registered ExecProvider in this JSON
 * policy. Every admitted runner uses the guarded container adapter and keeps
 * its side-effect approval in the existing Core/HITL pipeline.
 */
import type { ExecProvider } from "../exec/types";
import {
  type HarnessContainerExecution,
  resolveHarnessContainerExecutionFromEnv,
} from "./container-exec-adapter";

type ReviewedRunnerRecord = {
  runnerId: string;
  providerId: string;
  packageId: string;
  enabled: boolean;
  requiredApproval: "command-execution" | "external-plugin";
};

export type ReviewedRunnerResolution =
  | { configured: false }
  | { configured: true; execution: HarnessContainerExecution; runner: ReviewedRunnerRecord }
  | { configured: true; error: string; errorDetail: string };

export function resolveReviewedHarnessRunner(
  provider: ExecProvider,
  env: Record<string, string | undefined> = process.env
): ReviewedRunnerResolution {
  const raw = env.QUBIT_HARNESS_REVIEWED_RUNNERS_JSON;
  if (!raw) return { configured: false };
  let records: ReviewedRunnerRecord[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("must be an array");
    records = parsed.filter(isReviewedRunnerRecord);
    if (records.length !== parsed.length) throw new Error("contains invalid record");
  } catch (error) {
    return {
      configured: true,
      error: "reviewed_runner_policy_invalid",
      errorDetail: `QUBIT_HARNESS_REVIEWED_RUNNERS_JSON ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const runner = records.find((record) => record.providerId === provider.id);
  if (!runner) return { configured: false };
  if (!runner.enabled) {
    return {
      configured: true,
      error: "reviewed_runner_disabled",
      errorDetail: `runner ${runner.runnerId} is disabled by operator policy`,
    };
  }
  const container = resolveHarnessContainerExecutionFromEnv(env);
  if (!container.configured || "error" in container) {
    return {
      configured: true,
      error: "reviewed_runner_container_required",
      errorDetail:
        "reviewed runners require a valid QUBIT_HARNESS_EXEC_PROFILE/Image/Commands container configuration",
    };
  }
  if (!container.execution.profile.allowedCommands.includes(provider.command)) {
    return {
      configured: true,
      error: "reviewed_runner_command_unapproved",
      errorDetail: `runner ${runner.runnerId} cannot execute unapproved command ${provider.command}`,
    };
  }
  return { configured: true, execution: container.execution, runner };
}

function isReviewedRunnerRecord(value: unknown): value is ReviewedRunnerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    ["runnerId", "providerId", "packageId"].every(
      (key) => typeof record[key] === "string" && Boolean((record[key] as string).trim())
    ) &&
    typeof record.enabled === "boolean" &&
    (record.requiredApproval === "command-execution" ||
      record.requiredApproval === "external-plugin")
  );
}
