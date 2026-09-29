import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { researchProgramService } from "../research-program/service";
import type { BuiltinToolContext } from "../tools/types";

/** Advertise the same protocol entry points to quant-capable Core agent specs. */
export const RESEARCH_PROGRAM_ENTRY_TOOLS = [
  "research.protocol.get",
  "research.protocol.create",
  "research.factor.run",
  "research.attempt.list",
  "research.attempt.cancel",
  "factor.get",
  "factor.list",
] as const;

/** Exact names only: discovery, aliases and delegation cannot widen this surface. */
export const CONTROLLED_RESEARCH_TOOLS = new Set<string>([
  ...RESEARCH_PROGRAM_ENTRY_TOOLS,
  "factor.register",
  "update_plan",
  "tool.catalog.search",
  "tool.report_gap",
]);

/** Resolve authority from the persisted workflow, never from model-supplied arguments. */
export async function enforceResearchToolAccess(
  toolName: string,
  ctx: BuiltinToolContext,
  params: Record<string, unknown>
): Promise<{ ctx: BuiltinToolContext; params: Record<string, unknown>; controlled: boolean }> {
  const db = await getDb();
  const workflow = ctx.workflowId
    ? (
        await db
          .select({ projectId: workflowRun.projectId })
          .from(workflowRun)
          .where(eq(workflowRun.id, ctx.workflowId))
          .limit(1)
      )[0]
    : undefined;
  const projectId = workflow?.projectId ?? ctx.projectId;
  const requested = [params.project_id, params.projectId].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  // Check all asserted identities before legacy fallback; switching the argument
  // to an ungoverned project must not escape an existing governed context.
  const ids = [
    ...new Set([projectId, ctx.projectId, ...requested].filter((id): id is string => Boolean(id))),
  ];
  const programs = await Promise.all(ids.map((id) => researchProgramService.get(id)));
  const controlled = programs.some((detail) => detail.program !== null);
  if (
    !controlled &&
    !toolName.startsWith("research.protocol.") &&
    !toolName.startsWith("research.attempt.") &&
    toolName !== "research.factor.run"
  ) {
    return { ctx, params, controlled: false };
  }
  if (!workflow || !projectId) throw new Error("research_tool_requires_persisted_workflow");
  if (ctx.projectId && ctx.projectId !== workflow.projectId)
    throw new Error("research_tool_context_project_mismatch");
  if (requested.some((id) => id !== projectId))
    throw new Error("research_tool_argument_project_mismatch");
  if (controlled && !CONTROLLED_RESEARCH_TOOLS.has(toolName)) {
    throw new Error(
      `research_tool_not_allowed:${toolName}; use research.protocol.get and research.factor.run`
    );
  }
  const scopedParams = { ...params, project_id: projectId, projectId };
  if (controlled && toolName === "factor.register") {
    if (
      (params.lang !== undefined && params.lang !== "qlib_expr") ||
      [params.provider_key, params.providerKey].some(
        (key) => key !== undefined && key !== "qlib_expr"
      )
    ) {
      throw new Error("controlled_research_requires_builtin_qlib_expr");
    }
    Object.assign(scopedParams, {
      lang: "qlib_expr",
      provider_key: "qlib_expr",
      providerKey: "qlib_expr",
      dry_run: false,
      dryRun: false,
      status: "draft",
    });
  }
  return { ctx: { ...ctx, projectId }, params: scopedParams, controlled };
}
