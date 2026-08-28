/**
 * Workflow 完成后的 Skill 候选提炼 — 从 memory-consolidation 拆出。
 *
 * 职责单一：从 agent_step 序列识别可复用工具链 → pending_review skill。
 * 不再写 midterm_memory（Experience V2 已覆盖工作流总结）。
 */
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentInstance, agentStep, workflowRun } from "../../db/sqlite/schema";
import { skillService } from "../skills/skill-service";
import type { AgentStepRow, AgentStepSummary } from "./memory-consolidation-helpers";
import { summarizeAgentSteps } from "./memory-consolidation-helpers";

/** 触发 skill candidate 的最低门槛 */
const SKILL_MIN_TOOL_CALLS = 5;
const SKILL_MIN_DISTINCT_TOOLS = 3;

export interface SkillConsolidationResult {
  workflowId: string;
  status: "completed" | "skipped" | "failed";
  skillCandidatesProposed: number;
  reason?: string;
}

interface AgentInstanceRow {
  id: string;
  definitionId: string | null;
  role: string;
}

interface ProposeSkillInput {
  projectId: string;
  definitionId: string | null;
  role: string;
  goal: string;
  steps: AgentStepRow[];
  summary: AgentStepSummary;
}

/**
 * 从已完成的 workflow 提炼 skill 候选（不写 midterm）。
 */
