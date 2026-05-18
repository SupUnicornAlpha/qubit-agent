import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { analystSignal, auditLog, midtermMemory } from "../../db/sqlite/schema";
import type { AgentRole } from "../../types/entities";
import type { TaskAssignPayload } from "../../types/a2a";
import { dispatchTaskToRole } from "../agent-pool";
import { getDataDir, writePackSelfEditMarkdown, type AgentPackSelfEditTarget } from "../agent/agent-pack-service";
import { agentProfile } from "../../db/sqlite/schema";
import { detectRegimeFromBars } from "../market/regime";
import { computeDateRangeForLimit, queryBarsRange } from "../market/klines-query";
import {
  computeBollinger,
  computeMacd,
  computeRsi,
  computeSma,
  snapshotIndicators,
} from "../market/technical-indicators";
import { queryMarketNewsBrief } from "../market/news-brief-query";
import { RESEARCH_TEAM_SLOT_SET, runAnalystTeam } from "../msa/analyst-team";
import { fuseSignals, type RawAnalystSignal } from "../msa/signal-fusion";
import { runStockScreener } from "../screener/stock-screener";
import { NativeMemoryConnector } from "../../connectors/memory/native/native.memory.connector";
import type { BuiltinToolContext, BuiltinToolHandler } from "./types";
import { resolveConnectorForTool } from "./tool-routes";

const memoryConnector = new NativeMemoryConnector();

