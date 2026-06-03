/**
 * AutoInstaller（P8）—— 把 P7 `tool_gap_log` 路由到 mcp_catalog / mcp_catalog_item 上
 * 生成 `auto_install_proposal` 入审批队列。
 *
 * 文档：docs/SELF_EVOLVING_AGENT_DESIGN.md §6.6
 */

/** auto_install_proposal.proposal_kind */
export type ProposalKind = "install_mcp_catalog" | "install_mcp_external" | "no_candidate";

/** auto_install_proposal.state */
export type ProposalState = "pending_review" | "approved" | "rejected" | "no_candidate";

/** auto_install_proposal.safety_level（透传 catalog.riskLevel） */
export type ProposalSafetyLevel = "low" | "medium" | "high";

/** auto_install_proposal.target_kind */
export type ProposalTargetKind = "mcp_catalog" | "mcp_catalog_item";

/** matcher 给一个 gap 算出来的一个候选 */
export interface MatchCandidate {
  /** 'mcp_catalog' / 'mcp_catalog_item' */
  targetKind: ProposalTargetKind;
  /** catalog 或 catalog_item 的主键 */
  targetId: string;
  /** catalog.slug / catalog_item.slug，给前端展示 */
  targetSlug: string;
  /** 展示名 */
  name: string;
  description: string;
  /** 透传 catalog.riskLevel */
  safetyLevel: ProposalSafetyLevel;
  /** 0~1 综合分数 */
  score: number;
  /** 命中的规则说明，便于前端"为什么是它" + debug */
  ruleHits: string[];
  /** 候选可用的 tool name（用来填 mcp_tool_binding.toolName） */
  toolName: string | null;
  /** 透传给 install 接口的 payload 快照 */
  payload: {
    transport: "stdio" | "http" | "ws";
    command: string | null;
    url: string | null;
    defaultToolName: string;
    capabilities: string[];
  };
}

/** auto_installer_run 跑批快照 */
export interface AutoInstallerRunSummary {
  runId: string;
  projectId: string;
  status: "running" | "completed" | "failed";
  gapsScanned: number;
  proposalsCreated: number;
  proposalsSkippedExisting: number;
  proposalsNoCandidate: number;
  elapsedMs: number;
  errorMessage?: string;
  startedAt: string;
  endedAt?: string;
}
