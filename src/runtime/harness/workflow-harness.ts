import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { parseLoopOptionsJson } from "../../types/loop";
import { resolveRegistryScenarioKey } from "../research-scenario/scenario-key-aliases";
import { createBuiltinFinancialHarnessRegistry } from "./builtin-financial-capabilities";
import type { CapabilityScopeLease } from "./capability-registry";
import type { ReasoningHarnessMode } from "./reasoning-harness";

export const MATH_AUDIT_PROFILE_ID = "math-audit";
export const MATH_DERIVATION_VERIFY_TOOL = "math.derivation.verify";
export const QUANT_RESEARCH_INTEGRITY_PROFILE_ID = "quant-research-integrity";

export type WorkflowHarnessLeaseSource = "workflow_config" | "research_scenario" | "workflow_mode";
/** @deprecated Use WorkflowHarnessLeaseSource for new workflow-scoped profiles. */
export type MathHarnessLeaseSource = WorkflowHarnessLeaseSource;

export type MathHarnessLease = {
  profileId: typeof MATH_AUDIT_PROFILE_ID;
  mode: Exclude<ReasoningHarnessMode, "off">;
  reason: string;
  source: WorkflowHarnessLeaseSource;
  workflowKind: string | null;
};

export type ResearchIntegrityHarnessLease = {
  profileId: typeof QUANT_RESEARCH_INTEGRITY_PROFILE_ID;
  mode: Exclude<ReasoningHarnessMode, "off">;
  reason: string;
  source: WorkflowHarnessLeaseSource;
  workflowKind: string | null;
};

export type WorkflowHarnessAdmission = {
  math: MathHarnessLease | null;
  researchIntegrity: ResearchIntegrityHarnessLease | null;
};

type WorkflowHarnessInput = {
  mode: string | null | undefined;
  researchScenarioId: string | null | undefined;
  loopOptionsJson: unknown;
  status?: string | null | undefined;
};

const TERMINAL_WORKFLOW_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const MATH_REQUIRED_SCENARIOS = new Set([
  "factor_research",
  "strategy_authoring",
  "rule_research",
  "portfolio_management",
  "risk_review",
  "discovery",
  "live_trading",
]);

const RESEARCH_INTEGRITY_SCENARIOS = new Set([
  "factor_research",
  "strategy_authoring",
  "rule_research",
  "portfolio_management",
  "risk_review",
  "discovery",
  "live_trading",
]);

type ActiveWorkflowHarnessLease = { fingerprint: string; lease: CapabilityScopeLease };
type WorkflowLeaseMap = Map<string, ActiveWorkflowHarnessLease>;
const activeWorkflowHarnessLeases = new Map<string, WorkflowLeaseMap>();

function hasMode(value: string | null | undefined): value is Exclude<ReasoningHarnessMode, "off"> {
  return value === "advisory" || value === "required";
}

/**
 * Pure admission policy. It uses only persisted structured workflow metadata,
 * workflow mode and registered scenario keys; it never examines user prose.
 */
export function resolveWorkflowHarnessAdmission(
  input: WorkflowHarnessInput
): WorkflowHarnessAdmission {
  if (input.status && TERMINAL_WORKFLOW_STATUSES.has(input.status)) {
    return { math: null, researchIntegrity: null };
  }
  const options = parseLoopOptionsJson(input.loopOptionsJson);
  const workflowKind =
    resolveRegistryScenarioKey(input.researchScenarioId) ?? input.researchScenarioId ?? null;
  const configuredMath = options.harness?.mathAudit;
  const math: MathHarnessLease | null = configuredMath
    ? hasMode(configuredMath.mode)
      ? {
          profileId: MATH_AUDIT_PROFILE_ID,
          mode: configuredMath.mode,
          reason: configuredMath.reason,
          source: "workflow_config" as const,
          workflowKind,
        }
      : null
    : workflowKind && MATH_REQUIRED_SCENARIOS.has(workflowKind)
      ? {
          profileId: MATH_AUDIT_PROFILE_ID,
          mode: "required" as const,
          reason: `research_scenario:${workflowKind}`,
          source: "research_scenario" as const,
          workflowKind,
        }
      : input.mode === "backtest"
        ? {
            profileId: MATH_AUDIT_PROFILE_ID,
            mode: "required" as const,
            reason: "workflow_mode:backtest",
            source: "workflow_mode" as const,
            workflowKind,
          }
        : null;

  const configuredIntegrity = options.harness?.researchIntegrity;
  const researchIntegrity: ResearchIntegrityHarnessLease | null = configuredIntegrity
    ? hasMode(configuredIntegrity.mode)
      ? {
          profileId: QUANT_RESEARCH_INTEGRITY_PROFILE_ID,
          mode: configuredIntegrity.mode,
          reason: configuredIntegrity.reason,
          source: "workflow_config" as const,
          workflowKind,
        }
      : null
    : workflowKind && RESEARCH_INTEGRITY_SCENARIOS.has(workflowKind)
      ? {
          profileId: QUANT_RESEARCH_INTEGRITY_PROFILE_ID,
          // Research produces a visible evidence-gap report; Host-side
          // promotion/execution gates remain independently required.
          mode: "advisory" as const,
          reason: `research_scenario:${workflowKind}`,
          source: "research_scenario" as const,
          workflowKind,
        }
      : input.mode === "backtest" || input.mode === "simulation" || input.mode === "live"
        ? {
            profileId: QUANT_RESEARCH_INTEGRITY_PROFILE_ID,
            mode: "required" as const,
            reason: `workflow_mode:${input.mode}`,
            source: "workflow_mode" as const,
            workflowKind,
          }
        : null;
  return { math, researchIntegrity };
}