/** Tools implemented in-process (not routed to ACP connectors). */
const BUILTIN_HANDLERS: Record<string, BuiltinToolHandler> = {
  task_decompose: async (ctx, params) => {
    const goal =
      String(params.goal ?? params.task ?? ctx.inboundPayload?.["goal"] ?? ctx.reasonText ?? "").trim();
    const steps = [
      { id: "1", role: "market_data", action: "拉取行情与数据快照", tool: "fetch_klines" },
      { id: "2", role: "orchestrator", action: "启动研究团队分析", tool: "run_analyst_team" },
      { id: "3", role: "backtest", action: "验证策略假设（SMA 或自定义）", tool: "run_backtest" },
      { id: "4", role: "risk", action: "风控评估与签核", tool: "evaluate_risk" },
    ];
    return { goal, steps, workflowId: ctx.workflowId };
  },

  assign_task: async (ctx, params) => {
    const role = String(params.role ?? params.targetRole ?? "").trim() as AgentRole;
    if (!role) throw new Error("assign_task: role is required");
    const payload: TaskAssignPayload = {
      taskType: String(params.taskType ?? "task_assign"),
      goal: String(params.goal ?? params.message ?? ""),
      ...(typeof params.payload === "object" && params.payload
        ? (params.payload as Record<string, unknown>)
        : {}),
    };
    const { runId } = await dispatchTaskToRole({
      workflowId: ctx.workflowId,
      role,
      payload,
      traceId: ctx.traceId,
      senderId: ctx.agentInstanceId,
    });
    return { dispatched: true, role, runId };
  },

  run_analyst_team: async (ctx, params) => {
    const ticker =
      String(params.ticker ?? ctx.inboundPayload?.["ticker"] ?? "").trim() || "UNKNOWN";
    const context = String(params.context ?? ctx.inboundPayload?.["goal"] ?? "");
    const rolesRaw = params.analyst_roles;
    const analystRoles =
      Array.isArray(rolesRaw) && rolesRaw.length > 0
        ? (rolesRaw.filter(
            (r): r is AgentRole => typeof r === "string" && RESEARCH_TEAM_SLOT_SET.has(r)
          ) as AgentRole[])
        : undefined;
    const defIdsRaw = params.analyst_definition_ids;
    const analystDefinitionIds =
      Array.isArray(defIdsRaw) && defIdsRaw.length > 0
        ? defIdsRaw.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        : undefined;
    const agRaw = params.agent_group_id;
    const agentGroupId =
      typeof agRaw === "string" && agRaw.trim()
        ? agRaw.trim()
        : agRaw === null || agRaw === ""
          ? null
          : undefined;
    return runAnalystTeam({
      workflowRunId: ctx.workflowId,
      ticker,
      context: context || undefined,
      agentGroupId,
      analystRoles,
      analystDefinitionIds,
    });
  },

  fuse_signals: async (ctx, params) => {
    const db = await getDb();
    const workflowRunId = String(params.workflowRunId ?? ctx.workflowId);
    const ticker = String(params.ticker ?? "");
    let signals: RawAnalystSignal[] = [];
    if (Array.isArray(params.signals)) {
      signals = params.signals as RawAnalystSignal[];
    } else {
      const rows = await db
        .select()
        .from(analystSignal)
        .where(eq(analystSignal.workflowRunId, workflowRunId));
      signals = rows.map((r) => ({
        definitionId: r.agentInstanceId ?? r.analystRole,
        analystRole: r.analystRole as AgentRole,
        ticker: r.ticker,
        signal: r.signal,
        confidence: r.confidence,
        reasoning: r.reasoning ?? "",
        dataSnapshot: (r.dataSnapshotJson as Record<string, unknown>) ?? {},
      }));
    }
    return fuseSignals({
      workflowRunId,
      signals,
      tickerHint: ticker || undefined,
    });
  },

  edit_agent_pack: async (ctx, params) => {
    const targetRaw = params["target"];
    const markdown = typeof params["markdown"] === "string" ? params["markdown"] : "";
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

  compute_indicators: async (_ctx, params) => {
    const symbol = String(params.symbol ?? params.ticker ?? "").trim();
    if (!symbol) throw new Error("compute_indicators: symbol is required");
    const exchange = String(params.exchange ?? "");
    const timeframe = String(params.timeframe ?? "1d");
    const limit = Math.max(30, Math.min(Number(params.limit ?? 120), 500));
    const { period, startDate, endDate } = computeDateRangeForLimit(timeframe, limit);
    const bars = await queryBarsRange({ symbol, exchange, period, startDate, endDate });
    const closes = bars.map((b) => b.close);
    return {
      symbol,
      barCount: bars.length,
      snapshot: snapshotIndicators(bars, symbol),
      series: {
        sma20: computeSma(closes, 20).slice(-5),
        rsi14: computeRsi(closes, 14).slice(-5),
        macd: computeMacd(closes).macd.slice(-5),
        bollinger: {
          upper: computeBollinger(closes).upper.slice(-5),
          lower: computeBollinger(closes).lower.slice(-5),
        },
      },
    };
  },

  detect_patterns: async (_ctx, params) => {
    const symbol = String(params.symbol ?? params.ticker ?? "").trim();
    if (!symbol) throw new Error("detect_patterns: symbol is required");
    const exchange = String(params.exchange ?? "");
    const { period, startDate, endDate } = computeDateRangeForLimit("1d", 120);
    const bars = await queryBarsRange({ symbol, exchange, period, startDate, endDate });
    const regime = detectRegimeFromBars(bars);
    const closes = bars.map((b) => b.close);
    const fast = computeSma(closes, 5);
    const slow = computeSma(closes, 20);
    const n = closes.length - 1;
    let goldenCross = false;
    let deathCross = false;
    if (n >= 1 && Number.isFinite(fast[n]) && Number.isFinite(slow[n])) {
      goldenCross = fast[n - 1] <= slow[n - 1] && fast[n] > slow[n];
      deathCross = fast[n - 1] >= slow[n - 1] && fast[n] < slow[n];
    }
    return {
      symbol,
      regime,
      patterns: [
        ...(goldenCross ? [{ name: "golden_cross", strength: 0.7 }] : []),
        ...(deathCross ? [{ name: "death_cross", strength: 0.7 }] : []),
      ],
    };
  },

  compute_valuation: async (_ctx, params) => {
    const symbol = String(params.symbol ?? params.ticker ?? "").trim();
    if (!symbol) throw new Error("compute_valuation: symbol is required");
    const exchange = String(params.exchange ?? "");
    const { period, startDate, endDate } = computeDateRangeForLimit("1d", 252);
    const bars = await queryBarsRange({ symbol, exchange, period, startDate, endDate });
    const closes = bars.map((b) => b.close);
    const last = closes[closes.length - 1] ?? 0;
    const mean252 =
      closes.length > 0 ? closes.reduce((a, b) => a + b, 0) / closes.length : last;
    const peProxy = mean252 > 0 ? last / mean252 : null;
    return {
      symbol,
      lastClose: last,
      meanPrice252d: mean252,
      peProxy,
      note: "PE 为价格/252日均价的简化代理，非真实财报 PE；接入财报数据后可替换",
    };
  },

  analyze_industry: async (_ctx, params) => {
    const industry = String(params.industry ?? params.sector ?? "未知行业");
    const symbol = String(params.symbol ?? "");
    return {
      industry,
      symbol,
      framework: ["产业链位置", "竞争格局", "政策敏感度", "景气度"],
      note: "结构化行业分析框架；可结合 fetch_news / fetch_financial_data 填充事实",
    };
  },

  analyze_policy: async (_ctx, params) => {
    const region = String(params.region ?? "CN");
    const topic = String(params.topic ?? params.policy ?? "货币政策");
    return {
      region,
      topic,
      dimensions: ["利率路径", "流动性", "财政刺激", "监管取向"],
      note: "政策分析提纲；建议配合新闻工具与宏观数据验证",
    };
  },

  compute_macro_indicators: async (_ctx, params) => {
    const benchmark = String(params.benchmark ?? params.symbol ?? "000300");
    const exchange = String(params.exchange ?? "SH");
    const { period, startDate, endDate } = computeDateRangeForLimit("1d", 120);
    const bars = await queryBarsRange({
      symbol: benchmark,
      exchange,
      period,
      startDate,
      endDate,
    });
    const regime = detectRegimeFromBars(bars);
    return {
      benchmark,
      regime: regime.regime,
      features: regime.features,
      riskAppetite:
        regime.regime.includes("uptrend") || regime.regime === "drift_up"
          ? "risk_on"
          : regime.regime.includes("down") || regime.regime === "high_volatility"
            ? "risk_off"
            : "neutral",
    };
  },

  fetch_macro_data: async (_ctx, params) => {
    return BUILTIN_HANDLERS.compute_macro_indicators(_ctx, params);
  },

  analyze_social_media: async (_ctx, params) => {
    const keywords = Array.isArray(params.keywords)
      ? params.keywords.map(String)
      : [String(params.symbol ?? params.ticker ?? "")];
    const brief = await queryMarketNewsBrief({
      symbol: keywords[0] ?? "",
      exchange: String(params.exchange ?? ""),
      limit: 8,
    });
    return {
      keywords,
      discussionVolume: brief.items.length,
      headlines: brief.items.slice(0, 5).map((i) => i.title),
      note: "基于新闻头条的舆情代理；完整社交数据需外接 API",
    };
  },

  get_analyst_ratings: async (_ctx, params) => {
    const symbol = String(params.symbol ?? params.ticker ?? "").trim();
    return {
      symbol,
      ratings: [],
      note: "卖方评级需外接数据源；当前返回空列表并提示接入方式",
    };
  },

  write_memory: async (ctx, params) => {
    await memoryConnector.init({});
    const content = String(params.content ?? params.text ?? "");
    if (!content.trim()) throw new Error("write_memory: content is required");
    const record = await memoryConnector.add(content, {
      layer: (params.layer as "session" | "midterm" | "longterm") ?? "midterm",
      asofTime: new Date().toISOString(),
      projectId: String(params.projectId ?? ctx.projectId ?? ""),
      definitionId: ctx.definition.id,
      workflowRunId: ctx.workflowId,
      memoryType: String(params.memoryType ?? "research_note"),
    });
    return { memoryId: record.id };
  },

  search_memory: async (ctx, params) => {
    await memoryConnector.init({});
    const query = String(params.query ?? params.q ?? "");
    const records = await memoryConnector.search(
      query,
      {
        projectId: String(params.projectId ?? ctx.projectId ?? ""),
        definitionId: ctx.definition.id,
      },
      Number(params.topK ?? 8)
    );
    return { query, results: records };
  },

  cleanup_ttl: async (ctx, params) => {
    const db = await getDb();
    const projectId = String(params.projectId ?? ctx.projectId ?? "");
    const maxAgeDays = Number(params.maxAgeDays ?? 90);
    const cutoff = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
    const rows = projectId
      ? await db.select().from(midtermMemory).where(eq(midtermMemory.projectId, projectId))
      : await db.select().from(midtermMemory).limit(200);
    const stale = rows.filter((r) => r.timeWindowEnd < cutoff);
    return {
      scanned: rows.length,
      staleCount: stale.length,
      note: "TTL 清理预览；物理删除可在后续版本启用",
    };
  },

  write_audit_log: async (ctx, params) => {
    const db = await getDb();
    const id = randomUUID();
    await db.insert(auditLog).values({
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
      `# 研究报告`,
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
    return runStockScreener({
      workflowRunId: ctx.workflowId,
      universe: params.universe as "CN-A" | "US" | "HK" | undefined,
      criteria: params.criteria as Record<string, number> | undefined,
      topN: Number(params.topN ?? 10),
    });
  },
};

export function isBuiltinTool(toolName: string): boolean {
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
