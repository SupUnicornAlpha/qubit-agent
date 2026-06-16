/**
 * Experience pipe 的生产 SQLite 加载器（Extractor / Reflector）。
 *
 * 背景（P0 2026-06）：`startExtractorPipe / startReflectorPipe` 只有 test fake loader，
 * 生产从未接入；而唯一接入的 summarizer loader 还 select 了 agent_step 上**不存在的列**
 * （role / reasonText / finalAnswer）。本文件按 agent_step 的真实模型重写：
 *   - role：agent_step → agent_instance → agent_definition.role（join，而非 agent_step.role）
 *   - 工具链 / 工具计数：tool_call_log（agent_step 不存调用明细）
 *   - "有 final_answer"：agent_step.actionType === 'final_answer'（文本只能 best-effort
 *     从 actionJson 取，因为真正的 reason/final 文本不落 agent_step，agent_step 是 thin trace）
 */
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentInstance,
  agentStep,
  toolCallLog,
  workflowRun,
} from "../../db/sqlite/schema";
import type { ExtractorLoader, ExtractorWorkflowSummary } from "./pipes/extractor";
import type { ReflectorLoader, ReflectorWorkflowContext } from "./pipes/reflector";

const MAX_STEPS_TEXT = 40;
const FINAL_ANSWER_MAX = 1200;
const STEP_TEXT_MAX = 280;

function errToStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function asStr(v: unknown, max: number): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.slice(0, max);
}

interface RawInstance {
  instanceId: string;
  definitionId: string;
  role: string;
  stepCount: number;
  toolChain: string[];
  toolsUsed: Record<string, number>;
  finalAnswer: string;
}

interface RawWorkflow {
  wf: {
    id: string;
    projectId: string;
    goal: string;
    mode: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
  };
  instances: RawInstance[];
  steps: Array<{ role: string; thought: string; actionType: string }>;
  failedTools: Array<{ role: string; toolName: string; errorClass: string }>;
}

/** 折叠相邻重复（与 extractor 的 toolChain 语义一致）。 */
function collapseAdjacent(arr: string[]): string[] {
  const out: string[] = [];
  for (const x of arr) if (out[out.length - 1] !== x) out.push(x);
  return out;
}

/**
 * 一次性读出 workflow + 按 agent_instance 聚合的工具链/步数/final 标记 + 失败工具列表，
 * 供 Extractor / Reflector 两个 loader 复用。
 */
async function readWorkflowForPipes(workflowRunId: string): Promise<RawWorkflow | null> {
  const db = await getDb();
  const wfRow = await db
    .select({
      id: workflowRun.id,
      projectId: workflowRun.projectId,
      goal: workflowRun.goal,
      mode: workflowRun.mode,
      status: workflowRun.status,
      startedAt: workflowRun.startedAt,
      endedAt: workflowRun.endedAt,
    })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
  const wf = wfRow[0];
  if (!wf) return null;

  const defs = await db
    .select({ id: agentDefinition.id, role: agentDefinition.role })
    .from(agentDefinition);
  const defRole = new Map(defs.map((d) => [d.id, d.role]));

  const instRows = await db
    .select({ id: agentInstance.id, definitionId: agentInstance.definitionId })
    .from(agentInstance)
    .where(eq(agentInstance.workflowRunId, workflowRunId));
  const instMeta = new Map<string, { definitionId: string; role: string }>();
  for (const i of instRows) {
    instMeta.set(i.id, {
      definitionId: i.definitionId,
      role: defRole.get(i.definitionId) ?? "unknown",
    });
  }

  const stepRows = await db
    .select({
      id: agentStep.id,
      agentInstanceId: agentStep.agentInstanceId,
      thought: agentStep.thought,
      actionType: agentStep.actionType,
      actionJson: agentStep.actionJson,
    })
    .from(agentStep)
    .where(eq(agentStep.workflowRunId, workflowRunId))
    .orderBy(asc(agentStep.createdAt));

  const stepToInstance = new Map(stepRows.map((s) => [s.id, s.agentInstanceId]));
  const stepIds = stepRows.map((s) => s.id);
  const toolRows =
    stepIds.length > 0
      ? await db
          .select({
            agentStepId: toolCallLog.agentStepId,
            toolName: toolCallLog.toolName,
            status: toolCallLog.status,
            errorClass: toolCallLog.errorClass,
          })
          .from(toolCallLog)
          .where(inArray(toolCallLog.agentStepId, stepIds))
          .orderBy(asc(toolCallLog.createdAt))
      : [];

  const agg = new Map<string, RawInstance>();
  const ensure = (instanceId: string): RawInstance => {
    let cur = agg.get(instanceId);
    if (!cur) {
      const meta = instMeta.get(instanceId);
      cur = {
        instanceId,
        definitionId: meta?.definitionId ?? "",
        role: meta?.role ?? "unknown",
        stepCount: 0,
        toolChain: [],
        toolsUsed: {},
        finalAnswer: "",
      };
      agg.set(instanceId, cur);
    }
    return cur;
  };

  const steps: RawWorkflow["steps"] = [];
  for (const s of stepRows) {
    const inst = ensure(s.agentInstanceId);
    inst.stepCount += 1;
    if (s.actionType === "final_answer" && !inst.finalAnswer) {
      inst.finalAnswer = asStr(s.actionJson, FINAL_ANSWER_MAX);
    }
    steps.push({
      role: inst.role,
      thought: asStr(s.thought, STEP_TEXT_MAX),
      actionType: s.actionType,
    });
  }

  const failedTools: RawWorkflow["failedTools"] = [];
  for (const t of toolRows) {
    const instId = stepToInstance.get(t.agentStepId);
    if (!instId) continue;
    const inst = agg.get(instId);
    if (!inst) continue;
    inst.toolChain.push(t.toolName);
    inst.toolsUsed[t.toolName] = (inst.toolsUsed[t.toolName] ?? 0) + 1;
    if (t.status !== "success") {
      failedTools.push({
        role: inst.role,
        toolName: t.toolName,
        errorClass: t.errorClass ?? "unknown",
      });
    }
  }
  for (const inst of agg.values()) inst.toolChain = collapseAdjacent(inst.toolChain);

  return {
    wf: {
      id: wf.id,
      projectId: wf.projectId,
      goal: wf.goal ?? "",
      mode: wf.mode ?? "research",
      status: wf.status ?? "",
      startedAt: wf.startedAt instanceof Date ? wf.startedAt.toISOString() : String(wf.startedAt),
      endedAt:
        wf.endedAt instanceof Date
          ? wf.endedAt.toISOString()
          : ((wf.endedAt as string | null) ?? null),
    },
    instances: [...agg.values()].sort((a, b) => a.role.localeCompare(b.role)),
    steps,
    failedTools,
  };
}

