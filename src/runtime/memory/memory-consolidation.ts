/**
 * MemoryConsolidationService — M10.A1
 *
 * 工作流结束时（onWorkflowTerminal completed 钩子）自动把当轮跑出来的关键产出
 * 提炼为 midterm_memory，让下一次相关任务能"记得"上次的结论。
 *
 * 触发时机：
 *   1. onWorkflowTerminal(workflowId, "completed") → consolidateFromWorkflow
 *   2. 用户主动调 memory.summarize_workflow 工具（A2 阶段补）
 *
 * 数据流：
 *   agent_step / chat_message / session_memory / workflow_run
 *     ↓ 简单规则提炼（无 LLM call，避免归纳本身又消耗 token）
 *   midterm_memory（按 project + role 分类）
 *
 * 设计权衡：
 *   - 这里用「规则式提炼」而非 LLM 摘要，保证不耗费 token、即时完成、不阻塞主流程
 *   - 如果用户后续想要 LLM 总结，可以让 Agent 主动调 memory.summarize_workflow 工具
 *     （那里走 reasonNode → LLM）
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentInstance,
  agentStep,
  midtermMemory,
  workflowRun,
} from "../../db/sqlite/schema";
import { skillService } from "../skills/skill-service";

export interface ConsolidationResult {
  workflowId: string;
  status: "completed" | "skipped" | "failed";
  midtermInserted: number;
  skillCandidatesProposed?: number;
  reason?: string;
}

/** 触发"sklill candidate"的最低门槛（参考 Hermes：≥5 tool 调用 + ≥3 distinct + 有 final_answer） */
const SKILL_MIN_TOOL_CALLS = 5;
const SKILL_MIN_DISTINCT_TOOLS = 3;

export interface AgentStepRow {
  id: string;
  agentInstanceId: string;
  stepIndex: number;
  phase: string;
  thought: string | null;
  actionType: string;
  actionJson: unknown;
  observationJson: unknown;
  createdAt: string;
}

interface AgentInstanceRow {
  id: string;
  definitionId: string | null;
  role: string;
}

/**
 * 从一个已完成的 workflow_run 中提炼 midterm 记忆。
 * 按"每个参与 agent 一条 midterm"的粒度归纳。
 */
