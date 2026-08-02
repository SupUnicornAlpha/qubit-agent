import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { analystSignal, workflowRun } from "../../db/sqlite/schema";
import type { AgentRole, AnalystSignalValue } from "../../types/entities";
import { resolveAgentControlMode } from "../../types/loop";
import {
  type AgentPlanSnapshot,
  type AgentPlanStepStatus,
  parseAgentPlanSnapshot,
} from "../agent-control-mode";
import { summarizeTeamDecision } from "../msa/analyst-team-pipeline";
import {
  buildParsedResearchTeamFromToolParams,
  runResearchTeamFromOrchestrator,
} from "../msa/research-team-execute";
import { type RawAnalystSignal, fuseSignals } from "../msa/signal-fusion";
import { dispatchTeamAgentTask } from "../orchestration/team-dispatch-adapter";
import { getStepStreamPorts } from "../ports/step-stream";
import { parseHitlApproval } from "../workflow/hitl-service";
import { writeWorkflowPlanArtifacts } from "../workflow/plan-artifact";
import type { BuiltinToolHandler } from "./types";

/** Handlers that coordinate workflow state or a team of agents. */
export const ORCHESTRATION_HANDLERS: Record<string, BuiltinToolHandler> = {
  update_plan: async (ctx, params) => {
    if (ctx.definition.role !== "orchestrator") {
      throw new Error("update_plan: only the workflow orchestrator may update the shared plan");
    }
    const db = await getDb();
    const workflowMeta = (
      await db
        .select({
          projectId: workflowRun.projectId,
          goal: workflowRun.goal,
          loopOptionsJson: workflowRun.loopOptionsJson,
          planJson: workflowRun.planJson,
        })
        .from(workflowRun)
        .where(eq(workflowRun.id, ctx.workflowId))
        .limit(1)
    )[0];
    if (!workflowMeta) throw new Error(`update_plan: workflow not found: ${ctx.workflowId}`);
    const mode = resolveAgentControlMode(workflowMeta.loopOptionsJson);
    const rawSteps = Array.isArray(params.steps) ? params.steps : [];
    const allowed = new Set<AgentPlanStepStatus>(["pending", "in_progress", "done", "skipped"]);
    const steps: Array<{ id: string; title: string; status: AgentPlanStepStatus; note?: string }> =
      [];
    for (let i = 0; i < rawSteps.length && steps.length < 20; i++) {
      const rawStep = (rawSteps[i] ?? {}) as Record<string, unknown>;
      const title = String(rawStep.title ?? rawStep.text ?? "").trim();
      if (!title) continue;
      const requestedStatus = String(rawStep.status ?? "pending").trim();
      // Plan 模式只设计未来动作，不能把尚未执行的步骤伪装成 done。
      const normalizedStatus = allowed.has(requestedStatus as AgentPlanStepStatus)
        ? (requestedStatus as AgentPlanStepStatus)
        : "pending";
      const status: AgentPlanStepStatus = mode === "plan" ? "pending" : normalizedStatus;
      const note = rawStep.note != null ? String(rawStep.note).slice(0, 300) : undefined;
      steps.push({
        id: (String(rawStep.id ?? "").trim() || `s${i + 1}`).slice(0, 40),
        title: title.slice(0, 200),
        status,
        ...(note ? { note } : {}),
      });
    }
    const completedSteps = steps.filter((step) => step.status === "done").length;
    const skippedSteps = steps.filter((step) => step.status === "skipped").length;
    const hasActive = steps.some((step) => step.status === "in_progress");
    const allTerminal = steps.length > 0 && completedSteps + skippedSteps === steps.length;
    const previousPlan = parseAgentPlanSnapshot(workflowMeta.planJson);
    const normalizeGoalList = (
      value: unknown,
      fallback: string[] | undefined
    ): string[] | undefined => {
      if (!Array.isArray(value)) return fallback;
      const result = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 10);
      return result.length > 0 ? result : fallback;
    };
    const successCriteria = normalizeGoalList(
      params.successCriteria ?? params.success_criteria,
      previousPlan?.goal?.successCriteria
    );
    const constraints = normalizeGoalList(params.constraints, previousPlan?.goal?.constraints);
    const goalStatus =
      mode === "goal"
        ? allTerminal
          ? completedSteps > 0
            ? "executing"
            : "blocked"
          : hasActive || completedSteps > 0
            ? "executing"
            : "planning"
        : "planning";
    const plan: AgentPlanSnapshot = {
      mode,
      goal: {
        text: workflowMeta.goal,
        status: goalStatus,
        completedSteps,
        totalSteps: steps.length,
        ...(successCriteria ? { successCriteria } : {}),
        ...(constraints ? { constraints } : {}),
        ...(goalStatus === "blocked"
          ? { blocker: "所有计划步骤均被跳过，没有可验证的已完成工作。" }
          : {}),
      },
      steps,
      updatedAt: new Date().toISOString(),
    };
    await db
      .update(workflowRun)
      .set({ planJson: plan as never })
      .where(eq(workflowRun.id, ctx.workflowId));

    let artifactPaths: Awaited<ReturnType<typeof writeWorkflowPlanArtifacts>> | null = null;
    let workspaceWarning: string | null = null;
    try {
      artifactPaths = await writeWorkflowPlanArtifacts({
        projectId: workflowMeta.projectId,
        workflowRunId: ctx.workflowId,
        plan,
      });
    } catch (error) {
      workspaceWarning = error instanceof Error ? error.message : String(error);
      console.warn(`[update_plan] workspace mirror failed: ${workspaceWarning}`);
    }
    try {
      getStepStreamPorts().publish({
        runId: ctx.runId,
        workflowId: ctx.workflowId,
        traceId: ctx.traceId,
        role: ctx.definition.role,
        type: "plan",
        stepIndex: 0,
        ts: Date.now(),
        payload: plan as unknown as Record<string, unknown>,
      });
    } catch (error) {
      console.warn(`[update_plan] publish failed: ${(error as Error).message}`);
    }
    return {
      ok: true,
      persisted: true,
      workspaceMirrored: Boolean(artifactPaths),
      workspaceDir: artifactPaths?.workflowDir ?? null,
      ...(workspaceWarning ? { workspaceWarning } : {}),
      stepCount: steps.length,
      done: completedSteps,
    };
  },

  assign_task: async (ctx, params) => {
    const role = String(params.role ?? params.targetRole ?? "").trim() as AgentRole;
    if (!role) throw new Error("assign_task: role is required");
    return dispatchTeamAgentTask(ctx, role, params);
  },

  run_analyst_team: async (ctx, params) => {
    const parsed = buildParsedResearchTeamFromToolParams({
      workflowRunId: ctx.workflowId,
      params,
      ...(ctx.inboundPayload !== undefined ? { inboundPayload: ctx.inboundPayload } : {}),
    });
    return runResearchTeamFromOrchestrator({
      workflowRunId: ctx.workflowId,
      runId: ctx.runId,
      traceId: ctx.traceId,
      parsed,
      hitlApproval: parseHitlApproval(
        (ctx.inboundPayload?.params as Record<string, unknown> | undefined)?.hitlApproval
      ),
      ensureJob: true,
    });
  },

  summarize_team_decision: async (ctx, params) => {
    const fusionSummary = String(params.fusion_summary ?? params.fusionSummary ?? "").trim();
    const ticker = String(params.ticker ?? "").trim();
    if (!fusionSummary || !ticker) {
      throw new Error(
        "summarize_team_decision: fusion_summary 与 ticker 必填（请把 run_analyst_team 返回值中的 fusionSummary 与 ticker 原样传入）"
      );
    }
    const allowedSignals: ReadonlyArray<AnalystSignalValue> = ["buy", "sell", "hold"];
    const rawSignal = String(
      params.msa_signal ?? params.msaSignal ?? params.fused_signal ?? "hold"
    ).toLowerCase();
    const msaSignal = (
      allowedSignals.includes(rawSignal as AnalystSignalValue) ? rawSignal : "hold"
    ) as AnalystSignalValue;
    const confidenceRaw = Number(
      params.msa_confidence ?? params.msaConfidence ?? params.fused_confidence ?? 0.5
    );
    const msaConfidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.5;
    const pickRoles = (key1: string, key2: string): AgentRole[] | undefined => {
      const raw = params[key1] ?? params[key2];
      if (!Array.isArray(raw)) return undefined;
      return raw.filter(
        (role): role is AgentRole => typeof role === "string" && role.length > 0
      ) as AgentRole[];
    };
    const attendedRoles = pickRoles("attended_roles", "attendedRoles");
    const missingRoles = pickRoles("missing_roles", "missingRoles");
    return summarizeTeamDecision({
      workflowRunId: ctx.workflowId,
      ticker,
      orchestratorSystemPrompt: ctx.definition.systemPrompt,
      fusionSummary,
      msaSignal,
      msaConfidence,
      ...(attendedRoles ? { attendedRoles } : {}),
      ...(missingRoles ? { missingRoles } : {}),
    });
  },

  fuse_signals: async (ctx, params) => {
    const db = await getDb();
    const workflowRunId = String(params.workflowRunId ?? ctx.workflowId);
    const ticker = String(params.ticker ?? "");
    let signals: RawAnalystSignal[] = [];
    if (Array.isArray(params.signals)) {
      signals = params.signals as RawAnalystSignal[];
    } else {
      const rows = await db
        .select()
        .from(analystSignal)
        .where(eq(analystSignal.workflowRunId, workflowRunId));
      signals = rows.map((row) => ({
        definitionId: row.agentInstanceId ?? row.analystRole,
        analystRole: row.analystRole as AgentRole,
        ticker: row.ticker,
        signal: row.signal,
        confidence: row.confidence,
        reasoning: row.reasoning ?? "",
        dataSnapshot: (row.dataSnapshotJson as Record<string, unknown>) ?? {},
      }));
    }
    return fuseSignals({
      workflowRunId,
      signals,
      ...(ticker ? { tickerHint: ticker } : {}),
    });
  },
};
