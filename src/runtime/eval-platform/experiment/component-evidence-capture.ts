import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type DbClient, getDb } from "../../../db/sqlite/client";
import {
  agentDefinition,
  agentInstance,
  agentSkill,
  agentSkillRun,
  backtestRun,
  componentEvalRun,
  harnessEventLedger,
  llmCallLog,
  toolCallLog,
} from "../../../db/sqlite/schema";
import {
  type GovernedComponentKind,
  componentChallengerService,
} from "../../governance/component-challenger-service";
import { getMarketSnapshotById } from "../../market/contracts/market-snapshot-service";

type CapturedComponent = {
  componentKind: GovernedComponentKind;
  componentId: string;
  versionId: string;
};

export type WorkflowComponentEvidenceInput = {
  projectId: string;
  workflowRunId: string;
  comparisonCohortId: string;
  /** A frozen experiment/config fingerprint; omit to avoid claiming a Harness version. */
  harnessVersion?: string | null;
  evalKind: "offline" | "shadow" | "paper";
  sampleSize: number;
  metrics: Record<string, unknown>;
  qualityScore: number;
  pass: boolean;
  createdBy: string;
  client?: DbClient;
};

/**
 * Converts a frozen experiment case into component evidence. This deliberately
 * records only `offline`: experiment output is reproducible evidence, but it
 * is not shadow/paper evidence and therefore cannot by itself promote a
 * production component.
 */
export async function captureExperimentComponentEvidence(input: {
  projectId: string;
  evalRunId: string;
  workflowRunId: string;
  caseKey: string;
  comparisonCohortId: string;
  configFingerprint: string;
  score: number;
  pass: boolean;
  client?: DbClient;
}): Promise<number> {
  return captureWorkflowComponentEvidence({
    projectId: input.projectId,
    workflowRunId: input.workflowRunId,
    comparisonCohortId: input.comparisonCohortId,
    harnessVersion: input.configFingerprint,
    evalKind: "offline",
    sampleSize: 1,
    metrics: {
      source: "eval_platform_experiment",
      evalRunId: input.evalRunId,
      caseKey: input.caseKey,
      configFingerprint: input.configFingerprint,
      score: input.score,
    },
    qualityScore: input.score,
    pass: input.pass,
    createdBy: "eval_platform:component_capture",
    ...(input.client ? { client: input.client } : {}),
  });
}

/**
 * Shared capture path for trusted evaluators. The public governance route is
 * intentionally not allowed to mint paper/shadow rows. Each component can
 * contribute once per workflow, frozen cohort and evaluation stage, preventing
 * repeated UI clicks from inflating its sample size.
 */
export async function captureWorkflowComponentEvidence(
  input: WorkflowComponentEvidenceInput
): Promise<number> {
  const db = input.client ?? (await getDb());
  const cohort = input.comparisonCohortId.trim();
  if (!cohort) throw new Error("component_comparison_cohort_required");
  const components = await readWorkflowComponents(
    db,
    input.workflowRunId,
    input.harnessVersion?.trim() || null
  );
  if (components.length === 0) return 0;
  const existing = await db
    .select({
      componentKind: componentEvalRun.componentKind,
      componentId: componentEvalRun.componentId,
      versionId: componentEvalRun.versionId,
      comparisonCohortId: componentEvalRun.comparisonCohortId,
      evalKind: componentEvalRun.evalKind,
    })
    .from(componentEvalRun)
    .where(eq(componentEvalRun.workflowRunId, input.workflowRunId));
  const existingKeys = new Set(
    existing.map(
      (row) =>
        `${row.componentKind}\u0000${row.componentId}\u0000${row.versionId}\u0000${row.comparisonCohortId ?? ""}\u0000${row.evalKind}`
    )
  );
  let written = 0;
  for (const component of components) {
    const key = `${component.componentKind}\u0000${component.componentId}\u0000${component.versionId}\u0000${cohort}\u0000${input.evalKind}`;
    if (existingKeys.has(key)) continue;
    await componentChallengerService.record(
      {
        projectId: input.projectId,
        workflowRunId: input.workflowRunId,
        ...component,
        comparisonCohortId: cohort,
        evalKind: input.evalKind,
        sampleSize: Math.max(0, Math.floor(input.sampleSize)),
        metrics: input.metrics,
        qualityScore: input.qualityScore,
        pass: input.pass,
        createdBy: input.createdBy,
      },
      db
    );
    existingKeys.add(key);
    written += 1;
  }
  return written;
}