export async function consolidateFromWorkflow(
  workflowId: string
): Promise<ConsolidationResult> {
  const db = await getDb();

  // 1. 读 workflow_run
  const wfRows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  const wf = wfRows[0];
  if (!wf) {
    return { workflowId, status: "skipped", midtermInserted: 0, reason: "workflow_not_found" };
  }
  if (wf.status !== "completed") {
    return { workflowId, status: "skipped", midtermInserted: 0, reason: `status=${wf.status}` };
  }

  // 2. 读这个 workflow 的所有 agent_step + agent_instance
  const steps = (await db
    .select()
    .from(agentStep)
    .where(eq(agentStep.workflowRunId, workflowId))
    .orderBy(asc(agentStep.stepIndex))) as AgentStepRow[];

  if (steps.length === 0) {
    return { workflowId, status: "skipped", midtermInserted: 0, reason: "no_steps" };
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

  // 3. 按 agent 分组 steps
  const byAgent = new Map<string, AgentStepRow[]>();
  for (const step of steps) {
    if (!step.agentInstanceId) continue;
    const list = byAgent.get(step.agentInstanceId) ?? [];
    list.push(step);
    byAgent.set(step.agentInstanceId, list);
  }

  let inserted = 0;
  let skillCandidatesProposed = 0;
  const now = new Date().toISOString();
  const timeWindowStart = wf.startedAt ?? now;
  const timeWindowEnd = wf.endedAt ?? now;

  for (const [instanceId, agentSteps] of byAgent.entries()) {
    const instance = instanceMap.get(instanceId);
    if (!instance) continue;

    const summary = summarizeAgentSteps(agentSteps, instance.role);
    if (!summary.text.trim()) continue;

    const memoryType = inferMemoryType(instance.role, summary);
    await db.insert(midtermMemory).values({
      id: crypto.randomUUID(),
      projectId: wf.projectId,
      definitionId: instance.definitionId,
      memoryType: memoryType as never,
      contentJson: {
        content: summary.text,
        role: instance.role,
        workflowRunId: workflowId,
        goal: wf.goal,
        toolsUsed: summary.toolsUsed,
        finalAnswer: summary.finalAnswer,
        stepCount: agentSteps.length,
        memoryType,
      },
      timeWindowStart,
      timeWindowEnd,
      asofTime: now,
      score: null,
      updatedAt: now,
    });
    inserted += 1;

    // M11.A2: 如果这是一段「值得复用的程序性流程」，把它作为 pending_review skill 候选写入
    // agent_skill 表，待 Curator/用户审批后再激活。
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
        `[memory-consolidation] proposeSkillCandidate failed for instance ${instanceId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return {
    workflowId,
    status: "completed",
    midtermInserted: inserted,
    skillCandidatesProposed,
  };
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
 * 从一段 agent_step 序列里抽出"可复用流程"候选（program of work）。
 *
 * 启发式规则（参考 Hermes Phase 1 skills heuristic）：
 *   - 至少 5 次 tool_call
 *   - 至少 3 种不同 tool（避免 N 连发同一 tool 这种无意义循环）
 *   - 有 final_answer（说明此路径"跑通"了，不是中途夭折）
 *   - 同一 (definitionId, tool_chain_signature) 不重复落 skill
 *
 * 命中后写一条 state=pending_review 的 agent_skill，等 Curator 或用户审批。
 * 这样既能积累候选，又不污染 active skill 池。
 */
export async function proposeSkillCandidate(input: ProposeSkillInput): Promise<boolean> {
  const totalToolCalls = Object.values(input.summary.toolsUsed).reduce((a, b) => a + b, 0);
  const distinctTools = Object.keys(input.summary.toolsUsed).length;
  if (totalToolCalls < SKILL_MIN_TOOL_CALLS) return false;
  if (distinctTools < SKILL_MIN_DISTINCT_TOOLS) return false;
  if (!input.summary.finalAnswer) return false;
  if (!input.projectId) return false;

  // 工具调用序列（去重连续相同的）→ 用作 skill 的"签名"
  const toolChain = extractToolChain(input.steps);
  if (toolChain.length < SKILL_MIN_DISTINCT_TOOLS) return false;
  const signature = toolChain.join(">");

  // 用 signature + role 做幂等 key
  const candidateName = buildSkillCandidateName(input.role, toolChain);

  const existing = await skillService.findByName(input.projectId, candidateName);
  if (existing) {
    // 已有同签名 skill — 跳过，但更新 use_count（说明这条 play 又被跑通了一次）
    // 仅当现有 skill state ≠ archived 时刷新
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

  const description = `（自动候选）${input.role} 在「${input.goal.slice(0, 80)}」类目标下成功跑通的 ${toolChain.length}-step 工具链：${toolChain.slice(0, 6).join(" → ")}${toolChain.length > 6 ? " → …" : ""}。等待 Curator/用户审批；审批后改 state=active 即生效。`.slice(0, 500);

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
    });
    return true;
  } catch (err) {
    // 表不存在（migration 未跑） / 并发冲突 — 静默忽略
    if (process.env.DEBUG_SKILLS) {
      console.warn(
        "[memory-consolidation] proposeSkillCandidate insert failed:",
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
    const tool = action?.["tool"] ?? action?.["name"];
    if (typeof tool !== "string") continue;
    // 折叠相邻重复（同一 tool 连续 N 次只记一次）
    if (chain[chain.length - 1] !== tool) chain.push(tool);
  }
  return chain;
}

function buildSkillCandidateName(role: string, toolChain: string[]): string {
  // role:tool1-tool2-tool3（取前 3 个 tool，确保唯一且可读）
  const head = toolChain
    .slice(0, 3)
    .map((t) => t.replace(/\./g, "_").replace(/[^a-zA-Z0-9_]/g, "").toLowerCase())
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
  lines.push(`> **审批前请人工核对**：以下流程由 MemoryConsolidationService 从一次成功 workflow 自动抽取。`);
  lines.push(`> 通过 \`skill.patch({skillId, state:"active"})\` 即可启用；不合用调 \`skill.archive\`。`);
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

export interface AgentStepSummary {
  text: string;
  finalAnswer: string;
  toolsUsed: Record<string, number>;
}

export function summarizeAgentSteps(steps: AgentStepRow[], role: string): AgentStepSummary {
  const toolsUsed: Record<string, number> = {};
  const reasoning: string[] = [];
  let finalAnswer = "";

  for (const step of steps) {
    if (step.actionType === "tool_call") {
      const action = step.actionJson as Record<string, unknown> | null;
      const tool = action?.["tool"] ?? action?.["name"];
      if (typeof tool === "string") {
        toolsUsed[tool] = (toolsUsed[tool] ?? 0) + 1;
      }
    }
    if (step.actionType === "final_answer") {
      const action = step.actionJson as Record<string, unknown> | null;
      const answer = action?.["answer"] ?? action?.["text"] ?? action?.["result"];
      if (typeof answer === "string" && answer.trim()) {
        finalAnswer = answer.trim();
      }
    }
    if (step.thought && step.thought.trim().length > 0 && reasoning.length < 3) {
      // 取前 3 段关键 reasoning 作为线索
      reasoning.push(step.thought.trim().slice(0, 400));
    }
  }

  const toolsLine = Object.entries(toolsUsed)
    .map(([t, n]) => `${t}×${n}`)
    .join(", ");

  const lines: string[] = [`[${role}] 工作流总结（${steps.length} 步）`];
  if (toolsLine) lines.push(`使用工具：${toolsLine}`);
  if (reasoning.length > 0) {
    lines.push("关键推理：");
    for (const r of reasoning) lines.push(`- ${r}`);
  }
  if (finalAnswer) {
    lines.push(`最终结论：${finalAnswer.slice(0, 800)}`);
  }

  return { text: lines.join("\n"), finalAnswer, toolsUsed };
}

/**
 * 按 agent 角色推断 midterm memoryType。
 *
 * midtermMemory.memoryType enum:
 *   "strategy_iteration" | "risk_review" | "simulation_note" | "param_scan"
 */
export function inferMemoryType(role: string, summary: AgentStepSummary): "strategy_iteration" | "risk_review" | "simulation_note" | "param_scan" {
  const r = role.toLowerCase();
  if (r.includes("risk")) return "risk_review";
  if (r.includes("backtest") || r.includes("walk_forward") || r.includes("validator")) return "simulation_note";
  if (r.includes("research") || r.includes("orchestrator")) return "strategy_iteration";
  // 分析师 / news / market_data 等都归入 strategy_iteration
  void summary;
  return "strategy_iteration";
}
