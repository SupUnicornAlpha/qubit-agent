/**
 * Persist Strategy API V2 source after successful compile (Prime 06 / QuantDinger loop).
 * Writes indicator_strategy_script so Team / Script Studio can edit & re-run.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import {
  indicatorStrategyScript,
  workflowRun,
} from "../../../db/sqlite/schema";
import { exportStrategyScriptToWorkflowDir } from "../strategy-script-files";
import type { StrategyManifestV2 } from "./contract-service";

export type PersistCompiledScriptInput = {
  code: string;
  manifest: StrategyManifestV2;
  /** Prefer explicit session; else resolve from workflowRunId */
  sessionId?: string | null;
  workflowRunId?: string | null;
  /** Update existing row when provided */
  scriptId?: string | null;
  name?: string | null;
};

export type PersistCompiledScriptResult =
  | {
      persisted: true;
      scriptId: string;
      name: string;
      created: boolean;
      artifactDir?: string;
    }
  | { persisted: false; reason: string };

function inferScriptName(
  code: string,
  manifest: StrategyManifestV2,
  explicit?: string | null
): string {
  const fromParam = String(explicit ?? "").trim();
  if (fromParam) return fromParam.slice(0, 80);
  const metaName = manifest.metadata?.name;
  if (typeof metaName === "string" && metaName.trim()) {
    return metaName.trim().slice(0, 80);
  }
  const m = code.match(/set_metadata\s*\(\s*name\s*=\s*["']([^"']+)["']/);
  if (m?.[1]) return m[1].slice(0, 80);
  const hash = manifest.codeHash?.slice(0, 8) || "script";
  return `strategy_api_${hash}`;
}

export async function persistCompiledStrategyScript(
  input: PersistCompiledScriptInput
): Promise<PersistCompiledScriptResult> {
  const code = input.code.trim();
  if (!code) return { persisted: false, reason: "empty_code" };

  const db = await getDb();
  let sessionId = String(input.sessionId ?? "").trim();
  const workflowRunId = String(input.workflowRunId ?? "").trim() || null;
  let projectId: string | null = null;

  if (workflowRunId) {
    const wf = (
      await db
        .select({
          sessionId: workflowRun.sessionId,
          projectId: workflowRun.projectId,
        })
        .from(workflowRun)
        .where(eq(workflowRun.id, workflowRunId))
        .limit(1)
    )[0];
    if (!wf) return { persisted: false, reason: "workflow_not_found" };
    projectId = wf.projectId;
    if (!sessionId) sessionId = String(wf.sessionId ?? "").trim();
  }

  if (!sessionId) {
    return { persisted: false, reason: "no_session" };
  }

  const name = inferScriptName(code, input.manifest, input.name);
  const now = new Date().toISOString();
  const chartSnapshot = {
    strategyApiV2: true,
    codeHash: input.manifest.codeHash,
    manifest: input.manifest,
    persistedAt: now,
  };
  const chartJson = JSON.stringify(chartSnapshot);

  const explicitId = String(input.scriptId ?? "").trim();
  if (explicitId) {
    const existing = (
      await db
        .select()
        .from(indicatorStrategyScript)
        .where(eq(indicatorStrategyScript.id, explicitId))
        .limit(1)
    )[0];
    if (!existing) return { persisted: false, reason: "script_not_found" };
    await db
      .update(indicatorStrategyScript)
      .set({
        name,
        ideCode: code,
        signalCode: code,
        workflowRunId: workflowRunId ?? existing.workflowRunId,
        chartSnapshotJson: chartJson,
        purpose: "both",
        updatedAt: now,
      })
      .where(eq(indicatorStrategyScript.id, explicitId));
    let artifactDir: string | undefined;
    if (projectId && (workflowRunId || existing.workflowRunId)) {
      const exported = await exportStrategyScriptToWorkflowDir({
        projectId,
        workflowRunId: (workflowRunId || existing.workflowRunId)!,
        scriptId: explicitId,
        name,
        ideCode: code,
        signalCode: code,
      });
      artifactDir = exported.scriptDir;
    }
    return {
      persisted: true,
      scriptId: explicitId,
      name,
      created: false,
      artifactDir,
    };
  }

  // Upsert by workflow + codeHash when possible (avoid script spam on re-compile).
  if (workflowRunId) {
    const siblings = await db
      .select()
      .from(indicatorStrategyScript)
      .where(
        and(
          eq(indicatorStrategyScript.sessionId, sessionId),
          eq(indicatorStrategyScript.workflowRunId, workflowRunId)
        )
      );
    const match = siblings.find((row) => {
      try {
        const snap = JSON.parse(String(row.chartSnapshotJson || "{}")) as {
          codeHash?: string;
        };
        return snap.codeHash === input.manifest.codeHash;
      } catch {
        return false;
      }
    });
    if (match) {
      await db
        .update(indicatorStrategyScript)
        .set({
          name,
          ideCode: code,
          signalCode: code,
          chartSnapshotJson: chartJson,
          purpose: "both",
          updatedAt: now,
        })
        .where(eq(indicatorStrategyScript.id, match.id));
      let artifactDir: string | undefined;
      if (projectId) {
        const exported = await exportStrategyScriptToWorkflowDir({
          projectId,
          workflowRunId,
          scriptId: match.id,
          name,
          ideCode: code,
          signalCode: code,
        });
        artifactDir = exported.scriptDir;
      }
      return {
        persisted: true,
        scriptId: match.id,
        name,
        created: false,
        artifactDir,
      };
    }
  }

  const id = randomUUID();
  await db.insert(indicatorStrategyScript).values({
    id,
    sessionId,
    workflowRunId,
    name,
    ideCode: code,
    signalCode: code,
    aiPromptSnapshot: null,
    chartSnapshotJson: chartJson,
    purpose: "both",
    createdAt: now,
    updatedAt: now,
  });

  let artifactDir: string | undefined;
  if (projectId && workflowRunId) {
    const exported = await exportStrategyScriptToWorkflowDir({
      projectId,
      workflowRunId,
      scriptId: id,
      name,
      ideCode: code,
      signalCode: code,
    });
    artifactDir = exported.scriptDir;
  }

  return {
    persisted: true,
    scriptId: id,
    name,
    created: true,
    artifactDir,
  };
}