export async function loadWorkflowHarnessAdmission(
  workflowId: string
): Promise<WorkflowHarnessAdmission> {
  try {
    const db = await getDb();
    const rows = await db
      .select({
        mode: workflowRun.mode,
        researchScenarioId: workflowRun.researchScenarioId,
        loopOptionsJson: workflowRun.loopOptionsJson,
        status: workflowRun.status,
      })
      .from(workflowRun)
      .where(eq(workflowRun.id, workflowId))
      .limit(1);
    const workflow = rows[0];
    if (!workflow) return { math: null, researchIntegrity: null };
    return resolveWorkflowHarnessAdmission(workflow);
  } catch {
    // Storage/readiness failures must never turn a normal task into an
    // admitted mathematical decision workflow.
    return { math: null, researchIntegrity: null };
  }
}

/**
 * Acquires one workflow-scoped lease at most once. The current math plugin is
 * declarative, but using a real lease now keeps its future evaluators and
 * optional MCP/SymPy resources behind the same lifecycle boundary.
 */
export async function acquireWorkflowMathHarnessLease(
  workflowId: string
): Promise<MathHarnessLease | null> {
  const admission = await loadWorkflowHarnessAdmission(workflowId);
  return acquireWorkflowProfileLease(workflowId, MATH_AUDIT_PROFILE_ID, admission.math);
}

/**
 * Loads only the audit composition for this workflow. An explicit `off`
 * removes the composition and its trace projection, but cannot turn off the
 * Host-owned promotion/live gates that consume the same evidence.
 */
export async function acquireWorkflowResearchIntegrityHarnessLease(
  workflowId: string
): Promise<ResearchIntegrityHarnessLease | null> {
  const admission = await loadWorkflowHarnessAdmission(workflowId);
  return acquireWorkflowProfileLease(
    workflowId,
    QUANT_RESEARCH_INTEGRITY_PROFILE_ID,
    admission.researchIntegrity
  );
}

async function acquireWorkflowProfileLease<
  T extends { profileId: string; mode: string; reason: string },
>(workflowId: string, expectedProfileId: string, admission: T | null): Promise<T | null> {
  const active = activeWorkflowHarnessLeases.get(workflowId);
  const current = active?.get(expectedProfileId);
  const fingerprint = admission
    ? `${admission.profileId}:${admission.mode}:${admission.reason}`
    : null;
  if (!admission || admission.profileId !== expectedProfileId || !fingerprint) {
    if (current) await releaseWorkflowProfileLease(workflowId, expectedProfileId);
    return null;
  }
  if (current?.fingerprint === fingerprint && !current.lease.disposed) return admission;
  if (current) await releaseWorkflowProfileLease(workflowId, expectedProfileId);
  const registry = createBuiltinFinancialHarnessRegistry();
  const lease = await registry.activate({
    profileId: expectedProfileId,
    scope: { kind: "workflow", id: workflowId },
  });
  const leases = activeWorkflowHarnessLeases.get(workflowId) ?? new Map();
  leases.set(expectedProfileId, { fingerprint, lease });
  activeWorkflowHarnessLeases.set(workflowId, leases);
  return admission;
}

async function releaseWorkflowProfileLease(workflowId: string, profileId: string): Promise<void> {
  const leases = activeWorkflowHarnessLeases.get(workflowId);
  const active = leases?.get(profileId);
  if (!active) return;
  leases?.delete(profileId);
  if (leases?.size === 0) activeWorkflowHarnessLeases.delete(workflowId);
  await active.lease.dispose();
}

/** Release resources on workflow terminal/reuse. Safe and idempotent. */
export async function releaseWorkflowHarnessLease(workflowId: string): Promise<void> {
  const leases = activeWorkflowHarnessLeases.get(workflowId);
  if (!leases) return;
  const profileIds = [...leases.keys()];
  const errors: unknown[] = [];
  for (const profileId of profileIds) {
    try {
      await releaseWorkflowProfileLease(workflowId, profileId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Workflow Harness lease release failed.");
}

/** Test-only visibility; it does not expose a mutable global registry. */
export function isWorkflowMathHarnessLeaseActiveForTest(workflowId: string): boolean {
  const active = activeWorkflowHarnessLeases.get(workflowId)?.get(MATH_AUDIT_PROFILE_ID);
  return Boolean(active && !active.lease.disposed);
}

/** Test-only visibility for the workflow-scoped integrity profile. */
export function isWorkflowResearchIntegrityHarnessLeaseActiveForTest(workflowId: string): boolean {
  const active = activeWorkflowHarnessLeases
    .get(workflowId)
    ?.get(QUANT_RESEARCH_INTEGRITY_PROFILE_ID);
  return Boolean(active && !active.lease.disposed);
}
