/**
 * AutoInstaller（P8）—— 把 P7 `tool_gap_log` 路由到 mcp_catalog 上生成
 * `auto_install_proposal` 入审批队列。
 *
 * Schema 收敛 C4（migration 0071）后：builtin / registry / fsi 来源已并入同一张
 * `mcp_catalog` 表，用 `source` 字段区分。MatchCandidate.source 决定走
 * install_mcp_catalog 还是 install_mcp_external。
 *
 * 文档：docs/SELF_EVOLVING_AGENT_DESIGN.md §6.6
 */

/** auto_install_proposal.proposal_kind */
export type ProposalKind = "install_mcp_catalog" | "install_mcp_external" | "no_candidate";

/** auto_install_proposal.state */
export type ProposalState = "pending_review" | "approved" | "rejected" | "no_candidate";

/** auto_install_proposal.safety_level（透传 catalog.riskLevel） */
export type ProposalSafetyLevel = "low" | "medium" | "high";

/**
 * auto_install_proposal.target_kind
 *
 * Schema 收敛 C4（migration 0071）后：所有候选物理上都来自合并后的 `mcp_catalog`
 * 一张表，target_kind 新写入恒为 'mcp_catalog'。'mcp_catalog_item' 字面值
 * 保留是为了 backward-compat 反序列化历史 proposal 行（不再产生新值）。
 * 区分 builtin / external 改用 MatchCandidate.source 或 proposal_kind。
 */
export type ProposalTargetKind = "mcp_catalog" | "mcp_catalog_item";

/** mcp_catalog.source —— 候选来源域 */
export type CatalogSource = "builtin" | "registry" | "fsi";

/** matcher 给一个 gap 算出来的一个候选 */
export interface MatchCandidate {
  /** 合表后恒为 'mcp_catalog'；保留字段是为了 proposal payload 兼容旧消费端 */
  targetKind: ProposalTargetKind;
  /** mcp_catalog 主键 */
  targetId: string;
  /** mcp_catalog.slug，给前端展示 */
  targetSlug: string;
  /** 候选来源：'builtin' 走 install_mcp_catalog & 允许 auto-install；其余走 install_mcp_external */
  source: CatalogSource;
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
  /** P9 auto 模式：直接 approved+真装的数量 */
  autoInstalled?: number;
  /** P9 auto 模式：尝试自动装但 install-service 抛错的数量 */
  autoInstallFailed?: number;
  elapsedMs: number;
  errorMessage?: string;
  startedAt: string;
  endedAt?: string;
}