async function readWorkflowComponents(
  db: DbClient,
  workflowRunId: string,
  harnessVersion: string | null
): Promise<CapturedComponent[]> {
  const [agents, models, tools, skills, harnesses, dataSources] = await Promise.all([
    db
      .select({
        id: agentDefinition.id,
        version: agentDefinition.version,
        systemPrompt: agentDefinition.systemPrompt,
      })
      .from(agentInstance)
      .innerJoin(agentDefinition, eq(agentDefinition.id, agentInstance.definitionId))
      .where(eq(agentInstance.workflowRunId, workflowRunId)),
    db
      .select({ provider: llmCallLog.provider, model: llmCallLog.model })
      .from(llmCallLog)
      .where(eq(llmCallLog.workflowRunId, workflowRunId)),
    db
      .select({ name: toolCallLog.toolName, kind: toolCallLog.toolKind })
      .from(toolCallLog)
      .where(eq(toolCallLog.workflowRunId, workflowRunId)),
    db
      .select({ id: agentSkill.id, version: agentSkill.version })
      .from(agentSkillRun)
      .innerJoin(agentSkill, eq(agentSkill.id, agentSkillRun.skillId))
      .where(eq(agentSkillRun.workflowRunId, workflowRunId)),
    db
      .select({ profileId: harnessEventLedger.profileId })
      .from(harnessEventLedger)
      .where(
        and(
          eq(harnessEventLedger.workflowRunId, workflowRunId),
          eq(harnessEventLedger.eventType, "capability.composed")
        )
      ),
    readFrozenDataSources(db, workflowRunId),
  ]);
  const components: CapturedComponent[] = [
    ...agents.map((row) => ({
      componentKind: "agent" as const,
      componentId: row.id,
      versionId: row.version,
    })),
    // Prompts are a separately governed component. Definition version alone
    // is insufficient because a user override can change prompt content
    // without changing the agent release tag.
    ...agents.map((row) => ({
      componentKind: "prompt" as const,
      componentId: row.id,
      versionId: promptContentFingerprint(row.systemPrompt),
    })),
    ...models.map((row) => ({
      componentKind: "model" as const,
      componentId: row.provider,
      versionId: row.model,
    })),
    ...tools.map((row) => ({
      componentKind: "tool" as const,
      componentId: row.name,
      versionId: row.kind,
    })),
    ...skills.map((row) => ({
      componentKind: "skill" as const,
      componentId: row.id,
      versionId: row.version,
    })),
    ...harnesses.flatMap((row) =>
      harnessVersion && row.profileId && row.profileId !== "unprofiled"
        ? [
            {
              componentKind: "harness" as const,
              componentId: row.profileId,
              versionId: harnessVersion,
            },
          ]
        : []
    ),
    ...dataSources,
  ];
  const unique = new Map<string, CapturedComponent>();
  for (const component of components) {
    unique.set(
      `${component.componentKind}\u0000${component.componentId}\u0000${component.versionId}`,
      component
    );
  }
  return [...unique.values()];
}

function promptContentFingerprint(systemPrompt: string): string {
  return `prompt_sha256_${createHash("sha256").update(systemPrompt).digest("hex").slice(0, 24)}`;
}

/**
 * Data-source evidence is admitted only from a persisted backtest snapshot.
 * A source version is the immutable snapshot id, not an inferred provider
 * label; therefore two revisions cannot silently enter the same comparison.
 */
async function readFrozenDataSources(
  db: DbClient,
  workflowRunId: string
): Promise<CapturedComponent[]> {
  const runs = await db
    .select({ datasetSnapshotId: backtestRun.datasetSnapshotId })
    .from(backtestRun)
    .where(eq(backtestRun.workflowRunId, workflowRunId));
  const sourceSets = await Promise.all(
    runs.map(async (run) => {
      try {
        const snapshot = await getMarketSnapshotById(run.datasetSnapshotId);
        return snapshot
          ? snapshot.meta.sourceIds.map((sourceId) => ({
              componentKind: "data_source" as const,
              componentId: sourceId,
              versionId: run.datasetSnapshotId,
            }))
          : [];
      } catch {
        // Missing snapshot storage is incomplete evidence, never a fallback to
        // a mutable provider label.
        return [];
      }
    })
  );
  return sourceSets.flat();
}
