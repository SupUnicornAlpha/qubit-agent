import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentProfile } from "../../db/sqlite/schema";
import {
  type AgentPackSelfEditTarget,
  getDataDir,
  writePackSelfEditMarkdown,
} from "../agent/agent-pack-service";
import { dispatchTeamAgentTask } from "../orchestration/team-dispatch-adapter";
import {
  isTopologyTeamTool,
  parseRoleFromTopologyTeamTool,
} from "../orchestration/topology-dispatch";
import { ORCHESTRATION_HANDLERS } from "./orchestration-handlers";
export { resolveDelegatedParentTaskId } from "../orchestration/team-dispatch-adapter";
import { EXECUTION_HANDLERS } from "./execution-handlers";
import { EXECUTION_OBSERVABILITY_HANDLERS } from "./execution-observability-handlers";
import { FACTOR_RESEARCH_HANDLERS } from "./factor-research-handlers";
import { MARKET_ANALYSIS_HANDLERS } from "./market-analysis-handlers";
import { MEMORY_HANDLERS } from "./memory-handlers";
import { PRIME_MEMORY_HANDLERS } from "./prime-memory-handlers";
import { REPORTING_HANDLERS } from "./reporting-handlers";
import { RESEARCH_THESIS_HANDLERS } from "./research-thesis-handlers";
import { SKILL_HANDLERS } from "./skill-handlers";
import { STRATEGY_EXECUTION_HANDLERS } from "./strategy-execution-handlers";
import { resolveConnectorForTool } from "./tool-routes";
import type { BuiltinToolContext, BuiltinToolHandler } from "./types";
import { WEB_FETCH_HANDLER } from "./web-fetch-handler";
import { WEB_SEARCH_HANDLER } from "./web-search-handler";

/** Tools implemented in-process (not routed to ACP connectors). */
const BUILTIN_HANDLERS: Record<string, BuiltinToolHandler> = {
  ...ORCHESTRATION_HANDLERS,
  ...MARKET_ANALYSIS_HANDLERS,
  ...RESEARCH_THESIS_HANDLERS,
  ...MEMORY_HANDLERS,
  ...PRIME_MEMORY_HANDLERS,
  ...SKILL_HANDLERS,
  ...EXECUTION_HANDLERS,
  ...EXECUTION_OBSERVABILITY_HANDLERS,
  ...REPORTING_HANDLERS,
  ...FACTOR_RESEARCH_HANDLERS,
  ...STRATEGY_EXECUTION_HANDLERS,

  "web.fetch": WEB_FETCH_HANDLER,
  "web.search": WEB_SEARCH_HANDLER,
  edit_agent_pack: async (ctx, params) => {
    const targetRaw = params.target;
    const markdown = typeof params.markdown === "string" ? params.markdown : "";
    const allowed: AgentPackSelfEditTarget[] = ["soul", "user", "memory", "prompt"];
    if (typeof targetRaw !== "string" || !allowed.includes(targetRaw as AgentPackSelfEditTarget)) {
      throw new Error(`edit_agent_pack: invalid target (use one of: ${allowed.join(", ")})`);
    }
    const db = await getDb();
    const profRows = await db
      .select()
      .from(agentProfile)
      .where(eq(agentProfile.definitionId, ctx.definition.id))
      .limit(1);
    const prof = profRows[0];
    const written = await writePackSelfEditMarkdown({
      dataDir: getDataDir(),
      definitionId: ctx.definition.id,
      configRootUri: prof?.configRootUri ?? "",
      soulFileRef: prof?.soulFileRef ?? "",
      promptTemplateRef: prof?.promptTemplateRef,
      target: targetRaw as AgentPackSelfEditTarget,
      markdown,
    });
    return { target: targetRaw, ...written };
  },

  "tool.report_gap": async (ctx, params) => {
    const toolName = String(params.toolName ?? params.tool_name ?? "").trim();
    const serverName = String(params.serverName ?? params.server_name ?? "").trim();
    const reason = String(params.reason ?? params.note ?? "").trim();
    const toolKind = String(params.toolKind ?? params.tool_kind ?? "unknown");
    if (!toolName && !reason) {
      throw new Error("tool.report_gap: 必须提供 toolName 或 reason");
    }
    const projectId = await resolveProjectIdForWorkflow(ctx);
    if (!projectId) {
      throw new Error("tool.report_gap: 无法解析 projectId（workflow 未绑定 project）");
    }
    // 依赖注入式 import（避免 builtin-tools.ts 顶部循环依赖 tool-gap-watcher）
    const watcherMod = await import("../tool-gap-watcher/watcher");
    const sigMod = await import("../tool-gap-watcher/signature");
    let signature: string;
    if (toolName && serverName) {
      signature = sigMod.makeMcpSignature(serverName, toolName);
    } else if (toolName) {
      signature = sigMod.makeToolSignature(toolName);
    } else {
      // 没有具体工具名 → 从 reason 取第一段 ascii / 中文关键词，规避空 signature
      const first =
        reason.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/)?.[0] ??
        reason.match(/[\u4e00-\u9fff]{2,6}/)?.[0] ??
        reason.slice(0, 20);
      signature = sigMod.makeConceptSignature(first || "unspecified");
    }
    const ingest: Parameters<typeof watcherMod.reportExplicitGap>[0] = {
      projectId,
      signature,
      requestedToolKind: toolKind,
      metadata: { reportedByInstance: ctx.agentInstanceId },
    };
    if (reason) ingest.excerpt = reason;
    if (toolName) ingest.requestedToolName = toolName;
    if (ctx.workflowId) ingest.workflowRunId = ctx.workflowId;
    if (ctx.definition.id) ingest.definitionId = ctx.definition.id;
    const r = await watcherMod.reportExplicitGap(ingest);
    return { ok: true, ...r };
  },

  // ─── Exec 能力源（CLI 工具 + 外部 agentic CLI） ──────────────────────────
  // 详见 src/runtime/exec/types.ts 模块注释（2026 "CLI vs MCP" 争论后的 hybrid 方案）
  //
};

async function resolveProjectIdForWorkflow(ctx: BuiltinToolContext): Promise<string> {
  if (ctx.projectId) return ctx.projectId;
  if (!ctx.workflowId) return "";
  const db = await getDb();
  const { workflowRun } = await import("../../db/sqlite/schema");
  const row = (
    await db
      .select({ projectId: workflowRun.projectId })
      .from(workflowRun)
      .where(eq(workflowRun.id, ctx.workflowId))
      .limit(1)
  )[0];
  return row?.projectId ?? "";
}

export function isBuiltinTool(toolName: string): boolean {
  if (isTopologyTeamTool(toolName)) return true;
  return toolName in BUILTIN_HANDLERS;
}

export function isRoutedTool(toolName: string): boolean {
  return Boolean(resolveConnectorForTool(toolName));
}

export async function dispatchBuiltinTool(
  toolName: string,
  ctx: BuiltinToolContext,
  params: Record<string, unknown>
): Promise<unknown> {
  if (isTopologyTeamTool(toolName)) {
    const role = parseRoleFromTopologyTeamTool(toolName);
    if (!role) throw new Error(`Invalid topology tool name: ${toolName}`);
    return dispatchTeamAgentTask(ctx, role, params);
  }
  const handler = BUILTIN_HANDLERS[toolName];
  if (!handler) {
    throw new Error(
      `Tool "${toolName}" is not implemented. Configure a connector route or add a builtin handler.`
    );
  }
  return handler(ctx, params);
}

export function listRegisteredBuiltinTools(): string[] {
  return Object.keys(BUILTIN_HANDLERS);
}