export async function consolidateSkillsFromWorkflow(
  workflowId: string
): Promise<SkillConsolidationResult> {
  const db = await getDb();

  const wfRows = await db.select().from(workflowRun).where(eq(workflowRun.id, workflowId)).limit(1);
  const wf = wfRows[0];
  if (!wf) {
    return { workflowId, status: "skipped", skillCandidatesProposed: 0, reason: "workflow_not_found" };
  }
  if (wf.status !== "completed") {
    return { workflowId, status: "skipped", skillCandidatesProposed: 0, reason: `status=${wf.status}` };
  }

  const steps = (await db
    .select()
    .from(agentStep)
    .where(eq(agentStep.workflowRunId, workflowId))
    .orderBy(asc(agentStep.stepIndex))) as AgentStepRow[];

  if (steps.length === 0) {
    return { workflowId, status: "skipped", skillCandidatesProposed: 0, reason: "no_steps" };
  }

  const instanceIds = Array.from(new Set(steps.map((s) => s.agentInstanceId).filter(Boolean)));
  const instances = (await db
    .select({
      id: agentInstance.id,
      definitionId: agentInstance.definitionId,
      role: agentInstance.role,
    })
    .from(agentInstance)
    .where(inArray(agentInstance.id, instanceIds))) as AgentInstanceRow[];

  const instanceMap = new Map(instances.map((i) => [i.id, i]));
  const byAgent = new Map<string, AgentStepRow[]>();
  for (const step of steps) {
    if (!step.agentInstanceId) continue;
    const list = byAgent.get(step.agentInstanceId) ?? [];
    list.push(step);
    byAgent.set(step.agentInstanceId, list);
  }

  let skillCandidatesProposed = 0;
  for (const [instanceId, agentSteps] of byAgent.entries()) {
    const instance = instanceMap.get(instanceId);
    if (!instance) continue;

    const summary = summarizeAgentSteps(agentSteps, instance.role);
    if (!summary.text.trim()) continue;

    try {
      const proposed = await proposeSkillCandidate({
        projectId: wf.projectId,
        definitionId: instance.definitionId,
        role: instance.role,
        goal: wf.goal,
        steps: agentSteps,
        summary,
      });
      if (proposed) skillCandidatesProposed += 1;
    } catch (err) {
      console.warn(
        `[workflow-skill-consolidation] proposeSkillCandidate failed for instance ${instanceId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { workflowId, status: "completed", skillCandidatesProposed };
}

export async function proposeSkillCandidate(input: ProposeSkillInput): Promise<boolean> {
  const totalToolCalls = Object.values(input.summary.toolsUsed).reduce((a, b) => a + b, 0);
  const distinctTools = Object.keys(input.summary.toolsUsed).length;
  if (totalToolCalls < SKILL_MIN_TOOL_CALLS) return false;
  if (distinctTools < SKILL_MIN_DISTINCT_TOOLS) return false;
  if (!input.summary.finalAnswer) return false;
  if (!input.projectId) return false;

  const toolChain = extractToolChain(input.steps);
  if (toolChain.length < SKILL_MIN_DISTINCT_TOOLS) return false;
  const signature = toolChain.join(">");

  const candidateName = buildSkillCandidateName(input.role, toolChain);

  const existing = await skillService.findByName(input.projectId, candidateName);
  if (existing) {
    if (existing.state !== "archived") {
      try {
        await skillService.recordUsage({
          skillId: existing.id,
          definitionId: input.definitionId,
          outcome: "success",
          notes: `re-observed via workflow consolidation: ${input.goal.slice(0, 200)}`,
        });
      } catch {
        // ignore
      }
    }
    return false;
  }

  const description =
    `（自动候选）${input.role} 在「${input.goal.slice(0, 80)}」类目标下成功跑通的 ${toolChain.length}-step 工具链：${toolChain.slice(0, 6).join(" → ")}${toolChain.length > 6 ? " → …" : ""}。等待 Curator/用户审批；审批后改 state=active 即生效。`.slice(
      0,
      500
    );

  const bodyMd = renderSkillCandidateBody({
    role: input.role,
    goal: input.goal,
    toolChain,
    signature,
    summary: input.summary,
  });

  try {
    await skillService.create({
      projectId: input.projectId,
      definitionId: input.definitionId,
      name: candidateName,
      description,
      bodyMd,
      category: "auto_candidate",
      source: "agent_created",
      state: "pending_review",
      createdBy: `consolidator:${input.role}`,
      metadata: {
        signature,
        toolChain,
        toolsUsed: input.summary.toolsUsed,
        goal: input.goal,
        autoExtracted: true,
        proposeReason: "workflow_meets_skill_heuristic",
      },
      recommendedTools: toolChain,
    });
    return true;
  } catch (err) {
    if (process.env.DEBUG_SKILLS) {
      console.warn(
        "[workflow-skill-consolidation] proposeSkillCandidate insert failed:",
        err instanceof Error ? err.message : err
      );
    }
    return false;
  }
}

function extractToolChain(steps: AgentStepRow[]): string[] {
  const chain: string[] = [];
  for (const step of steps) {
    if (step.actionType !== "tool_call") continue;
    const action = step.actionJson as Record<string, unknown> | null;
    const tool = action?.tool ?? action?.name;
    if (typeof tool !== "string") continue;
    if (chain[chain.length - 1] !== tool) chain.push(tool);
  }
  return chain;
}

function buildSkillCandidateName(role: string, toolChain: string[]): string {
  const head = toolChain
    .slice(0, 3)
    .map((t) =>
      t
        .replace(/\./g, "_")
        .replace(/[^a-zA-Z0-9_]/g, "")
        .toLowerCase()
    )
    .filter(Boolean)
    .join("-");
  const cleanedRole = role.toLowerCase().replace(/[^a-z0-9]/g, "_");
  return `auto-${cleanedRole}-${head}`.slice(0, 80);
}

function renderSkillCandidateBody(input: {
  role: string;
  goal: string;
  toolChain: string[];
  signature: string;
  summary: AgentStepSummary;
}): string {
  const lines: string[] = [];
  lines.push(`# 自动候选 Skill — ${input.role}`);
  lines.push("");
  lines.push(
    "> **审批前请人工核对**：以下流程由 WorkflowSkillConsolidation 从一次成功 workflow 自动抽取。"
  );
  lines.push(
    `> 通过 \`skill.patch({skillId, state:"active"})\` 即可启用；不合用调 \`skill.archive\`。`
  );
  lines.push("");
  lines.push("## 适用场景");
  lines.push(`此 skill 由"${input.goal.slice(0, 200)}"类目标触发；当你拿到相似目标时可复用。`);
  lines.push("");
  lines.push("## 关键步骤（折叠相邻重复 tool 后）");
  for (let i = 0; i < input.toolChain.length; i++) {
    lines.push(`${i + 1}. \`${input.toolChain[i]}\``);
  }
  lines.push("");
  lines.push("## 验收信号");
  lines.push("- 全链跑完应能产出 final_answer / 通过下游 risk 签核");
  lines.push("- 若某一步连续失败 → 调 `skill.patch` 把这一步的 fallback 加进去");
  lines.push("");
  lines.push("## 当次执行摘要（仅供参考，不要照搬数字）");
  lines.push("```");
  lines.push(input.summary.text);
  lines.push("```");
  lines.push("");
  lines.push(`<!-- signature: ${input.signature} -->`);
  return lines.join("\n");
}
