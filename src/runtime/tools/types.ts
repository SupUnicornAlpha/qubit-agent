import type { AgentRole } from "../../types/entities";
import type { RuntimeAgentDefinition } from "../types";

/** Context passed to every builtin tool handler from the LangGraph act node. */
export interface BuiltinToolContext {
  workflowId: string;
  runId: string;
  traceId: string;
  agentInstanceId: string;
  projectId?: string;
  definition: RuntimeAgentDefinition;
  reasonText?: string;
  inboundPayload?: Record<string, unknown>;
}

export type BuiltinToolHandler = (
  ctx: BuiltinToolContext,
  params: Record<string, unknown>
) => Promise<unknown>;

export type ToolCatalogCategory =
  | "orchestration"
  | "market"
  | "research"
  | "backtest"
  | "trading"
  | "risk"
  | "sentiment"
  | "macro"
  | "memory"
  | "audit";

/**
 * 工具生命周期标签（仅元数据，不影响调用链路）：
 * - stable：默认；功能稳定，可用于生产。
 * - experimental：可调用但实现不完整 / 接口可能变更。
 * - stub：实现为占位/硬编码，不要在生产链路依赖；UI 应灰显。
 * - deprecated：建议使用 `replacedBy` 指向的工具；保留 handler 但 UI 应提示。
 */
export type ToolLifecycle = "stable" | "experimental" | "stub" | "deprecated";

export interface ToolCatalogEntry {
  name: string;
  kind: "builtin" | "connector" | "mcp";
  connector?: string;
  description: string;
  category?: ToolCatalogCategory;
  lifecycle?: ToolLifecycle;
  /** 当 lifecycle = deprecated 时给出建议替代工具名（也必须在 catalog 中） */
  replacedBy?: string;
  /** 一句话说明为什么 deprecated / stub */
  deprecationReason?: string;
}