function terminalStatus(status: string): "completed" | "failed" | null {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return null;
}

/** 生产 Extractor loader：workflow + agent_step + tool_call_log → ExtractorWorkflowSummary。 */
export const sqliteExtractorLoader: ExtractorLoader = {
  async loadWorkflowSummary(workflowRunId: string): Promise<ExtractorWorkflowSummary | null> {
    try {
      const raw = await readWorkflowForPipes(workflowRunId);
      if (!raw) return null;
      const status = terminalStatus(raw.wf.status);
      if (!status) return null;
      const mode = (
        ["research", "backtest", "simulation", "live"].includes(raw.wf.mode)
          ? raw.wf.mode
          : "research"
      ) as ExtractorWorkflowSummary["mode"];
      return {
        workflowRunId,
        projectId: raw.wf.projectId,
        goal: raw.wf.goal,
        mode,
        status,
        startedAt: raw.wf.startedAt,
        endedAt: raw.wf.endedAt,
        participants: raw.instances.map((i) => ({
          definitionId: i.definitionId,
          role: i.role,
          toolsUsed: i.toolsUsed,
          toolChain: i.toolChain,
          finalAnswer: i.finalAnswer,
          stepCount: i.stepCount,
        })),
        episodicIds: [],
      };
    } catch (err) {
      console.warn(`[pipe-loaders] extractor loader failed wf=${workflowRunId}: ${errToStr(err)}`);
      return null;
    }
  },
};

/** 生产 Reflector loader：失败签名（role+tool+errorClass）+ 最近步骤素材。 */
export const sqliteReflectorLoader: ReflectorLoader = {
  async loadContext(workflowRunId: string): Promise<ReflectorWorkflowContext | null> {
    try {
      const raw = await readWorkflowForPipes(workflowRunId);
      if (!raw) return null;
      const status = terminalStatus(raw.wf.status);
      if (!status) return null;

      // 失败签名：出现次数最多的 (role, toolName, errorClass)
      const counts = new Map<
        string,
        { role: string; toolName: string; errorClass: string; n: number }
      >();
      for (const f of raw.failedTools) {
        const key = `${f.role}|${f.toolName}|${f.errorClass}`;
        const cur = counts.get(key) ?? { ...f, n: 0 };
        cur.n += 1;
        counts.set(key, cur);
      }
      let top: { role: string; toolName: string; errorClass: string; n: number } | null = null;
      for (const c of counts.values()) if (!top || c.n > top.n) top = c;

      const orch = raw.instances.find((i) => i.role === "orchestrator") ?? raw.instances[0];
      const recentStepsText = raw.steps
        .slice(-MAX_STEPS_TEXT)
        .map((s, i) => `### step ${i + 1} · ${s.role}\n${s.thought}`)
        .join("\n\n");

      return {
        workflowRunId,
        projectId: raw.wf.projectId,
        status,
        mode: raw.wf.mode,
        goal: raw.wf.goal,
        ...(top
          ? { failureHint: { role: top.role, toolName: top.toolName, errorClass: top.errorClass } }
          : {}),
        definitionId: orch?.definitionId ?? null,
        episodicIds: [],
        recentStepsText,
      };
    } catch (err) {
      console.warn(`[pipe-loaders] reflector loader failed wf=${workflowRunId}: ${errToStr(err)}`);
      return null;
    }
  },
};
