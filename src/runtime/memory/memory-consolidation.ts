/**
 * MemoryConsolidationService — M10.A1（midterm sunset，2026-08）
 *
 * 工作流结束时的 host 侧收尾：
 *   - **Skill 候选**：`workflow-skill-consolidation.ts`
 *   - **语义记忆**：Experience V2（Extractor / Summarizer / Reflector via Bus）
 *
 * `consolidateFromWorkflow` 保留为兼容入口；不再写 midterm_memory。
 */

export type { AgentStepRow, AgentStepSummary } from "./memory-consolidation-helpers";
export {
  inferMemoryType,
  summarizeAgentSteps,
} from "./memory-consolidation-helpers";

export { proposeSkillCandidate } from "./workflow-skill-consolidation";
export type { SkillConsolidationResult } from "./workflow-skill-consolidation";
import { consolidateSkillsFromWorkflow } from "./workflow-skill-consolidation";

export interface ConsolidationResult {
  workflowId: string;
  status: "completed" | "skipped" | "failed";
  /** @deprecated midterm 已 sunset，恒为 0 */
  midtermInserted: number;
  skillCandidatesProposed?: number;
  reason?: string;
}

/** @deprecated 请直接用 `consolidateSkillsFromWorkflow`；保留供工具/旧调用方。 */
export async function consolidateFromWorkflow(workflowId: string): Promise<ConsolidationResult> {
  const skill = await consolidateSkillsFromWorkflow(workflowId);
  return {
    workflowId: skill.workflowId,
    status: skill.status,
    midtermInserted: 0,
    skillCandidatesProposed: skill.skillCandidatesProposed,
    ...(skill.reason ? { reason: skill.reason } : {}),
  };
}
