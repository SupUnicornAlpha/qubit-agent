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
  const db = input.client ?? (await getDb());
  const components = await readWorkflowComponents(db, input.workflowRunId, input.configFingerprint);
  if (components.length === 0) return 0;
  const existing = await db
    .select({
      componentKind: componentEvalRun.componentKind,
      componentId: componentEvalRun.componentId,
      versionId: componentEvalRun.versionId,
      comparisonCohortId: componentEvalRun.comparisonCohortId,
    })
    .from(componentEvalRun)
    .where(eq(componentEvalRun.workflowRunId, input.workflowRunId));
  const existingKeys = new Set(
    existing.map(
      (row) =>
        `${row.componentKind}\u0000${row.componentId}\u0000${row.versionId}\u0000${row.comparisonCohortId ?? ""}`
    )
  );
  let written = 0;
  for (const component of components) {
    const key = `${component.componentKind}\u0000${component.componentId}\u0000${component.versionId}\u0000${input.comparisonCohortId}`;
    if (existingKeys.has(key)) continue;
    await componentChallengerService.record(
      {
        projectId: input.projectId,
        workflowRunId: input.workflowRunId,
        ...component,
        comparisonCohortId: input.comparisonCohortId,
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
  harnessVersion: string
): Promise<CapturedComponent[]> {
  const [agents, models, tools, skills, harnesses, dataSources] = await Promise.all([
    db
      .select({ id: agentDefinition.id, version: agentDefinition.version })
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
      row.profileId && row.profileId !== "unprofiled"
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
