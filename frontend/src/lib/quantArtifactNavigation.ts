import type { OrchestratorArtifact } from "../components/team/OrchestratorChatPanel";
import type { QuantContext, QuantHandoff, QuantTab } from "../store";

export interface QuantArtifactNavigation {
  context: QuantContext | null;
  handoff: QuantHandoff;
  tab: QuantTab;
}

/**
 * 把研究产物统一翻译成量化工坊导航指令。
 *
 * 这里刻意同时返回 project/workflow 上下文和精确产物 ID：
 * 只切 tab 会让工坊默认选中第一条，也会在跨项目时加载错列表。
 */
export function quantNavigationForArtifact(
  artifact: OrchestratorArtifact,
  fallbackProjectId: string,
  fallbackWorkflowRunId: string
): QuantArtifactNavigation {
  const projectId = artifact.projectId?.trim() || fallbackProjectId.trim();
  const workflowRunId = artifact.workflowRunId?.trim() || fallbackWorkflowRunId.trim() || null;
  const context: QuantContext | null = projectId
    ? { projectId, workflowRunId, sourceLabel: artifact.title }
    : null;
  const note = `来自本轮产物 · ${artifact.title}`;

  if (artifact.kind === "factor") {
    return {
      context,
      tab: "factor",
      handoff: {
        kind: "factor-to-workbench",
        factorId: artifact.id,
        projectId: projectId || null,
        workflowRunId,
        note,
      },
    };
  }
  if (artifact.kind === "strategy") {
    return {
      context,
      tab: "composer",
      handoff: {
        kind: "strategy-version-to-composer",
        strategyVersionId: artifact.id,
        workflowRunId,
        note,
      },
    };
  }
  return {
    context,
    tab: "script",
    handoff: {
      kind: "script-to-workbench",
      scriptId: artifact.id,
      projectId: projectId || null,
      workflowRunId,
      note,
    },
  };
}
