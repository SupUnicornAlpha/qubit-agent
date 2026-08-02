import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { analystSignal } from "../../db/sqlite/schema";
import { appendAuditLog } from "../audit/audit-chain-service";
import { runStockScreener } from "../screener/stock-screener";
import type { BuiltinToolHandler } from "./types";

export const REPORTING_HANDLERS: Record<string, BuiltinToolHandler> = {
  write_audit_log: async (ctx, params) => {
    const db = await getDb();
    const id = randomUUID();
    await appendAuditLog(db, {
      id,
      traceId: ctx.traceId,
      workflowRunId: ctx.workflowId,
      agentInstanceId: ctx.agentInstanceId,
      actorType: "agent",
      actorId: ctx.definition.id,
      action: String(params.action ?? "tool_audit"),
      resourceType: String(params.resourceType ?? "workflow"),
      resourceId: String(params.resourceId ?? ctx.workflowId),
      detailJson: (params.detail ?? params) as Record<string, unknown>,
    });
    return { auditLogId: id };
  },

  generate_report: async (ctx, params) => {
    const db = await getDb();
    const signals = await db
      .select()
      .from(analystSignal)
      .where(eq(analystSignal.workflowRunId, ctx.workflowId));
    const sections = [
      "# 研究报告",
      `工作流: ${ctx.workflowId}`,
      `标的: ${String(params.ticker ?? signals[0]?.ticker ?? "—")}`,
      `分析师信号数: ${signals.length}`,
      ...signals.map(
        (s) => `- **${s.analystRole}**: ${s.signal} (置信度 ${(s.confidence * 100).toFixed(0)}%)`
      ),
    ];
    return { markdown: sections.join("\n\n"), signalCount: signals.length };
  },

  run_screener: async (ctx, params) => {
    const criteriaRaw = params.criteria;
    const criteria =
      criteriaRaw && typeof criteriaRaw === "object" && !Array.isArray(criteriaRaw)
        ? (criteriaRaw as Record<string, unknown>)
        : {};
    const universe = params.universe as "CN-A" | "US" | "HK" | "CRYPTO" | "ALL" | undefined;
    return runStockScreener({
      workflowRunId: ctx.workflowId,
      ...(universe ? { universe } : {}),
      criteria: {
        ...(typeof criteria.minMarketCapBillion === "number"
          ? { minMarketCapBillion: criteria.minMarketCapBillion as number }
          : {}),
        ...(typeof criteria.maxPe === "number" ? { maxPe: criteria.maxPe as number } : {}),
        ...(typeof criteria.minMomentum30d === "number"
          ? { minMomentum30d: criteria.minMomentum30d as number }
          : {}),
        ...(typeof criteria.sector === "string" ? { sector: criteria.sector as string } : {}),
        ...(typeof criteria.industry === "string" ? { industry: criteria.industry as string } : {}),
        ...(typeof criteria.country === "string" ? { country: criteria.country as string } : {}),
        ...(typeof criteria.minQuality === "number"
          ? { minQuality: criteria.minQuality as number }
          : {}),
        ...(typeof criteria.minSentiment === "number"
          ? { minSentiment: criteria.minSentiment as number }
          : {}),
      },
      topN: Number(params.topN ?? 10),
    });
  },
};
