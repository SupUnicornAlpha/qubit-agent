import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import type { AgentRole } from "../../types/entities";
import { resolveAgentControlMode } from "../../types/loop";
import {
  type AgentPlanSnapshot,
  type AgentPlanStepStatus,
  type ResearchPhaseState,
  parseAgentPlanSnapshot,
  parseResearchPhase,
  parseResearchPhaseStatus,
} from "../agent-control-mode";
import { dispatchTeamAgentTask } from "../orchestration/team-dispatch-adapter";
import { getStepStreamPorts } from "../ports/step-stream";
import { writeWorkflowPlanArtifacts } from "../workflow/plan-artifact";
import type { BuiltinToolHandler } from "./types";

/** Phase A: TradingAgents-style bulk team tools are hard-rejected (not advertised). */
const TEAM_COMPAT_RETIRED_MSG =
  "已退役（Phase A）。请用 assign_task / call_team_<role> / agent.invoke；" +
  "不要再用 run_analyst_team / fuse_signals / summarize_team_decision。";

/** Handlers that coordinate workflow state or a team of agents. */
export const ORCHESTRATION_HANDLERS: Record<string, BuiltinToolHandler> = {
  "tool.catalog.search": async (ctx, params) => {
    const query = String(params.query ?? params.q ?? "")
      .trim()
      .toLowerCase();
    const category = String(params.category ?? "")
      .trim()
      .toLowerCase();
    const requestedLimit = Number(params.limit ?? 8);
    const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 8, 20));
    // Dynamic import avoids a builtin-tools <-> catalog initialization cycle.
    const { buildToolCatalog } = await import("./tool-catalog");
    const configured = new Set(ctx.definition.tools);
    const matches = buildToolCatalog()
      .filter((tool) => {
        if (category && tool.category !== category) return false;
        if (!query) return true;
        return `${tool.name} ${tool.description} ${tool.category ?? ""}`
          .toLowerCase()
          .includes(query);
      })
      // Discovery must not grant new permissions, but an agent's existing
      // read-only tools are the most useful search results and should not be
      // hidden by unrelated catalog entries when callers use a small limit.
      .sort((left, right) => {
        const configuredDelta =
          Number(configured.has(right.name)) - Number(configured.has(left.name));
        return configuredDelta || left.name.localeCompare(right.name);
      })
      .slice(0, limit)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        kind: tool.kind,
        category: tool.category,
        lifecycle: tool.lifecycle ?? "stable",
        configuredForThisAgent: configured.has(tool.name),
      }));
    return {
      query,
      count: matches.length,
      // Discovery is deliberately not an authorization bypass. Users can add a
      // result through Agent configuration, which persists as a user override.
      hint: "未授权工具请由用户在 Agent 配置中绑定；不得仅因 catalog.search 返回就调用。",
      tools: matches,
    };
  },

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
      const researchPhase = parseResearchPhase(rawStep.researchPhase ?? rawStep.research_phase);
      steps.push({
        id: (String(rawStep.id ?? "").trim() || `s${i + 1}`).slice(0, 40),
        title: title.slice(0, 200),
        status,
        ...(note ? { note } : {}),
        ...(researchPhase ? { researchPhase } : {}),
      });
    }
    const completedSteps = steps.filter((step) => step.status === "done").length;
    const skippedSteps = steps.filter((step) => step.status === "skipped").length;
    const hasActive = steps.some((step) => step.status === "in_progress");
    const allTerminal = steps.length > 0 && completedSteps + skippedSteps === steps.length;
    const previousPlan = parseAgentPlanSnapshot(workflowMeta.planJson);
    const researchPhase =
      parseResearchPhase(params.researchPhase ?? params.research_phase) ??
      previousPlan?.researchPhase;
    const parsedResearchPhases: ResearchPhaseState[] = [];
    const rawResearchPhases = params.researchPhases ?? params.research_phases;
    if (Array.isArray(rawResearchPhases)) {
      for (const rawPhase of rawResearchPhases.slice(0, 6)) {
        if (!rawPhase || typeof rawPhase !== "object") continue;
        const phaseRecord = rawPhase as Record<string, unknown>;
        const phase = parseResearchPhase(
          phaseRecord.phase ?? phaseRecord.researchPhase ?? phaseRecord.research_phase
        );
        const status = parseResearchPhaseStatus(phaseRecord.status);
        if (
          !phase ||
          !status ||
          parsedResearchPhases.some((candidate) => candidate.phase === phase)
        ) {
          continue;
        }
        const note = String(phaseRecord.note ?? "")
          .trim()
          .slice(0, 300);
        parsedResearchPhases.push({
          phase,
          status,
          ...(note ? { note } : {}),
        });
      }
    }
    const researchPhases =
      parsedResearchPhases.length > 0 ? parsedResearchPhases : (previousPlan?.researchPhases ?? []);
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
      ...(researchPhase ? { researchPhase } : {}),
      ...(researchPhases.length > 0 ? { researchPhases } : {}),
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

  /** Retired Phase A — still registered so persisted defs fail closed with a clear error. */
  run_analyst_team: async () => {
    throw new Error(`run_analyst_team: ${TEAM_COMPAT_RETIRED_MSG}`);
  },

  summarize_team_decision: async () => {
    throw new Error(`summarize_team_decision: ${TEAM_COMPAT_RETIRED_MSG}`);
  },

  fuse_signals: async () => {
    throw new Error(`fuse_signals: ${TEAM_COMPAT_RETIRED_MSG}`);
  },
};
