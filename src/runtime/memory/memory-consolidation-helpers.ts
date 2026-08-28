/**
 * MemoryConsolidation 纯函数 — step 摘要与 midterm 类型推断（历史兼容）。
 * Skill 提炼已迁至 workflow-skill-consolidation.ts。
 */

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
      const tool = action?.tool ?? action?.name;
      if (typeof tool === "string") {
        toolsUsed[tool] = (toolsUsed[tool] ?? 0) + 1;
      }
    }
    if (step.actionType === "final_answer") {
      const action = step.actionJson as Record<string, unknown> | null;
      const answer = action?.answer ?? action?.text ?? action?.result;
      if (typeof answer === "string" && answer.trim()) {
        finalAnswer = answer.trim();
      }
    }
    if (step.thought && step.thought.trim().length > 0 && reasoning.length < 3) {
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

export function inferMemoryType(
  role: string,
  summary: AgentStepSummary
): "strategy_iteration" | "risk_review" | "simulation_note" | "param_scan" {
  const r = role.toLowerCase();
  if (r.includes("risk")) return "risk_review";
  if (r.includes("backtest") || r.includes("walk_forward") || r.includes("validator"))
    return "simulation_note";
  if (r.includes("research") || r.includes("orchestrator")) return "strategy_iteration";
  void summary;
  return "strategy_iteration";
}
