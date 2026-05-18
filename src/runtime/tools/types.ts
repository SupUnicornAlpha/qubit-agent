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

export interface ToolCatalogEntry {
  name: string;
  kind: "builtin" | "connector" | "mcp";
  connector?: string;
  description: string;
  category?: ToolCatalogCategory;
}
