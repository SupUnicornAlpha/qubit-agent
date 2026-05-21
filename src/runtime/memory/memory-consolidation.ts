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

export interface ConsolidationResult {
  workflowId: string;
  status: "completed" | "skipped" | "failed";
  midtermInserted: number;
  reason?: string;
}

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
  }

  return { workflowId, status: "completed", midtermInserted: inserted };
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
