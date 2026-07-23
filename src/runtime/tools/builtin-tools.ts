import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NativeMemoryConnector } from "../../connectors/memory/native/native.memory.connector";
import { getDb } from "../../db/sqlite/client";
import { analystSignal, longtermMemory, midtermMemory } from "../../db/sqlite/schema";
import { appendAuditLog } from "../audit/audit-chain-service";
import { agentProfile, workflowRun } from "../../db/sqlite/schema";
import { stepStreamBus } from "../langgraph/event-stream";
import { resolveAgentControlMode } from "../../types/loop";
import type { AgentPlanSnapshot, AgentPlanStepStatus } from "../agent-control-mode";
import type { TaskAssignPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import type { AnalystSignalValue } from "../../types/entities";
import type { AgentSkillOutcome } from "../../types/entities";
import { dispatchTaskToRole } from "../agent-pool";
import { getA2AGather } from "../a2a/a2a-gather";
import {
  type AgentPackSelfEditTarget,
  getDataDir,
  writePackSelfEditMarkdown,
} from "../agent/agent-pack-service";
import { backtestJobService } from "../backtest/backtest-job-service";
import { discoveryService } from "../discovery/discovery-service";
import type { DiscoveryKind } from "../discovery/discovery-service";
import {
  recommendationService,
  type RecommendationSide,
} from "../effect-validation/recommendation-service";
import { writeExecCallLog } from "../exec/exec-call-log";
import { getExecProvider } from "../exec/registry";
import { checkArgs, checkCwdScope, renderArgTemplate, runExec } from "../exec/runner";
import type { ExecResult } from "../exec/types";
import { factorService } from "../factor/factor-service";
import type { FactorCategory, FactorLang, FactorStatus } from "../factor/factor-service";
import { factorBacktestPromotionService } from "../quant/factor-backtest-promotion-service";
import { computeDateRangeForLimit, queryBarsRange } from "../market/klines-query";
import { queryMarketNewsBrief } from "../market/news-brief-query";
import { resolveTickerMarket } from "../market/resolve-ticker-market";
import { listMarketDataSources } from "../market/market-data-source-control";
import { getMarketDataReadiness } from "../market/market-data-health";
import { detectRegimeFromBars } from "../market/regime";
import {
  computeBollinger,
  computeMacd,
  computeRsi,
  computeSma,
  snapshotIndicators,
} from "../market/technical-indicators";
import {
  buildParsedResearchTeamFromToolParams,
  runResearchTeamFromOrchestrator,
} from "../msa/research-team-execute";
import { summarizeTeamDecision } from "../msa/analyst-team-pipeline";
import { type RawAnalystSignal, fuseSignals } from "../msa/signal-fusion";
import {
  assertTopologyTargetAllowed,
  isTopologyTeamTool,
  loadOrchestratorTopologyForWorkflow,
  parseRoleFromTopologyTeamTool,
  resolveDispatchRole,
} from "../orchestration/topology-dispatch";
import type { FactorComputeRow, RuleEvalContext } from "../provider/types";
import { ruleService } from "../rule/rule-service";
import type { RuleAppliesTo, RuleLang, RuleStatus } from "../rule/rule-service";
import { runPythonSandbox } from "../sandbox/python-sandbox";
import { runStockScreener } from "../screener/stock-screener";
import { skillService } from "../skills/skill-service";
import { strategyComposer } from "../strategy/strategy-composer";
import type { StrategyKind, WeightMethod } from "../strategy/strategy-composer";
import {
  strategy as strategyTable,
  strategyVersion as strategyVersionTable,
  instrument as instrumentTable,
} from "../../db/sqlite/schema";
import { createOrderIntentWithExecution } from "../execution/order-intent-service";
import type { OrderSide, OrderType, TimeInForce } from "../../types/entities";
import { parseHitlApproval } from "../workflow/hitl-service";
import { writeWorkflowPlanArtifacts } from "../workflow/plan-artifact";
import { isLikelyProjectIdFormat } from "../langgraph/nodes/project-id";
import { resolveConnectorForTool } from "./tool-routes";
import type { BuiltinToolContext, BuiltinToolHandler } from "./types";

const memoryConnector = new NativeMemoryConnector();

/**
 * LLM 经常把 `factor.compute / factor.evaluate / factor.autoEvaluate` 的入参写成：
 *   - factor_ids: ["..."]（复数，模仿其他批量接口）
 *   - factorId（camelCase，模仿 JS 命名风格）
 * 现实工具签名是单数 `factor_id`。这里做防御性别名回退，避免把"猜错参数风格"
 * 的良性错误升级成"硬性 fail"。
 *
 * 优先级：factor_id > factorId > factor_ids[0] > factorIds[0]。
 */
function pickFactorId(params: Record<string, unknown>): string {
  const direct = params["factor_id"] ?? params["factorId"];
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  for (const key of ["factor_ids", "factorIds"]) {
    const arr = params[key];
    if (Array.isArray(arr)) {
      const first = arr.find((v): v is string => typeof v === "string" && v.trim().length > 0);
      if (first) return first.trim();
    }
  }
  return "";
}

/** start_date / startDate；end_date / endDate 等下划线/驼峰双兼容取值。 */
function pickDateParam(params: Record<string, unknown>, snake: "start_date" | "end_date"): string {
  const camel = snake === "start_date" ? "startDate" : "endDate";
  const v = params[snake] ?? params[camel];
  return typeof v === "string" ? v.trim() : "";
}

function optionalFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Tools implemented in-process (not routed to ACP connectors). */
const BUILTIN_HANDLERS: Record<string, BuiltinToolHandler> = {
  "market.resolve_symbol": async (_ctx, params) => {
    const symbol = String(params.symbol ?? params.ticker ?? "").trim();
    if (!symbol) throw new Error("market.resolve_symbol: symbol is required");
    return resolveTickerMarket(symbol, {
      ...(typeof params.exchange === "string" ? { hintExchange: params.exchange } : {}),
    });
  },

  "market.data_sources": async (_ctx, params) => {
    const market = typeof params.market === "string" ? params.market.toUpperCase() : "";
    const timeframe = typeof params.timeframe === "string" ? params.timeframe : "";
    const rows = await listMarketDataSources();
    return {
      readiness: getMarketDataReadiness(),
      sources: rows.filter(
        (row) =>
          (!market || row.supportedMarkets.includes(market)) &&
          (!timeframe || row.supportedTimeframes.includes(timeframe))
      ),
      guidance:
        "先用 market.resolve_symbol 确认市场；再用此健康清单选择源。fetch_klines 会自动按优先级、凭证和熔断状态降级，不要原样重复调用已 open/down 的源。",
    };
  },

  "market.readiness": async () => getMarketDataReadiness(),

  /**
   * update_plan —— 编排器维护一份对用户可见的分步计划/TODO。写入 workflow_run.plan_json 并经 SSE
   * `type:"plan"` 推流给右栏「计划卡片」，并镜像到当前 workflow workspace 的
   * PLAN.md + plan.json。workflow_run.plan_json 是权威态，workspace 文件用于审计、
   * 外部 loop 与恢复。params: { steps: [{id?,title,status?,note?}] }，
   * status ∈ pending|in_progress|done|skipped。
   */
  update_plan: async (ctx, params) => {
    if (ctx.definition.role !== "orchestrator") {
      throw new Error("update_plan: only the workflow orchestrator may update the shared plan");
    }
    const db = await getDb();
    const workflowMeta = (
      await db
        .select({
          projectId: workflowRun.projectId,
          goal: workflowRun.goal,
          loopOptionsJson: workflowRun.loopOptionsJson,
        })
        .from(workflowRun)
        .where(eq(workflowRun.id, ctx.workflowId))
        .limit(1)
    )[0];
    if (!workflowMeta) throw new Error(`update_plan: workflow not found: ${ctx.workflowId}`);
    const mode = resolveAgentControlMode(workflowMeta?.loopOptionsJson);
    const rawSteps = Array.isArray(params.steps) ? params.steps : [];
    const allowed = new Set<AgentPlanStepStatus>([
      "pending",
      "in_progress",
      "done",
      "skipped",
    ]);
    const steps: Array<{
      id: string;
      title: string;
      status: AgentPlanStepStatus;
      note?: string;
    }> = [];
    for (let i = 0; i < rawSteps.length && steps.length < 20; i++) {
      const o = (rawSteps[i] ?? {}) as Record<string, unknown>;
      const title = String(o.title ?? o.text ?? "").trim();
      if (!title) continue;
      const requestedStatus = String(o.status ?? "pending").trim();
      // Plan 模式只设计未来动作，不能把尚未执行的步骤伪装成 done。
      const normalizedStatus = allowed.has(requestedStatus as AgentPlanStepStatus)
        ? (requestedStatus as AgentPlanStepStatus)
        : "pending";
      const status: AgentPlanStepStatus = mode === "plan" ? "pending" : normalizedStatus;
      const note = o.note != null ? String(o.note).slice(0, 300) : undefined;
      steps.push({
        id: (String(o.id ?? "").trim() || `s${i + 1}`).slice(0, 40),
        title: title.slice(0, 200),
        status,
        ...(note ? { note } : {}),
      });
    }
    const completedSteps = steps.filter((step) => step.status === "done").length;
    const skippedSteps = steps.filter((step) => step.status === "skipped").length;
    const hasActive = steps.some((step) => step.status === "in_progress");
    const allTerminal = steps.length > 0 && completedSteps + skippedSteps === steps.length;
    const goalStatus =
      mode === "goal"
        ? allTerminal
          ? completedSteps > 0
            ? "completed"
            : "blocked"
          : hasActive || completedSteps > 0
            ? "executing"
            : "planning"
        : "planning";
    const plan: AgentPlanSnapshot = {
      mode,
      goal: {
        text: workflowMeta.goal,
        status: goalStatus,
        completedSteps,
        totalSteps: steps.length,
      },
      steps,
      updatedAt: new Date().toISOString(),
    };
    await db
      .update(workflowRun)
      .set({ planJson: plan as never })
      .where(eq(workflowRun.id, ctx.workflowId));

    let artifactPaths: Awaited<ReturnType<typeof writeWorkflowPlanArtifacts>> | null = null;
    let workspaceWarning: string | null = null;
    try {
      artifactPaths = await writeWorkflowPlanArtifacts({
        projectId: workflowMeta.projectId,
        workflowRunId: ctx.workflowId,
        plan,
      });
    } catch (e) {
      workspaceWarning = e instanceof Error ? e.message : String(e);
      console.warn(`[update_plan] workspace mirror failed: ${workspaceWarning}`);
    }
    try {
      stepStreamBus.publish({
        runId: ctx.runId,
        workflowId: ctx.workflowId,
        traceId: ctx.traceId,
        role: ctx.definition.role,
        type: "plan",
        stepIndex: 0,
        ts: Date.now(),
        payload: plan as unknown as Record<string, unknown>,
      });
    } catch (e) {
      console.warn(`[update_plan] publish failed: ${(e as Error).message}`);
    }
    return {
      ok: true,
      persisted: true,
      workspaceMirrored: Boolean(artifactPaths),
      workspaceDir: artifactPaths?.workflowDir ?? null,
      ...(workspaceWarning ? { workspaceWarning } : {}),
      stepCount: steps.length,
      done: steps.filter((s) => s.status === "done").length,
    };
  },
  /**
   * web.fetch —— 读取一个公开网页/接口并返回正文文本（Coding-Agent 体验 P2，
   * docs/CODING_AGENT_EXPERIENCE_DESIGN.md）。**只读外联**，带 SSRF 防护：
   *   - 仅 http/https；
   *   - 拒绝 loopback / 内网 / 云元数据地址（防 SSRF）；
   *   - 15s 超时 + 2MB 读取上限 + 正文截断。
   * 调用已由 act.ts 的 tool_call_log 记录（无需额外审计）。
   * params: { url: string, maxChars?: number }。
   * 注：基于 hostname 字面判定，残留 DNS-rebinding 风险（桌面单租户场景威胁较低）。
   */
  "web.fetch": async (_ctx, params) => {
    const raw = String(params.url ?? params.uri ?? "").trim();
    if (!raw) return { ok: false, error: "url is required" };
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, error: `invalid url: ${raw}` };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, error: `unsupported scheme: ${u.protocol}（仅支持 http/https）` };
    }
    const host = u.hostname.toLowerCase();
    const blocked =
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "metadata.google.internal" ||
      host.endsWith(".local") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.startsWith("fc") ||
      host.startsWith("fd");
    if (blocked) {
      return { ok: false, error: `blocked host（loopback/内网/元数据地址）：${host}` };
    }
    const maxChars = Math.min(Number(params.maxChars) || 20000, 60000);
    const maxBytes = 2 * 1024 * 1024;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(u.toString(), {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "qubit-agent/web.fetch" },
      });
      const ctype = res.headers.get("content-type") ?? "";
      const buf = await res.arrayBuffer();
      const bytes = buf.byteLength;
      let text = new TextDecoder().decode(buf.slice(0, maxBytes));
      // 极简正文化：HTML 去 script/style/标签（不引依赖，够给 LLM 读）。
      if (/html/i.test(ctype) || /^\s*</.test(text)) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      return {
        ok: res.ok,
        status: res.status,
        contentType: ctype,
        bytes,
        truncated: text.length > maxChars,
        text: text.slice(0, maxChars),
      };
    } catch (e) {
      const msg = (e as Error).name === "AbortError" ? "timeout (15s)" : (e as Error).message;
      return { ok: false, error: `fetch failed: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  },
  assign_task: async (ctx, params) => {
    const role = String(params.role ?? params.targetRole ?? "").trim() as AgentRole;
    if (!role) throw new Error("assign_task: role is required");
    return dispatchTeamAgentTask(ctx, role, params);
  },

  run_analyst_team: async (ctx, params) => {
    const parsed = buildParsedResearchTeamFromToolParams({
      workflowRunId: ctx.workflowId,
      params: params as Record<string, unknown>,
      ...(ctx.inboundPayload !== undefined ? { inboundPayload: ctx.inboundPayload } : {}),
    });
    return runResearchTeamFromOrchestrator({
      workflowRunId: ctx.workflowId,
      runId: ctx.runId,
      traceId: ctx.traceId,
      parsed,
      hitlApproval: parseHitlApproval(
        (ctx.inboundPayload?.["params"] as Record<string, unknown> | undefined)?.["hitlApproval"]
      ),
      ensureJob: true,
    });
  },

  /**
   * 2026-06 新增：对 `run_analyst_team` 输出做"全局兜底总结"。
   *
   * 设计意图：
   *   - 老路径在 `runAnalystTeam` 内部强制跑一次 LLM 决策汇总，每个 workflow 都多 1 次
   *     ~2-5s 调用 + 让 Orchestrator 出现 ReAct 之外的裸 LLM 调用。
   *   - 新路径把这次调用拆成本工具，由 Orchestrator 在 ReAct loop 中按需调（典型条件：
   *     fusedConfidence < 0.6 / breakdown 信号分歧 / missingRoles >= 2）。
   *   - 工具复用 `ctx.definition.systemPrompt` 作为 Orchestrator 的人格 prompt，保证语义
   *     与历史 `runOrchestratorDecision` 一致。
   *
   * 入参兼容下划线 / 驼峰双风格，避免 LLM 写错参数名硬性失败。
   */
  summarize_team_decision: async (ctx, params) => {
    const fusionSummary = String(params.fusion_summary ?? params.fusionSummary ?? "").trim();
    const ticker = String(params.ticker ?? "").trim();
    if (!fusionSummary || !ticker) {
      throw new Error(
        "summarize_team_decision: fusion_summary 与 ticker 必填（请把 run_analyst_team 返回值中的 fusionSummary 与 ticker 原样传入）"
      );
    }
    const allowedSignals: ReadonlyArray<AnalystSignalValue> = ["buy", "sell", "hold"];
    const rawSignal = String(
      params.msa_signal ?? params.msaSignal ?? params.fused_signal ?? "hold"
    ).toLowerCase();
    const msaSignal = (
      allowedSignals.includes(rawSignal as AnalystSignalValue) ? rawSignal : "hold"
    ) as AnalystSignalValue;
    const confidenceRaw = Number(
      params.msa_confidence ?? params.msaConfidence ?? params.fused_confidence ?? 0.5
    );
    const msaConfidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.5;

    const pickRoles = (key1: string, key2: string): AgentRole[] | undefined => {
      const raw = params[key1] ?? params[key2];
      if (!Array.isArray(raw)) return undefined;
      return raw.filter(
        (r): r is AgentRole => typeof r === "string" && r.length > 0
      ) as AgentRole[];
    };
    const attendedRoles = pickRoles("attended_roles", "attendedRoles");
    const missingRoles = pickRoles("missing_roles", "missingRoles");

    return summarizeTeamDecision({
      workflowRunId: ctx.workflowId,
      ticker,
      orchestratorSystemPrompt: ctx.definition.systemPrompt,
      fusionSummary,
      msaSignal,
      msaConfidence,
      attendedRoles,
      missingRoles,
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
    const mean252 = closes.length > 0 ? closes.reduce((a, b) => a + b, 0) / closes.length : last;
    const peProxy = mean252 > 0 ? last / mean252 : null;
    return {
      symbol,
      lastClose: last,
      meanPrice252d: mean252,
      peProxy,
      note: "PE 为价格/252日均价的简化代理，非真实财报 PE；接入财报数据后可替换",
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
    const items = [...brief.symbolNews, ...brief.sectorNews];
    return {
      keywords,
      discussionVolume: items.length,
      headlines: items.slice(0, 5).map((i) => i.title),
      note: "基于新闻头条的舆情代理；完整社交数据需外接 API",
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

  /**
   * M10.A2: 主动归纳当前工作流 → midterm_memory
   * 通常 workflow 结束时会自动触发，这个工具让 Agent 在执行中也能主动总结。
   */
  "memory.summarize_workflow": async (ctx, params) => {
    const { consolidateFromWorkflow } = await import("../memory/memory-consolidation");
    const workflowId = String(params.workflowId ?? ctx.workflowId ?? "");
    if (!workflowId) throw new Error("memory.summarize_workflow: workflowId is required");
    const result = await consolidateFromWorkflow(workflowId);
    return result;
  },

  /**
   * M10.A2: 把指定 agent 在指定 project 的多条 midterm_memory 提炼成一条 longterm_memory
   * 适用于：Agent 跑完一系列工作流后，主动把"反复出现的有效因子/规则/Playbook"沉淀为长期记忆。
   */
  "memory.consolidate_longterm": async (ctx, params) => {
    const db = await getDb();
    const definitionId = String(params.definitionId ?? ctx.definition.id ?? "");
    const projectId = String(params.projectId ?? ctx.projectId ?? "");
    const memoryType = String(params.memoryType ?? "playbook"); // factor_archive/regime/playbook/postmortem/execution_profile
    const scopeStr = String(params.scope ?? "project") as "org" | "project" | "strategy";
    const content = String(params.content ?? "");
    const confidenceScore = params.confidenceScore != null ? Number(params.confidenceScore) : null;
    if (!content.trim())
      throw new Error("memory.consolidate_longterm: content is required (LLM-generated summary)");
    const now = new Date().toISOString();
    const id = randomUUID();
    await db.insert(longtermMemory).values({
      id,
      scope: scopeStr as never,
      scopeId: scopeStr === "org" ? "default" : projectId || "default",
      definitionId: definitionId || null,
      memoryType: memoryType as never,
      contentJson: { content, ...params, source: "agent_consolidation" },
      embeddingRef: null,
      artifactUri: null,
      validFrom: now,
      validTo: null,
      asofTime: now,
      confidenceScore,
    });
    // 同时刷新 memory.md 让下次启动能读到
    if (definitionId) {
      const { syncMemoryFromDb } = await import("../memory/memory-workspace-sync");
      await syncMemoryFromDb(definitionId);
    }
    return { longtermMemoryId: id, memoryType, scope: scopeStr };
  },

  /**
   * M10.A2: 把当前 Agent 的长期记忆从 DB 刷新到 workspace/memory.md
   * Agent 可以主动调，确保 workspace 文件最新。
   */
  "memory.refresh_workspace": async (ctx, _params) => {
    const { syncMemoryFromDb } = await import("../memory/memory-workspace-sync");
    const result = await syncMemoryFromDb(ctx.definition.id);
    if (!result) return { ok: false, error: "definition not found" };
    return {
      ok: true,
      packMemoryPath: result.packMemoryPath,
      workspaceMemoryPath: result.workspaceMemoryPath,
      longtermCount: result.longtermCount,
      midtermCount: result.midtermCount,
    };
  },

  // ─── M11: Agent 自进化 skill 工具集 ────────────────────────────────────────
  // 设计原则（参考 Hermes Agent）：
  //   - skill.create 在完成复杂任务后调，保存可复用流程
  //   - skill.patch 在使用中发现 skill 过时/不准时立即修正
  //   - skill.view / skill.list 提供给 reason 节点检索之外的手动查阅
  //   - skill.archive 软删（state=archived），可恢复
  //   - skill.use_record 在 act 节点完成后调，写入使用结果驱动 Curator 评分
  "skill.create": async (ctx, params) => {
    const projectId = String(params.projectId ?? params.project_id ?? ctx.projectId ?? "");
    if (!projectId) throw new Error("skill.create: projectId is required");
    const name = String(params.name ?? "").trim();
    const description = String(params.description ?? "").trim();
    const bodyMd = String(params.bodyMd ?? params.body ?? params.content ?? "").trim();
    if (!name) throw new Error("skill.create: name is required");
    if (!description) throw new Error("skill.create: description is required (used for retrieval)");
    if (!bodyMd) throw new Error("skill.create: bodyMd is required (the skill content)");
    const created = await skillService.create({
      projectId,
      definitionId: ctx.definition.id,
      name,
      description,
      bodyMd,
      ...(typeof params.category === "string" ? { category: params.category } : {}),
      ...(params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? { metadata: params.metadata as Record<string, unknown> }
        : {}),
      source: "agent_created",
      createdBy: `agent:${ctx.definition.role}`,
    });
    return {
      skillId: created.id,
      name: created.name,
      version: created.version,
      message: `skill "${created.name}" created. Next time the agent perceives a matching goal it'll be auto-injected.`,
    };
  },

  "skill.view": async (ctx, params) => {
    const projectId = String(params.projectId ?? params.project_id ?? ctx.projectId ?? "");
    const idOrName = String(params.skillId ?? params.id ?? params.name ?? "").trim();
    if (!idOrName) throw new Error("skill.view: skillId or name is required");
    const skill =
      (await skillService.findById(idOrName)) ??
      (await skillService.findByName(projectId, idOrName));
    if (!skill) return { error: `skill not found: ${idOrName}` };
    return skill;
  },

  "skill.list": async (ctx, params) => {
    const projectId = String(params.projectId ?? params.project_id ?? ctx.projectId ?? "");
    if (!projectId) throw new Error("skill.list: projectId is required");
    const opts: {
      includeArchived?: boolean;
      state?: "active" | "stale" | "archived" | "pending_review";
    } = {};
    if (typeof params.includeArchived === "boolean") opts.includeArchived = params.includeArchived;
    if (typeof params.state === "string") {
      const s = params.state as "active" | "stale" | "archived" | "pending_review";
      if (["active", "stale", "archived", "pending_review"].includes(s)) opts.state = s;
    }
    const rows = await skillService.list(projectId, opts);
    return { count: rows.length, skills: rows };
  },

  "skill.search": async (ctx, params) => {
    const projectId = String(params.projectId ?? params.project_id ?? ctx.projectId ?? "");
    if (!projectId) throw new Error("skill.search: projectId is required");
    const query = typeof params.query === "string" ? params.query : "";
    const rows = await skillService.search({
      projectId,
      query,
      definitionId: ctx.definition.id,
      topK: Number(params.topK ?? 5),
    });
    return { query, count: rows.length, skills: rows };
  },

  "skill.patch": async (ctx, params) => {
    const skillId = String(params.skillId ?? params.id ?? "").trim();
    if (!skillId) throw new Error("skill.patch: skillId is required");
    const patchInput: Parameters<typeof skillService.patch>[0] = {
      skillId,
    };
    if (typeof params.description === "string") patchInput.description = params.description;
    if (typeof params.bodyMd === "string") patchInput.bodyMd = params.bodyMd;
    if (typeof params.body === "string") patchInput.bodyMd = params.body;
    if (typeof params.content === "string") patchInput.bodyMd = params.content;
    if (typeof params.category === "string") patchInput.category = params.category;
    if (typeof params.pinned === "boolean") patchInput.pinned = params.pinned;
    if (typeof params.state === "string") {
      const s = params.state as "active" | "stale" | "archived" | "pending_review";
      if (["active", "stale", "archived", "pending_review"].includes(s)) patchInput.state = s;
    }
    if (params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)) {
      patchInput.metadata = params.metadata as Record<string, unknown>;
    }
    if (typeof params.bumpVersion === "boolean") patchInput.bumpVersion = params.bumpVersion;
    else patchInput.bumpVersion = true;
    const updated = await skillService.patch(patchInput);
    return {
      skillId: updated.id,
      name: updated.name,
      version: updated.version,
      state: updated.state,
      message: "skill patched",
    };
  },

  "skill.archive": async (_ctx, params) => {
    const skillId = String(params.skillId ?? params.id ?? "").trim();
    if (!skillId) throw new Error("skill.archive: skillId is required");
    const reason = typeof params.reason === "string" ? params.reason : undefined;
    const archived = await skillService.archive(skillId, reason);
    return {
      skillId: archived.id,
      state: archived.state,
      message: "skill archived (recoverable via skill.patch state=active)",
    };
  },

  "skill.use_record": async (ctx, params) => {
    /**
     * 2026-06-05 监控复盘 #3 修复：
     *   旧实现：硬把 LLM 传的 skillId 透传给 skillService.recordUsage（只查 UUID），
     *   找不到 silent return，response 假报 `recorded:true` → 最近 1d 36 次调用 0 条
     *   agent_skill_run 落表。
     *
     *   新实现：
     *   1) 透传 projectId 让 service 能走 findByName fallback；
     *   2) 真没找到时（service throw）catch 住，return `{recorded:false, hint, candidates}`
     *      给 LLM —— 下一轮可以用正确的 skillId 重试，而不是被骗以为成功了。
     */
    const skillId = String(params.skillId ?? params.id ?? params.name ?? "").trim();
    if (!skillId) throw new Error("skill.use_record: skillId is required");
    const outcomeRaw = String(params.outcome ?? "unknown") as AgentSkillOutcome;
    const outcome: AgentSkillOutcome = ["success", "fail", "partial", "unknown"].includes(
      outcomeRaw
    )
      ? outcomeRaw
      : "unknown";
    try {
      await skillService.recordUsage({
        skillId,
        projectId: ctx.projectId,
        workflowRunId: ctx.workflowId,
        agentInstanceId: ctx.agentInstanceId,
        definitionId: ctx.definition.id,
        outcome,
        score: typeof params.score === "number" ? params.score : 0,
        notes: typeof params.notes === "string" ? params.notes : "",
      });
      return { skillId, outcome, recorded: true };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith("skill_not_found:")) {
        const candidates = ctx.projectId
          ? await skillService.list(ctx.projectId, { includeArchived: false })
          : [];
        return {
          recorded: false,
          error: msg,
          hint:
            "传入的 skillId 既不是 UUID 也不是本 project 下任何 active skill 的 name；" +
            "用下面 candidates 里的 id 或 name 重试，或先调 skill.create 注册一个新的。",
          candidates: candidates.slice(0, 20).map((s) => ({ id: s.id, name: s.name })),
        };
      }
      throw err;
    }
  },

  "skill.import_market": async (ctx, params) => {
    const installId = String(params.installId ?? params.skillInstallId ?? "").trim();
    if (!installId) throw new Error("skill.import_market: installId is required");
    const bodyMd = typeof params.bodyMd === "string" ? params.bodyMd : undefined;
    const mirrored = await skillService.mirrorFromMarketInstall(
      installId,
      bodyMd ? { bodyMd } : undefined
    );
    if (!mirrored) return { ok: false, error: "install not found or not installed" };
    return { ok: true, skillId: mirrored.id, name: mirrored.name };
  },

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
    const criteriaRaw = params.criteria;
    const criteria =
      criteriaRaw && typeof criteriaRaw === "object" && !Array.isArray(criteriaRaw)
        ? (criteriaRaw as Record<string, unknown>)
        : {};
    return runStockScreener({
      workflowRunId: ctx.workflowId,
      universe: params.universe as "CN-A" | "US" | "HK" | "CRYPTO" | "ALL" | undefined,
      criteria: {
        ...(typeof criteria["minMarketCapBillion"] === "number"
          ? { minMarketCapBillion: criteria["minMarketCapBillion"] as number }
          : {}),
        ...(typeof criteria["maxPe"] === "number" ? { maxPe: criteria["maxPe"] as number } : {}),
        ...(typeof criteria["minMomentum30d"] === "number"
          ? { minMomentum30d: criteria["minMomentum30d"] as number }
          : {}),
        ...(typeof criteria["sector"] === "string" ? { sector: criteria["sector"] as string } : {}),
        ...(typeof criteria["industry"] === "string"
          ? { industry: criteria["industry"] as string }
          : {}),
        ...(typeof criteria["country"] === "string"
          ? { country: criteria["country"] as string }
          : {}),
        ...(typeof criteria["minQuality"] === "number"
          ? { minQuality: criteria["minQuality"] as number }
          : {}),
        ...(typeof criteria["minSentiment"] === "number"
          ? { minSentiment: criteria["minSentiment"] as number }
          : {}),
      },
      topN: Number(params.topN ?? 10),
    });
  },

  // ─── M2：因子/规则/策略 三段式 Agent 工具 ────────────────────────────────
  // 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.1-6.3
  // 调用方向：handler → Service → ProviderResolver → 具体 Provider 实现

  "factor.register": async (ctx, params) => {
    const projectId = String(params.project_id ?? ctx.projectId ?? "").trim();
    if (!projectId) throw new Error("factor.register: project_id is required");
    const definitionRaw = params.definition;
    const definition =
      definitionRaw && typeof definitionRaw === "object" && !Array.isArray(definitionRaw)
        ? (definitionRaw as Record<string, unknown>)
        : undefined;
    /**
     * P0-2: Agent 触发的因子注册默认启用 dry-run 闸门（详见 AGENT_STABILITY_REVIEW.md §四-P0-2）。
     * - LLM 显式传 dry_run=false / 0 / "off" 时可关闭（仅供 IDE / 调试场景；不建议生产路径关）
     * - 自定义阈值：dry_run = { minRows: 20, minVariance: 1e-10 }
     */
    const dryRunParam = params.dry_run ?? params.dryRun;
    let dryRun: boolean | { minRows?: number; minVariance?: number } = true;
    if (
      dryRunParam === false ||
      dryRunParam === "false" ||
      dryRunParam === 0 ||
      dryRunParam === "off"
    ) {
      dryRun = false;
    } else if (dryRunParam && typeof dryRunParam === "object" && !Array.isArray(dryRunParam)) {
      const cfg: { minRows?: number; minVariance?: number } = {};
      const dr = dryRunParam as Record<string, unknown>;
      if (dr.min_rows !== undefined) cfg.minRows = Number(dr.min_rows);
      if (dr.minRows !== undefined) cfg.minRows = Number(dr.minRows);
      if (dr.min_variance !== undefined) cfg.minVariance = Number(dr.min_variance);
      if (dr.minVariance !== undefined) cfg.minVariance = Number(dr.minVariance);
      dryRun = cfg;
    }
    const expr = String(
      params.expr ?? params.expression ?? params.factor_expression ?? params.factorExpression ?? ""
    ).trim();
    return factorService.register({
      projectId,
      name: String(params.name ?? "").trim(),
      category: String(params.category ?? "momentum") as FactorCategory,
      expr,
      ...(params.lang ? { lang: String(params.lang) as FactorLang } : {}),
      ...(params.universe ? { universe: String(params.universe) } : {}),
      ...(params.horizon !== undefined ? { horizon: Number(params.horizon) } : {}),
      ...(params.status ? { status: String(params.status) as FactorStatus } : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
      ...(definition ? { definition } : {}),
      // ctx.workflowId 在 langgraph act 节点保证非空；落库后用于研究产出严格过滤
      ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
      // lineage（migration 0080）：所有 builtin tool 路径默认归为 'agent'，
      // 让前端 LineageBadge 能与 IDE / REST 直接调用的 'user' 路径区分。
      createdBy: "agent",
      ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
      dryRun,
    });
  },

  "factor.compute": async (_ctx, params) => {
    /**
     * 入参兼容：
     *   - factor_id（推荐）/ factorId（camelCase）/ factor_ids[0]（LLM 误用复数）
     *   - start_date / startDate ；end_date / endDate
     *
     * 历史 bug：LLM 凭训练记忆把 factor.compute 写成
     *   `compute_factors({factor_ids:[..], startDate, endDate})`
     * 直接抛"factor_id is required"，整条 research → backtest 流水线断掉。
     * 工具层做防御性别名映射 + builtin alias 已把 compute_factors 路由到 factor.compute，
     * 这样 LLM 即使猜错参数风格也能跑通。
     */
    const factorId = pickFactorId(params);
    if (!factorId) {
      throw new Error("factor.compute: factor_id (or factor_ids[0]) is required");
    }
    const symbolsRaw = params.symbols;
    const symbols = Array.isArray(symbolsRaw)
      ? symbolsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : undefined;
    const result = await factorService.compute({
      factorId,
      startDate: pickDateParam(params, "start_date"),
      endDate: pickDateParam(params, "end_date"),
      ...(symbols && symbols.length > 0 ? { symbols } : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
    });
    if (result.meta.rowCount === 0) {
      throw new Error(
        `factor.compute: no_factor_values_written (factor_id=${factorId}). ` +
          "行情源在该 symbols/区间没有返回可计算数据；不要继续调用 factor.autoEvaluate。" +
          "请切换可用数据源、市场或 symbols 后最多重试一次；仍为空则明确报告数据不可用并终止因子评估。"
      );
    }
    return result;
  },

  "factor.evaluate": async (_ctx, params) => {
    const factorId = pickFactorId(params);
    if (!factorId) throw new Error("factor.evaluate: factor_id is required");
    const valuesRaw = params.values;
    const values = Array.isArray(valuesRaw) ? (valuesRaw as FactorComputeRow[]) : [];
    const futureRaw = params.future_returns;
    const futureReturns = Array.isArray(futureRaw) ? (futureRaw as FactorComputeRow[]) : undefined;
    return factorService.evaluate({
      factorId,
      values,
      ...(futureReturns ? { futureReturns } : {}),
      ...(params.asof ? { asof: String(params.asof) } : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
    });
  },

  "rule.register": async (ctx, params) => {
    const projectId = String(params.project_id ?? ctx.projectId ?? "").trim();
    if (!projectId) throw new Error("rule.register: project_id is required");
    if (params.dsl === undefined) throw new Error("rule.register: dsl is required");
    return ruleService.register({
      projectId,
      name: String(params.name ?? "").trim(),
      ...(params.description ? { description: String(params.description) } : {}),
      ...(params.applies_to ? { appliesTo: String(params.applies_to) as RuleAppliesTo } : {}),
      ...(params.lang ? { lang: String(params.lang) as RuleLang } : {}),
      dsl: params.dsl,
      ...(params.status ? { status: String(params.status) as RuleStatus } : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
      // lineage（migration 0080）：tool 路径全部标 agent
      createdBy: "agent",
      ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
      ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
    });
  },

  "rule.evaluate": async (_ctx, params) => {
    const ruleId = String(params.rule_id ?? "").trim();
    if (!ruleId) throw new Error("rule.evaluate: rule_id is required");
    const contextRaw = params.context;
    if (!contextRaw || typeof contextRaw !== "object" || Array.isArray(contextRaw)) {
      throw new Error("rule.evaluate: context object is required");
    }
    return ruleService.evaluate({
      ruleId,
      context: contextRaw as unknown as RuleEvalContext,
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
    });
  },

  "factor.list": async (ctx, params) => {
    const projectId = String(params.project_id ?? ctx.projectId ?? "").trim();
    if (!projectId) throw new Error("factor.list: project_id is required");
    return factorService.list({
      projectId,
      ...(params.category ? { category: String(params.category) as FactorCategory } : {}),
      ...(params.status ? { status: String(params.status) as FactorStatus } : {}),
    });
  },

  "factor.autoEvaluate": async (ctx, params) => {
    /**
     * 一步式自动评估入参兼容（E1 修复）。
     *
     * 历史 bug（WF 44ca3acf 实测）：LLM 沿用旧 `run_experiment` 风格，传入
     *   `{name, description, factor_expression, symbols, start_date, end_date, horizon_days}`
     * alias resolver 把 `run_experiment` 翻成 `factor.autoEvaluate`，
     * 但参数 schema 完全不同 —— autoEvaluate 要 `factor_id`，旧 run_experiment
     * 是"传 expr 直接跑"。结果 LLM 收到 3 次 `factor_id is required`，
     * 整个 fundamental/technical 因子链路断掉。
     *
     * 兼容方案：当 LLM 传了 expr/factor_expression 但没传 factor_id，
     * 我们就**先 factor.register（dryRun=false）** 拿 id，再 autoEvaluate，
     * 把"一步式"对外暴露的语义补回去。
     */
    let factorId = pickFactorId(params);
    const exprRaw =
      typeof params["factor_expression"] === "string"
        ? params["factor_expression"]
        : typeof params["expr"] === "string"
          ? (params["expr"] as string)
          : "";
    const isOneShot = exprRaw.trim().length > 0 && !factorId;

    const startDate = pickDateParam(params, "start_date");
    const endDate = pickDateParam(params, "end_date");
    if (!startDate || !endDate) {
      throw new Error("factor.autoEvaluate: start_date and end_date are required");
    }

    if (!factorId && exprRaw.trim().length > 0) {
      /**
       * 双保险（B+ Phase 1.1）：act 入口已 rewrite placeholder，但这里仍做
       * 形态校验，避免任何旁路绕过 act（e.g. 直接 dispatchBuiltinTool 单测）。
       *
       * 优先级：ctx.projectId（来自 workflow_run.project_id）> params["project_id"]
       *   （仅当形态合法时使用），其他情况报清晰错误。
       */
      const fromParams = String(params["project_id"] ?? "").trim();
      const projectId = ctx.projectId
        ? ctx.projectId
        : isLikelyProjectIdFormat(fromParams)
          ? fromParams
          : "";
      if (!projectId) {
        throw new Error(
          "factor.autoEvaluate: factor_id 缺失且无可用 project_id，无法自动注册因子。请先 factor.register 拿到 factor_id，再调 factor.autoEvaluate。"
        );
      }
      const name = String(params["name"] ?? `auto_${Date.now()}`).trim();
      /**
       * 2026-06-05 P1 修复（监控复盘 #3）：name idempotent reuse。
       *
       * LLM 收到 `no_factor_values: factor=X; 先跑 compute` 后经常**用同 name + 同
       * expr 再调一遍 autoEvaluate**（错误地以为重试就能跳过 compute 步骤）。
       * 旧实现里 register 触发 `factor_name_already_exists` → autoEvaluate 直接挂，
       * LLM 看到这个错也不知道该改用 factor.compute → 死循环。
       * 现在 catch 该错误，inline 查 existing factor 的 id 复用，返回业务正确的
       * `no_factor_values` 继续提示去 compute，链路一致。
       */
      try {
        const registered = await factorService.register({
          projectId,
          name,
          category: String(params["category"] ?? "momentum") as FactorCategory,
          expr: exprRaw.trim(),
          ...(params["lang"]
            ? { lang: String(params["lang"]) as FactorLang }
            : { lang: "qlib_expr" as FactorLang }),
          ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
          createdBy: "agent",
          ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
          /** F-P0-10：标识此次 register 是 autoEvaluate 内部副作用 → emit team-graph interaction */
          autoRegisteredVia: "factor.autoEvaluate",
          agentRole: ctx.definition.role,
        });
        factorId = registered.id;
      } catch (err) {
        const msg = (err as Error).message || "";
        if (msg.includes("factor_name_already_exists")) {
          const existing = await factorService.findByProjectAndName(projectId, name);
          if (existing) {
            factorId = existing.id;
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      /**
       * B+ Phase T1.2：register 成功 / 复用既有 id 后，**自动跑一次 compute**
       * 把 factor_value 落到 DuckDB，避免随后的 autoEvaluate 抛 `no_factor_values`。
       *
       * 历史：12/12 失败诊断中 6 次都是 LLM 用一步式 expr+name 调用，handler 只
       * register 没 compute → autoEvaluate 拉空 values 报 no_factor_values → LLM
       * 习惯性重试 autoEvaluate（同名 → already_exists / 复用 id → 还是空 values）→
       * 死循环。修复后 register-then-compute-then-evaluate 三步走 atomically。
       *
       * 容错：compute 失败不直接抛，而是把错误信息附在 autoEvaluate 抛错里给
       * LLM，避免 compute 的 provider/缺数据问题被吞掉。
       */
      const computeSymbolsRaw = params.symbols;
      const computeSymbols = Array.isArray(computeSymbolsRaw)
        ? computeSymbolsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        : undefined;
      try {
        const computeResult = await factorService.compute({
          factorId,
          startDate,
          endDate,
          ...(computeSymbols && computeSymbols.length > 0 ? { symbols: computeSymbols } : {}),
          ...(params["provider_key"] ? { providerKey: String(params["provider_key"]) } : {}),
        });
        if (computeResult.meta.rowCount === 0) {
          throw new Error(
            "no_factor_values_written: 行情源在该 symbols/区间没有返回可计算数据；" +
              "不要继续 autoEvaluate，请切换数据源、市场或 symbols 后最多重试一次。"
          );
        }
      } catch (err) {
        const partial = isOneShot
          ? `partial_success: factor_definition 已创建（factor_id=${factorId}），但 factor_evaluation 未创建。`
          : `factor_id=${factorId}`;
        throw new Error(
          `factor.autoEvaluate: ${partial} 内部 factor.compute 失败: ${(err as Error).message}。` +
            "请检查 expr 语法 / symbols 是否有真实 K 线数据 / provider 是否可用。"
        );
      }
    }

    if (!factorId) {
      throw new Error(
        "factor.autoEvaluate: 调用必须满足以下任一：(A) 传 `factor_id` (UUID, 来自 factor.register 或 factor.list)；" +
          "(B) 一步式新因子模式：同时传 `factor_expression` (或 `expr`) + `name` + `project_id`。" +
          "你两种参数都没传 —— 先用 factor.list 看本项目下已有因子，或直接传 expr+name 走 (B) 模式。"
      );
    }
    const symbolsRaw = params.symbols;
    const symbols = Array.isArray(symbolsRaw)
      ? symbolsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : undefined;

    /**
     * P0-3 修（Round 6 复盘）：早拦 cross-section symbol 不足。
     *
     * Round 6 实测 LLM 用已存在的 factor_id + `symbols=["AAPL"]` 直接调 autoEvaluate
     * （**纯 evaluate 路径**，不走一步式 register+compute），下游 IC=0/RankIC=0/IR=0，
     * 但顶层 result="ok" → LLM 把脏 0 写进 strategy。在工具入口就抛清晰错误。
     *
     * 范围限制：**仅纯 evaluate 路径** 校验（即用户传 factor_id 而非一步式 expr）。
     * 一步式（exprRaw 非空 → 先 register+compute）放过，让 service 层 cross_section_too_few_symbols
     * 在 evaluate 之前兜底；这样既不破坏一步式的合法测试入参，又能在 LLM 直接 evaluate 时教育它。
     *
     * 允许例外：LLM 没传 symbols（symbols=undefined）→ service 层用 factor_value 表里
     * 已存在的全部 symbols（factor.compute 时录的），service 层会做最终防线检查。
     */
    if (!isOneShot && symbols !== undefined && symbols.length > 0 && symbols.length < 3) {
      throw new Error(
        `factor.autoEvaluate: symbols 数量过少（当前 ${symbols.length} 只: ${symbols.join(",")}）。` +
          "IC/RankIC 是 **横截面** 指标，每日至少需要 3 只 symbols 才能计算 Pearson/Spearman；推荐 ≥ 10 只。" +
          '请改用 ≥3 只 symbols 重跑，例如 ["AAPL","MSFT","NVDA","GOOG","META"]，或不传 symbols（用 factor.compute 时录入的全部 symbols）。'
      );
    }

    const decayRaw = params.decay_horizons;
    const decayHorizons = Array.isArray(decayRaw)
      ? decayRaw.filter((n): n is number => typeof n === "number")
      : undefined;
    const evaluateInput = {
      factorId,
      startDate,
      endDate,
      ...(symbols && symbols.length > 0 ? { symbols } : {}),
      ...(params.horizon_days !== undefined ? { horizonDays: Number(params.horizon_days) } : {}),
      ...(decayHorizons && decayHorizons.length > 0 ? { decayHorizons } : {}),
      ...(params.group_count !== undefined ? { groupCount: Number(params.group_count) } : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
    };
    try {
      return await factorService.autoEvaluate(evaluateInput);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      /**
       * 已有 factor_id 路径也做一次 compute→evaluate 自愈。
       *
       * 原先只有 expr 一步式路径会自动 compute；模型从 factor.list 拿到既有 id 后
       * 直接 autoEvaluate，遇到 no_factor_values 必须自己再拼一次 compute，实测经常
       * 连续重试 autoEvaluate。工具层只自愈一次，零行则明确终止，避免循环。
       */
      if (isOneShot || !message.includes("no_factor_values")) throw err;
      const computeResult = await factorService.compute({
        factorId,
        startDate,
        endDate,
        ...(symbols && symbols.length > 0 ? { symbols } : {}),
        ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
      });
      if (computeResult.meta.rowCount === 0) {
        throw new Error(
          `factor.autoEvaluate: no_factor_values_written (factor_id=${factorId}). ` +
            "已自动执行一次 factor.compute，但行情源仍未返回数据；不要继续重试 autoEvaluate。" +
            "请切换数据源、市场或 symbols，仍为空则明确报告数据不可用。"
        );
      }
      return factorService.autoEvaluate(evaluateInput);
    }
  },

  /**
   * M9.P5：批量评估多个因子 + 自动聚合统计。
   *
   * 用途：当 Agent 在 factor.list 拿到一组候选因子（如 5-10 个）后，
   *   一次性评估全部并按 RankIC 排序、识别最佳/最差因子；避免多轮工具调用。
   *
   * 实现：串行 autoEvaluate（避免 DuckDB 连接竞争），错误的因子单独标 error
   *   但不中断整批；返回聚合 summary（平均 RankIC、approve 候选数等）。
   *
   * 真要算因子间相关性矩阵：让 Agent 在拿到 batch 结果后用 code.run_python +
   *   factor.compute 取值矩阵自己算（避免本工具变得过重）。
   */
  "factor.evaluate.batch": async (_ctx, params) => {
    const idsRaw = params.factor_ids;
    const factorIds = Array.isArray(idsRaw)
      ? idsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    if (factorIds.length === 0) {
      throw new Error("factor.evaluate.batch: factor_ids (string[]) is required and non-empty");
    }
    if (factorIds.length > 30) {
      throw new Error(
        `factor.evaluate.batch: max 30 factors per batch (got ${factorIds.length}); 拆分多批调用`
      );
    }
    const startDate = String(params.start_date ?? "").trim();
    const endDate = String(params.end_date ?? "").trim();
    if (!startDate || !endDate) {
      throw new Error("factor.evaluate.batch: start_date and end_date are required");
    }
    const symbolsRaw = params.symbols;
    const symbols = Array.isArray(symbolsRaw)
      ? symbolsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : undefined;
    const horizonDays = params.horizon_days !== undefined ? Number(params.horizon_days) : undefined;

    type BatchItem = {
      factor_id: string;
      ic?: number;
      rank_ic?: number;
      ir?: number;
      turnover?: number;
      sample_size?: number;
      latency_ms?: number;
      evaluation_id?: string;
      error?: string;
    };
    const items: BatchItem[] = [];
    let totalLatency = 0;
    for (const fid of factorIds) {
      try {
        const r = await factorService.autoEvaluate({
          factorId: fid,
          startDate,
          endDate,
          ...(symbols && symbols.length > 0 ? { symbols } : {}),
          ...(horizonDays !== undefined ? { horizonDays } : {}),
        });
        items.push({
          factor_id: fid,
          ic: r.ic,
          rank_ic: r.rankIc,
          ir: r.ir,
          turnover: r.turnover,
          sample_size: r.sampleSize,
          latency_ms: r.latencyMs,
          ...(r.evaluationId ? { evaluation_id: r.evaluationId } : {}),
        });
        totalLatency += r.latencyMs ?? 0;
      } catch (e) {
        items.push({
          factor_id: fid,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // 显著性判读阈值（对齐 PROMPT_RESEARCH 中的 HAC 显著性约束）
    const finite = items.filter(
      (i): i is BatchItem & { rank_ic: number; ir: number; sample_size: number } =>
        i.error === undefined &&
        typeof i.rank_ic === "number" &&
        typeof i.ir === "number" &&
        typeof i.sample_size === "number" &&
        Number.isFinite(i.rank_ic) &&
        Number.isFinite(i.ir)
    );
    const significant = finite.filter(
      (i) => Math.abs(i.rank_ic) > 0.02 && Math.abs(i.ir) > 0.5 && i.sample_size >= 60
    );
    const sortedByRankIc = [...finite].sort((a, b) => Math.abs(b.rank_ic) - Math.abs(a.rank_ic));
    const meanRankIc =
      finite.length > 0 ? finite.reduce((sum, i) => sum + i.rank_ic, 0) / finite.length : 0;
    const meanIr = finite.length > 0 ? finite.reduce((sum, i) => sum + i.ir, 0) / finite.length : 0;

    return {
      ok: true,
      requested: factorIds.length,
      succeeded: items.length - items.filter((i) => i.error).length,
      failed: items.filter((i) => i.error).length,
      total_latency_ms: totalLatency,
      summary: {
        mean_rank_ic: meanRankIc,
        mean_ir: meanIr,
        significant_count: significant.length,
        significant_factor_ids: significant.map((s) => s.factor_id),
        best_factor: sortedByRankIc[0]?.factor_id ?? null,
        worst_factor:
          sortedByRankIc.length > 0 ? sortedByRankIc[sortedByRankIc.length - 1]!.factor_id : null,
      },
      results: items,
    };
  },

  /**
   * factor.mine.llm —— P0-4：LLM 一次产 N 个 + 内置评估闸门
   *
   * 详见 docs/AGENT_STABILITY_REVIEW.md §四-P0-4
   *
   * 工作流：
   *   1. 接收 LLM 在 reason 节点一次性生成的 `expressions: string[]`（>= min_count，默认 5）
   *   2. 走 discoveryService(kind=factor_llm)：合成 / 真实数据 → 算每个的 IC + RankIC
   *   3. 按 |IC| 排序，取 top_k（默认 5）
   *   4. 若 `auto_promote=true`（默认 true）：把 |IC| >= ic_threshold（默认 0.02）的候选自动注册为
   *      项目下 `draft` 因子（带 lineage，走 factor.register 同一通道，保留 dry-run 闸门）
   *   5. 返回 jobId + candidates + promoted（包含失败原因，便于 LLM 下一轮调整表达式）
   *
   * 关键稳定性保证：
   *   - expressions.length < min_count → reject（强制 LLM 多产，避免"一次只敢产 1 个但选不到好的"）
   *   - 所有候选 |IC| 都低于阈值 → 仍返回 candidates 但 promoted=0 + warning，让 LLM 重产
   *   - 失败候选（parse/insufficient/error）也回传，**不**计入 promote
   */
  "factor.mine.llm": async (ctx, params) => {
    const projectId = String(params.project_id ?? ctx.projectId ?? "").trim();
    if (!projectId) throw new Error("factor.mine.llm: project_id is required");

    const exprsRaw = params.expressions;
    const expressions = Array.isArray(exprsRaw)
      ? exprsRaw.map((e) => String(e ?? "").trim()).filter(Boolean)
      : [];
    const minCount = Number(params.min_count ?? 5);
    if (expressions.length < minCount) {
      throw new Error(
        `factor.mine.llm: expressions.length(${expressions.length}) < min_count(${minCount}); ` +
          "一次至少产" +
          minCount +
          "个 qlib_expr 表达式以充分利用评估闸门"
      );
    }

    const symbolsRaw = params.symbols;
    const symbols = Array.isArray(symbolsRaw)
      ? symbolsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    if (symbols.length === 0) throw new Error("factor.mine.llm: symbols is required");

    const startDate = String(params.start_date ?? "").trim();
    const endDate = String(params.end_date ?? "").trim();
    if (!startDate || !endDate) {
      throw new Error("factor.mine.llm: start_date and end_date are required");
    }

    const topK = Number(params.top_k ?? 5);
    const horizonDays = params.horizon_days !== undefined ? Number(params.horizon_days) : undefined;
    const icThreshold = Number(params.ic_threshold ?? 0.02);
    const autoPromote = params.auto_promote === false ? false : true;
    const namePrefix = String(params.name_prefix ?? "llm_mined").trim() || "llm_mined";
    const category = (params.category ? String(params.category) : "momentum") as FactorCategory;

    const job = await discoveryService.submitAndRun({
      projectId,
      kind: "factor_llm",
      symbols,
      startDate,
      endDate,
      expressions,
      topK,
      ...(horizonDays !== undefined ? { horizonDays } : {}),
      // 落到 discovery_job.workflow_run_id；promoteCandidate 再透传到 factor.workflow_run_id
      ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
      // lineage（migration 0080）：tool 路径标 agent
      createdBy: "agent",
      ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
    });

    // 候选闸门：只 promote 通过 IC 阈值的
    const eligible = job.candidates.filter(
      (c) => !c.error && Math.abs(c.metrics.ic) >= icThreshold
    );

    const promoted: Array<{
      candidate_id: string;
      factor_id: string;
      name: string;
      ic: number;
      rank_ic: number;
    }> = [];
    const promote_errors: Array<{ candidate_id: string; error: string }> = [];

    if (autoPromote) {
      const ts = Date.now().toString(36);
      for (let i = 0; i < eligible.length; i++) {
        const cand = eligible[i]!;
        const factorName = `${namePrefix}_${ts}_${i + 1}`;
        try {
          const rec = await discoveryService.promoteCandidate(job.id, cand.id, {
            name: factorName,
            category,
            status: "draft",
          });
          promoted.push({
            candidate_id: cand.id,
            factor_id: rec.id,
            name: rec.name,
            ic: cand.metrics.ic,
            rank_ic: cand.metrics.rankIc,
          });
        } catch (e) {
          promote_errors.push({
            candidate_id: cand.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    return {
      ok: true,
      job_id: job.id,
      requested: expressions.length,
      evaluated: job.candidates.length,
      eligible: eligible.length,
      promoted_count: promoted.length,
      ic_threshold: icThreshold,
      top_candidates: job.candidates.slice(0, topK).map((c) => ({
        candidate_id: c.id,
        expr: c.expr,
        ic: c.metrics.ic,
        rank_ic: c.metrics.rankIc,
        sample_size: c.metrics.sampleSize,
        score: c.metrics.score,
        ...(c.error ? { error: c.error } : {}),
      })),
      promoted,
      ...(promote_errors.length > 0 ? { promote_errors } : {}),
      ...(eligible.length === 0
        ? {
            warning:
              `no_candidate_passed_ic_threshold(${icThreshold}); ` +
              "建议：(1) 检查表达式是否过于简单 (2) 降低 ic_threshold (3) 让 LLM 重新生成一组",
          }
        : {}),
    };
  },

  "discovery.run": async (ctx, params) => {
    const projectId = String(params.project_id ?? ctx.projectId ?? "").trim();
    if (!projectId) throw new Error("discovery.run: project_id is required");
    const symbolsRaw = params.symbols;
    const symbols = Array.isArray(symbolsRaw)
      ? symbolsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    if (symbols.length === 0) throw new Error("discovery.run: symbols is required");
    return discoveryService.submitAndRun({
      projectId,
      kind: String(params.kind ?? "factor_alpha101") as DiscoveryKind,
      symbols,
      startDate: String(params.start_date ?? "").trim(),
      endDate: String(params.end_date ?? "").trim(),
      ...(params.horizon_days !== undefined ? { horizonDays: Number(params.horizon_days) } : {}),
      ...(params.top_k !== undefined ? { topK: Number(params.top_k) } : {}),
      ...(params.candidate_count !== undefined
        ? { candidateCount: Number(params.candidate_count) }
        : {}),
      ...(params.seed !== undefined && typeof params.seed === "number"
        ? { seed: params.seed }
        : {}),
      // 关联到本工作流：promoteCandidate 时把 workflowRunId 透传给 factor.register
      ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
      // lineage（migration 0080）：tool 路径标 agent
      createdBy: "agent",
      ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
    });
  },

  "discovery.promote": async (_ctx, params) => {
    const jobId = String(params.job_id ?? "").trim();
    const candidateId = String(params.candidate_id ?? "").trim();
    const name = String(params.name ?? "").trim();
    if (!jobId) throw new Error("discovery.promote: job_id is required");
    if (!candidateId) throw new Error("discovery.promote: candidate_id is required");
    if (!name) throw new Error("discovery.promote: name is required");
    return discoveryService.promoteCandidate(jobId, candidateId, {
      name,
      ...(params.category ? { category: String(params.category) as FactorCategory } : {}),
      ...(params.status ? { status: String(params.status) as FactorStatus } : {}),
    });
  },

  "backtest.run": async (ctx, params) => {
    const strategyVersionId = String(params.strategy_version_id ?? "").trim();
    if (!strategyVersionId) throw new Error("backtest.run: strategy_version_id is required");
    const symbolsRaw = params.symbols;
    const symbols = Array.isArray(symbolsRaw)
      ? symbolsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    if (symbols.length === 0) throw new Error("backtest.run: symbols is required");
    const startDate = String(params.start_date ?? "").trim();
    const endDate = String(params.end_date ?? "").trim();
    if (!startDate || !endDate) throw new Error("backtest.run: start_date / end_date are required");

    const compositionId = params.composition_id ? String(params.composition_id) : undefined;
    const rawSignal = params.signals;
    const signals =
      !compositionId && rawSignal && typeof rawSignal === "object" && !Array.isArray(rawSignal)
        ? (rawSignal as Record<string, unknown>)
        : undefined;
    if (!compositionId && !signals) {
      throw new Error("backtest.run: composition_id or signals is required");
    }

    const costsRaw = params.costs;
    const costs =
      costsRaw && typeof costsRaw === "object" && !Array.isArray(costsRaw)
        ? {
            commissionBps: Number((costsRaw as Record<string, unknown>)["commissionBps"] ?? 5),
            slippageBps: Number((costsRaw as Record<string, unknown>)["slippageBps"] ?? 5),
          }
        : undefined;

    return backtestJobService.submitAndRun({
      strategyVersionId,
      symbols,
      startDate,
      endDate,
      ...(compositionId ? { compositionId } : {}),
      ...(signals
        ? {
            signals: {
              kind: String((signals as Record<string, unknown>)["kind"] ?? "factor_score"),
              expr: String((signals as Record<string, unknown>)["expr"] ?? ""),
              lang: String((signals as Record<string, unknown>)["lang"] ?? "qlib_expr"),
              ...((signals as Record<string, unknown>)["reverse"] ? { reverse: true } : {}),
            } as never,
          }
        : {}),
      ...(params.universe ? { universe: String(params.universe) } : {}),
      ...(params.capital !== undefined ? { capital: Number(params.capital) } : {}),
      ...(costs ? { costs } : {}),
      ...(params.rebalance
        ? { rebalance: String(params.rebalance) as "daily" | "weekly" | "monthly" }
        : {}),
      ...(params.top_n !== undefined ? { topN: Number(params.top_n) } : {}),
      ...(params.benchmark ? { benchmark: String(params.benchmark) } : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
      // lineage（migration 0080）：tool 路径标 agent
      createdBy: "agent",
      ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
      ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
    });
  },

  "factor.promote_backtest": async (ctx, params) => {
    const factorIdsRaw = params.factor_ids ?? params.factorIds;
    const factorIds = Array.isArray(factorIdsRaw)
      ? factorIdsRaw.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    if (factorIds.length === 0) {
      throw new Error("factor.promote_backtest: factor_ids (string[]) is required");
    }
    const startDate = String(params.start_date ?? params.startDate ?? "").trim();
    const endDate = String(params.end_date ?? params.endDate ?? "").trim();
    if (!startDate || !endDate) {
      throw new Error("factor.promote_backtest: start_date / end_date are required");
    }
    const symbolsRaw = params.symbols;
    const symbols = Array.isArray(symbolsRaw)
      ? symbolsRaw.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : undefined;
    const costsRaw = params.costs;
    const costs =
      costsRaw && typeof costsRaw === "object" && !Array.isArray(costsRaw)
        ? {
            commissionBps: Number((costsRaw as Record<string, unknown>)["commissionBps"] ?? 5),
            slippageBps: Number((costsRaw as Record<string, unknown>)["slippageBps"] ?? 5),
          }
        : undefined;
    const projectId = String(params.project_id ?? ctx.projectId ?? "").trim();
    return factorBacktestPromotionService.promoteAndBacktest({
      ...(projectId ? { projectId } : {}),
      factorIds,
      startDate,
      endDate,
      ...(symbols && symbols.length > 0 ? { symbols } : {}),
      ...(params.universe ? { universe: String(params.universe) } : {}),
      ...(params.strategy_name ? { strategyName: String(params.strategy_name) } : {}),
      ...(params.version_tag ? { versionTag: String(params.version_tag) } : {}),
      ...(params.composition_name ? { compositionName: String(params.composition_name) } : {}),
      ...(params.description ? { description: String(params.description) } : {}),
      ...(params.capital !== undefined ? { capital: Number(params.capital) } : {}),
      ...(costs ? { costs } : {}),
      ...(params.rebalance
        ? { rebalance: String(params.rebalance) as "daily" | "weekly" | "monthly" }
        : {}),
      ...(params.top_n !== undefined ? { topN: Number(params.top_n) } : {}),
      ...(params.benchmark ? { benchmark: String(params.benchmark) } : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
      createdBy: "agent",
      ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
      ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
    });
  },

  "code.run_python": async (_ctx, params) => {
    const code = typeof params.code === "string" ? params.code : "";
    if (!code.trim()) throw new Error("code.run_python: code is required");

    const varsRaw = params.vars;
    const vars =
      varsRaw && typeof varsRaw === "object" && !Array.isArray(varsRaw)
        ? (varsRaw as Record<string, unknown>)
        : {};
    const timeoutSec =
      typeof params.timeout_sec === "number" && params.timeout_sec > 0 ? params.timeout_sec : 30;
    const maxStdoutBytes =
      typeof params.max_stdout_bytes === "number" && params.max_stdout_bytes > 0
        ? params.max_stdout_bytes
        : 65_536;
    const returnVar =
      typeof params.return_var === "string" && params.return_var.length > 0
        ? params.return_var
        : undefined;

    return runPythonSandbox({
      code,
      vars,
      timeoutSec,
      maxStdoutBytes,
      ...(returnVar ? { returnVar } : {}),
    });
  },

  /**
   * P0-1.b（Round 6 复盘新增 2026-06-08）：让 strategy 场景的多 agent 团队能"落最后一公里"。
   *
   * Round 6 实测 grp-strategy-pipeline 跑了 18 step / 13 tool call，分析师把 factor 全 register
   * 完了，但 strategy_author **没有任何工具能写 strategy / strategy_version 表** —— `strategy.compose`
   * 强制要先有 strategyVersionId（来自 indicator_strategy_script 派生路径），而 ReAct loop 里没人帮 agent
   * 创建占位 version → 整个 strategy 链路最终 fusion 写完 analyst_signal 就停了，DB 0 行 strategy_version。
   *
   * 这个工具补齐 author 路径：
   *   1) 先 ensure 该 project 下有 strategy（按 name 幂等 lookup，不存在则插入）
   *   2) 然后插入新的 strategy_version（versionTag 自增 v1/v2/...）
   *   3) 把 workflow_run_id 挂上（让产物侧栏按工作流过滤）
   *   4) 返回 strategyVersionId 给 LLM，让它紧接着调 strategy.compose 完成组装
   *
   * 入参：
   *   - name (必填)：策略名（同 project 内幂等）
   *   - style (可选)：'low_freq'|'mid_freq'|'high_freq'|'options'|'futures'，默认 low_freq
   *   - description (可选)：策略描述
   *   - universe (可选)：universe 标记，影响 paramSchemaJson 留痕，但不影响 strategy_version 唯一性
   *   - version_tag (可选)：手动指定（默认按已有 version 数自增 v{N+1}）
   *
   * 返回：{ strategyId, strategyVersionId, versionTag }
   */
  "strategy.create_version": async (ctx, params) => {
    const name = String(params.name ?? "").trim();
    if (!name) {
      throw new Error("strategy.create_version: name (策略名) is required");
    }
    /**
     * projectId 解析：优先 ctx（来自 workflow_run.project_id），其次 params 显式传入；
     * 与 factor.register 完全一致的优先级，避免 LLM 用错。
     */
    const fromParams = String(params["project_id"] ?? "").trim();
    const projectId = ctx.projectId
      ? ctx.projectId
      : isLikelyProjectIdFormat(fromParams)
        ? fromParams
        : "";
    if (!projectId) {
      throw new Error(
        "strategy.create_version: 缺少 project_id。请在 chat / workflow context 中确保 ctx.projectId 已挂载，或显式传 project_id。"
      );
    }

    type StrategyStyle = "low_freq" | "mid_freq" | "high_freq" | "options" | "futures";
    const styleRaw = String(params.style ?? "low_freq").trim() as StrategyStyle;
    const allowedStyles: StrategyStyle[] = [
      "low_freq",
      "mid_freq",
      "high_freq",
      "options",
      "futures",
    ];
    if (!allowedStyles.includes(styleRaw)) {
      throw new Error(
        `strategy.create_version: style 必须是 ${allowedStyles.join("/")} 之一，收到: ${styleRaw}`
      );
    }
    const description = String(params.description ?? "").trim();
    const universe = String(params.universe ?? "").trim();

    const db = await getDb();

    /** 1) ensure strategy（按 (projectId, name) 幂等） */
    const existing = await db
      .select()
      .from(strategyTable)
      .where(and(eq(strategyTable.projectId, projectId), eq(strategyTable.name, name)))
      .limit(1);
    let strategyId: string;
    if (existing[0]) {
      strategyId = existing[0].id;
    } else {
      strategyId = randomUUID();
      await db.insert(strategyTable).values({
        id: strategyId,
        projectId,
        name,
        style: styleRaw,
        description: description || `Created by ${ctx.definition.role} via strategy.create_version`,
      });
    }

    /** 2) 计算 versionTag（默认 v{count+1}） */
    const existingVersions = await db
      .select()
      .from(strategyVersionTable)
      .where(eq(strategyVersionTable.strategyId, strategyId));
    const explicitTag = String(params.version_tag ?? "").trim();
    const versionTag = explicitTag || `v${existingVersions.length + 1}`;
    /** 同 strategyId 下 versionTag 必须唯一（不限 schema unique，但语义上重复会迷惑下游） */
    if (existingVersions.some((v) => v.versionTag === versionTag)) {
      throw new Error(
        `strategy.create_version: versionTag "${versionTag}" 已存在于 strategy ${strategyId}; 显式传一个新的 version_tag 或留空让系统自增。`
      );
    }

    /** 3) 插 strategy_version */
    const strategyVersionId = randomUUID();
    const paramSchemaJson: Record<string, unknown> = {
      createdBy: ctx.definition.role,
      ...(universe ? { universe } : {}),
      ...(params.params && typeof params.params === "object" && !Array.isArray(params.params)
        ? { params: params.params as Record<string, unknown> }
        : {}),
    };
    /** logicHash 暂取 versionId 短前缀 — composer.define 后会被 composition 真正定锚 */
    await db.insert(strategyVersionTable).values({
      id: strategyVersionId,
      strategyId,
      versionTag,
      logicHash: `pending-${strategyVersionId.slice(0, 8)}`,
      paramSchemaJson: paramSchemaJson as never,
      ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
    });

    return {
      strategyId,
      strategyVersionId,
      versionTag,
      next_steps:
        "已创建空的 strategy_version。下一步：调 strategy.compose({strategy_version_id, kind, factor_ids, weight_method, ...}) 真正定义策略组合。",
    };
  },

  /**
   * P0-1.c（Round 6 复盘新增 2026-06-08）：让 live_trading 场景的 trader 能"落最后一公里"。
   *
   * Round 6 实测 grp-live-trading 只跑 4 step 就停了，因为 trader 完全没有"写 order_intent"的工具。
   * createOrderIntentWithExecution 服务齐全（含 pre-trade risk 检查 + paper/live 分发），
   * 但仅供后端 webhook / strategy runtime 内部调用，从未暴露给 LLM。
   *
   * 这个工具薄包装该服务，默认走 paper 模式（dispatchMode='paper'）安全。trader agent 在 compose
   * 完 strategy 后可以一步落单：strategy.create_version → strategy.compose → order.create_intent。
   *
   * 入参：
   *   - strategy_version_id (必填)：来自 strategy.create_version
   *   - symbol (必填)：交易标的（如 AAPL）
   *   - side (必填)：'buy' | 'sell'
   *   - qty (必填，> 0)：下单数量
   *   - order_type (可选)：'market' | 'limit'（默认 market）
   *   - price (limit 必填)：限价
   *   - time_in_force (可选)：'day' | 'gtc'（默认 day）
   *   - market (可选)：'US' | 'CN' 等（用于 instrument 解析；默认 US）
   *   - dispatch_mode (可选)：'paper' | 'live'（默认 paper，安全起见）
   *
   * 返回：{ orderIntentId, executionTaskId, riskOutcome, riskReason, riskReviewTicketId }
   */
  "order.create_intent": async (ctx, params) => {
    const strategyVersionId = String(params.strategy_version_id ?? "").trim();
    if (!strategyVersionId) {
      throw new Error(
        "order.create_intent: strategy_version_id is required。先调 strategy.create_version 拿到 id。"
      );
    }
    const symbol = String(params.symbol ?? "").trim();
    if (!symbol) {
      throw new Error("order.create_intent: symbol (交易标的) is required");
    }
    const sideRaw = String(params.side ?? "")
      .trim()
      .toLowerCase();
    if (sideRaw !== "buy" && sideRaw !== "sell") {
      throw new Error(`order.create_intent: side 必须是 'buy' 或 'sell'，收到: ${sideRaw}`);
    }
    const side: OrderSide = sideRaw as OrderSide;
    const qty = Number(params.qty ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`order.create_intent: qty 必须是正数，收到: ${qty}`);
    }
    const orderTypeRaw = String(params.order_type ?? "market")
      .trim()
      .toLowerCase();
    if (orderTypeRaw !== "market" && orderTypeRaw !== "limit") {
      throw new Error(
        `order.create_intent: order_type 必须是 'market' 或 'limit'，收到: ${orderTypeRaw}`
      );
    }
    const orderType: OrderType = orderTypeRaw as OrderType;
    const priceRaw = params.price;
    const price =
      priceRaw !== undefined && priceRaw !== null && Number.isFinite(Number(priceRaw))
        ? Number(priceRaw)
        : null;
    if (orderType === "limit" && price === null) {
      throw new Error("order.create_intent: order_type=limit 时必须传 price (limit 价)");
    }
    const tifRaw = String(params.time_in_force ?? "day")
      .trim()
      .toLowerCase();
    const tifAllowed: TimeInForce[] = ["day", "gtc", "ioc", "fok"];
    if (!tifAllowed.includes(tifRaw as TimeInForce)) {
      throw new Error(
        `order.create_intent: time_in_force 必须是 ${tifAllowed.join("/")} 之一，收到: ${tifRaw}`
      );
    }
    const timeInForce: TimeInForce = tifRaw as TimeInForce;
    const market = String(params.market ?? "US").trim();
    const dispatchModeRaw = String(params.dispatch_mode ?? "paper")
      .trim()
      .toLowerCase();
    if (dispatchModeRaw !== "paper" && dispatchModeRaw !== "live") {
      throw new Error(
        `order.create_intent: dispatch_mode 必须是 'paper' 或 'live'，收到: ${dispatchModeRaw}`
      );
    }
    const dispatchMode = dispatchModeRaw as "paper" | "live";

    /**
     * workflowRunId 必须可解析：order_intent.workflow_run_id 通过 FK 引用 workflow_run.id。
     * 如果 ctx 缺失（理论上不该发生，但 IDE / 测试调用可能没挂 workflowId），抛清晰错误。
     */
    const workflowRunId = ctx.workflowId;
    if (!workflowRunId) {
      throw new Error(
        "order.create_intent: ctx.workflowId 缺失（无法 FK 到 workflow_run.id）。请确保该工具在 workflow context 内调用。"
      );
    }

    /**
     * instrumentId 解析：先 lookup instrument 表，找不到时复用 strategy-runtime-service 的
     * ensureInstrumentForSymbol 风格 —— 但本工具不引该服务，直接在这里插一条最小 instrument。
     */
    const db = await getDb();
    const sym = symbol.toUpperCase();
    const existingInst = await db
      .select()
      .from(instrumentTable)
      .where(eq(instrumentTable.symbol, sym))
      .limit(1);
    let instrumentId: string;
    if (existingInst[0]) {
      instrumentId = existingInst[0].id;
    } else {
      instrumentId = randomUUID();
      await db.insert(instrumentTable).values({
        id: instrumentId,
        symbol: sym,
        assetClass: market === "CRYPTO" ? "crypto" : "stock",
        exchange: market,
        metaJson: {},
      });
    }

    const result = await createOrderIntentWithExecution(db, {
      workflowRunId,
      strategyVersionId,
      instrumentId,
      side,
      qty,
      orderType,
      price,
      timeInForce,
      market,
      symbol: sym,
      timeframe: typeof params.timeframe === "string" ? (params.timeframe as string) : undefined,
      dispatchMode,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    });

    return {
      orderIntentId: result.orderIntentId,
      executionTaskId: result.executionTaskId,
      riskOutcome: result.riskOutcome,
      riskReason: result.riskReason,
      riskReviewTicketId: result.riskReviewTicketId,
      symbol: sym,
      side,
      qty,
      orderType,
      dispatchMode,
    };
  },

  "recommendation.record": async (ctx, params) => {
    const symbol = String(params.symbol ?? params.ticker ?? "").trim();
    if (!symbol) {
      throw new Error("recommendation.record: symbol/ticker is required");
    }
    const sideRaw = String(params.side ?? "long")
      .trim()
      .toLowerCase();
    const sideMap: Record<string, RecommendationSide> = {
      buy: "long",
      long: "long",
      bullish: "long",
      sell: "short",
      short: "short",
      bearish: "short",
      hold: "neutral",
      neutral: "neutral",
    };
    const side = sideMap[sideRaw];
    if (!side) {
      throw new Error(
        `recommendation.record: side must be long/short/neutral (or buy/sell/hold), got ${sideRaw}`
      );
    }
    const horizonDays = Number(params.horizon_days ?? params.horizonDays ?? 20);
    const confidence = Number(params.confidence ?? 0.5);
    const scoreRaw = params.score;
    const evidenceRaw = params.evidence ?? params.evidence_json;
    const evidence = Array.isArray(evidenceRaw) ? evidenceRaw : [];
    const result = await recommendationService.record({
      workflowRunId: ctx.workflowId,
      symbol,
      market: typeof params.market === "string" ? params.market : "US",
      side,
      horizonDays: Number.isFinite(horizonDays) && horizonDays > 0 ? Math.floor(horizonDays) : 20,
      confidence: Number.isFinite(confidence) ? confidence : 0.5,
      score: scoreRaw !== undefined && Number.isFinite(Number(scoreRaw)) ? Number(scoreRaw) : null,
      entryLow: optionalFiniteNumber(params.entry_low ?? params.entryLow),
      entryHigh: optionalFiniteNumber(params.entry_high ?? params.entryHigh),
      stopLoss: optionalFiniteNumber(params.stop_loss ?? params.stopLoss),
      takeProfit: optionalFiniteNumber(
        params.take_profit ?? params.takeProfit ?? params.target_price
      ),
      positionSizePct: optionalFiniteNumber(params.position_size_pct ?? params.positionSizePct),
      riskRewardRatio: optionalFiniteNumber(params.risk_reward_ratio ?? params.riskRewardRatio),
      rationale: String(params.rationale ?? params.reasoning ?? ""),
      evidence,
      invalidation: Array.isArray(params.invalidation_conditions)
        ? params.invalidation_conditions
        : [],
      watchConditions: Array.isArray(params.watch_conditions) ? params.watch_conditions : [],
      benchmarkSymbol: typeof params.benchmark_symbol === "string" ? params.benchmark_symbol : null,
      expiresAt: typeof params.expires_at === "string" ? params.expires_at : null,
      dataAsof: typeof params.data_asof === "string" ? params.data_asof : null,
      sourceArtifactKind:
        typeof params.source_artifact_kind === "string" ? params.source_artifact_kind : null,
      sourceArtifactId:
        typeof params.source_artifact_id === "string" ? params.source_artifact_id : null,
      createdBy: "agent",
      agentInstanceId: ctx.agentInstanceId,
      ...(typeof params.asof === "string" ? { asof: params.asof } : {}),
    });
    return {
      recommendationId: result.id,
      symbol: result.symbol,
      side,
      next_steps:
        "推荐已进入 DecisionSignal 生命周期；outcome worker 会按 horizon_days 自动回填效果。",
    };
  },

  "strategy.compose": async (ctx, params) => {
    const strategyVersionId = String(params.strategy_version_id ?? "").trim();
    if (!strategyVersionId) {
      throw new Error("strategy.compose: strategy_version_id is required");
    }
    const factorIdsRaw = params.factor_ids;
    const ruleIdsRaw = params.rule_ids;
    let factorIds = Array.isArray(factorIdsRaw)
      ? factorIdsRaw.filter((s): s is string => typeof s === "string")
      : undefined;
    const ruleIds = Array.isArray(ruleIdsRaw)
      ? ruleIdsRaw.filter((s): s is string => typeof s === "string")
      : undefined;
    const kind = String(params.kind ?? "factor_score") as StrategyKind;

    /**
     * Tier-1 容错（2026-06-09）：kind=factor_score / hybrid 但 agent 忘传 factor_ids 时，
     * 从 `factor_definition` 自动捞 top-3 用 ——
     *   - 候选范围：相同 workflow_run_id 产的 active 因子（最关键、最相关）
     *   - 退路：项目下任意 active 因子（按 created_at desc）
     * 都拿不到时再回到原报错 `factor_score_requires_factor_ids`，让 agent 显式报。
     *
     * 旧行为是直接抛错、agent 不一定会 retry —— Agent Readiness Evaluation R-7 实测
     * 4 次 strategy.compose 调用里 2 次因这个原因失败，引入兜底显著提升健康度。
     */
    if ((kind === "factor_score" || kind === "hybrid") && (!factorIds || factorIds.length === 0)) {
      try {
        const db = await getDb();
        const sv = await db
          .select({
            workflowRunId: strategyVersionTable.workflowRunId,
            strategyId: strategyVersionTable.strategyId,
          })
          .from(strategyVersionTable)
          .where(eq(strategyVersionTable.id, strategyVersionId))
          .limit(1);
        if (sv[0]) {
          /**
           * strategy.project_id 在 strategy_version 上没有镜像列，需要走 strategy 表 join。
           * 这里复用 builtin tools 已有的 resolveProjectIdForWorkflow，避免再写一遍 SQL。
           */
          const projectId = await resolveProjectIdForWorkflow(ctx);
          const wfRunId = sv[0].workflowRunId ?? ctx.workflowId ?? null;
          const candidates = await factorService.list({
            ...(projectId ? { projectId } : {}),
            ...(wfRunId ? { workflowRunId: wfRunId } : {}),
            status: "active",
          });
          let pool = candidates;
          // workflow 内拿不到 → 退化到项目维度
          if (pool.length === 0 && projectId) {
            pool = await factorService.list({ projectId, status: "active" });
          }
          if (pool.length > 0) {
            factorIds = pool.slice(0, 3).map((f) => f.id);
          }
        }
      } catch (e) {
        // 兜底失败不 escalate；把原错误抛出去让 agent 自己处理
        console.warn(
          `[strategy.compose] 自动拉 top-3 factor 失败：${(e as Error).message}; 退回原始校验`
        );
      }
    }

    const weightsRaw = params.factor_weights;
    const factorWeights =
      weightsRaw && typeof weightsRaw === "object" && !Array.isArray(weightsRaw)
        ? (weightsRaw as Record<string, number>)
        : undefined;
    const paramsRaw = params.params;
    const extraParams =
      paramsRaw && typeof paramsRaw === "object" && !Array.isArray(paramsRaw)
        ? (paramsRaw as Record<string, unknown>)
        : undefined;
    return strategyComposer.define({
      strategyVersionId,
      kind,
      ...(factorIds && factorIds.length > 0 ? { factorIds } : {}),
      ...(ruleIds && ruleIds.length > 0 ? { ruleIds } : {}),
      ...(params.weight_method
        ? { weightMethod: String(params.weight_method) as WeightMethod }
        : {}),
      ...(factorWeights ? { factorWeights } : {}),
      ...(params.rebalance_freq ? { rebalanceFreq: String(params.rebalance_freq) } : {}),
      ...(params.universe ? { universe: String(params.universe) } : {}),
      ...(extraParams ? { params: extraParams } : {}),
    });
  },

  /**
   * Self-Evolving Agent P7 — `tool.report_gap`
   *
   * agent 在 LLM 推理中识别到「需要某工具但没有 / 不可用 / 不知道怎么用」时主动调用，
   * 由 ToolGapWatcher 统一 ingest 到 `tool_gap_log`，给 P8 AutoInstaller propose 模式
   * 提供候选输入。
   *
   * 参数（任 1 必填）：
   *   - toolName / tool_name        ：想要的具体工具名（如 "get_realtime_options_chain"）
   *   - serverName                  ：MCP server 名（如 "slack"），与 toolName 配合产 mcp: 签名
   *   - reason / note               ：自由说明；若无 toolName，则用 reason 第一关键词产 concept: 签名
   *
   * 可选参数：
   *   - toolKind / tool_kind        ：'mcp' | 'builtin' | 'unknown'（默认 'unknown'）
   *
   * 返回：{ ok, action: 'created'|'incremented'|'skipped', gapId?, signature }
   */
  "tool.report_gap": async (ctx, params) => {
    const toolName = String(params["toolName"] ?? params["tool_name"] ?? "").trim();
    const serverName = String(params["serverName"] ?? params["server_name"] ?? "").trim();
    const reason = String(params["reason"] ?? params["note"] ?? "").trim();
    const toolKind = String(params["toolKind"] ?? params["tool_kind"] ?? "unknown");
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
  // 设计要点：
  //   - act 节点已自动跑 sandbox.checkToolCall（工具名层白名单）
  //   - 这里再做 binary 层白名单（必须在 EXEC_PROVIDERS 中注册）+ cwd 边界 + arg 元字符防御
  //   - 错误统一返回 ExecResult 结构（ok=false + error code），不 throw，让 ReAct 自纠错
  /**
   * shell.exec — 让 agent 直接调用本地 CLI（git/jq/duckdb/rg/...）。
   *
   * 调用形态：
   *   { tool: "shell.exec", params: {
   *       binary: "duckdb",
   *       args: ["-c", "SELECT count(*) FROM 'bars.parquet'"],
   *       cwd: "/Users/.../projects/<pid>/workflows/<runId>",
   *       timeoutMs: 30000   // 可选
   *   } }
   *
   * cwd 必须落在 provider.workdirStrategy 限定的根目录下，
   * args 走数组形式不经 shell（防注入）。
   *
   * 所有路径（含治理拦截）都落 exec_call_log，让监控页能看到"被拦下"的次数。
   */
  "shell.exec": async (ctx, params) => {
    const binary = String(params.binary ?? "").trim();
    if (!binary) throw new Error("shell.exec: binary is required");

    const argsRaw = params.args;
    const args = Array.isArray(argsRaw)
      ? argsRaw.map((a) => (typeof a === "string" ? a : String(a)))
      : [];
    const cwd = String(params.cwd ?? "").trim();
    const stdinText = typeof params.stdinText === "string" ? params.stdinText : undefined;
    const stdinBytes = stdinText ? Buffer.byteLength(stdinText, "utf-8") : 0;

    const logBase = {
      toolCallId: ctx.toolCallId ?? "",
      agentStepId: ctx.agentStepId ?? "",
      workflowRunId: ctx.workflowId,
      agentDefinitionId: ctx.definition.id,
      traceId: ctx.traceId,
      providerId: binary,
      execKind: "shell" as const,
      binary,
      args,
      cwd,
      stdinBytes,
    };
    const earlyResult = (result: ExecResult): ExecResult => {
      void writeExecCallLog({ ...logBase, result });
      return result;
    };

    const provider = await getExecProvider(binary, "shell");
    if (!provider) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "binary_not_registered",
        errorDetail: `binary "${binary}" is not in EXEC_PROVIDERS; register it in $dataDir/exec-providers.json or pick from the built-in list (git/jq/rg/duckdb)`,
      });
    }

    if (!cwd) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "cwd_escape",
        errorDetail: "shell.exec: cwd is required (must be absolute path within workdir scope)",
      });
    }

    const cwdCheck = checkCwdScope(cwd, provider, {
      projectId: ctx.projectId,
      workflowId: ctx.workflowId,
    });
    if (!cwdCheck.ok) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "cwd_escape",
        errorDetail: cwdCheck.reason ?? "cwd escape",
      });
    }

    const argCheck = checkArgs(provider, args);
    if (!argCheck.ok) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: argCheck.reason?.includes("subcommand") ? "disallowed_subcommand" : "shell_metachar",
        errorDetail: argCheck.reason ?? "arg rejected",
      });
    }

    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : undefined;

    const result = await runExec({
      provider,
      args,
      cwd,
      ...(stdinText !== undefined ? { stdinText } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      toolCallContext: {
        ...(ctx.workflowId ? { workflowId: ctx.workflowId } : {}),
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
      },
    });
    void writeExecCallLog({
      ...logBase,
      providerId: provider.id,
      binary: provider.command,
      result,
    });
    return result;
  },

  /**
   * cli_agent.run — 把外部 agentic CLI（claude-code / aider / codex）作为子智能体调用。
   *
   * 调用形态：
   *   { tool: "cli_agent.run", params: {
   *       agentId: "claude-code",
   *       task: "在 src/runtime/factor/ 下新增 risk_parity 因子，参考已有 alpha101 风格",
   *       cwd: "/Users/.../projects/<pid>/workflows/<runId>",
   *       files: ["src/runtime/factor/momentum.ts"],   // 可选：通过 argTemplate {files...} 展开
   *       timeoutMs: 600000   // 可选
   *   } }
   *
   * 与 shell.exec 的差别：
   *   - args 不由 LLM 自由组装，而是从 provider.argTemplate 渲染（占位符 {prompt}/{cwd}/{files...}）
   *   - 默认超时长（5-10 分钟）；输出截断阈值高（256KB）
   *   - lifecycle=unsafe，UI 应高亮警示
   */
  "cli_agent.run": async (ctx, params) => {
    const agentId = String(params.agentId ?? "").trim();
    if (!agentId) throw new Error("cli_agent.run: agentId is required");

    const task = String(params.task ?? "").trim();
    const cwd = String(params.cwd ?? "").trim();
    const filesRaw = params.files;
    const files = Array.isArray(filesRaw)
      ? filesRaw.filter((f): f is string => typeof f === "string" && f.length > 0)
      : undefined;

    const logBase = {
      toolCallId: ctx.toolCallId ?? "",
      agentStepId: ctx.agentStepId ?? "",
      workflowRunId: ctx.workflowId,
      agentDefinitionId: ctx.definition.id,
      traceId: ctx.traceId,
      providerId: agentId,
      execKind: "cli_agent" as const,
      binary: agentId,
      args: [] as string[],
      cwd,
      stdinBytes: 0,
    };
    const earlyResult = (result: ExecResult, args: string[] = []): ExecResult => {
      void writeExecCallLog({ ...logBase, args, result });
      return result;
    };

    const provider = await getExecProvider(agentId, "cli_agent");
    if (!provider) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "binary_not_registered",
        errorDetail: `cli_agent "${agentId}" is not in EXEC_PROVIDERS (kind=cli_agent); built-in: claude-code, aider`,
      });
    }

    if (!task) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "exec_failed",
        errorDetail: "cli_agent.run: task is required (non-empty natural-language prompt)",
      });
    }

    if (!cwd) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "cwd_escape",
        errorDetail: "cli_agent.run: cwd is required (must be absolute path within workdir scope)",
      });
    }

    const cwdCheck = checkCwdScope(cwd, provider, {
      projectId: ctx.projectId,
      workflowId: ctx.workflowId,
    });
    if (!cwdCheck.ok) {
      return earlyResult({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        elapsedMs: 0,
        error: "cwd_escape",
        errorDetail: cwdCheck.reason ?? "cwd escape",
      });
    }

    const template = provider.argTemplate ?? ["{prompt}"];
    const args = renderArgTemplate(template, {
      prompt: task,
      cwd,
      ...(files ? { files } : {}),
    });

    const argCheck = checkArgs(provider, args);
    if (!argCheck.ok) {
      return earlyResult(
        {
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          truncated: false,
          elapsedMs: 0,
          error: "shell_metachar",
          errorDetail: `cli_agent.run: task or files triggered metachar check: ${argCheck.reason}`,
        },
        args
      );
    }

    const stdinText =
      provider.stdinTemplate !== undefined
        ? provider.stdinTemplate.replace(/\{prompt\}/g, task).replace(/\{cwd\}/g, cwd)
        : undefined;
    const stdinBytes = stdinText ? Buffer.byteLength(stdinText, "utf-8") : 0;
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : undefined;

    const result = await runExec({
      provider,
      args,
      cwd,
      ...(stdinText !== undefined ? { stdinText } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      toolCallContext: {
        ...(ctx.workflowId ? { workflowId: ctx.workflowId } : {}),
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
      },
    });
    void writeExecCallLog({
      ...logBase,
      providerId: provider.id,
      binary: provider.command,
      args,
      stdinBytes,
      result,
    });
    return result;
  },
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

/** Goal 模式允许 Orchestrator 按目标按需召唤当前拓扑之外的专家。 */
async function isGoalMode(workflowId: string): Promise<boolean> {
  try {
    const db = await getDb();
    const rows = await db
      .select({ loopOptionsJson: workflowRun.loopOptionsJson })
      .from(workflowRun)
      .where(eq(workflowRun.id, workflowId))
      .limit(1);
    return resolveAgentControlMode(rows[0]?.loopOptionsJson) === "goal";
  } catch {
    return false; // 读失败按默认 native 处理（保守，rails 不变）
  }
}

async function dispatchTeamAgentTask(
  ctx: BuiltinToolContext,
  role: AgentRole,
  params: Record<string, unknown>
): Promise<{
  dispatched: boolean;
  completed: boolean;
  success: boolean;
  role: AgentRole;
  runId: string;
  via: string;
  result?: unknown;
  errorMessage?: string | null;
}> {
  const targetRole = resolveDispatchRole(role);
  const topology = await loadOrchestratorTopologyForWorkflow();
  if (ctx.definition.role === "orchestrator" && topology && topology.targets.length > 0) {
    // Goal 模式放开「角色集锁死」——编排器可按需拉入团队拓扑之外的有效专家。
    // 默认 Agent 模式保持
    // 严格校验（rails 不变）。dispatchTaskToRole 仍会对不存在定义的角色报运行时错误兜底。
    const goalMode = await isGoalMode(ctx.workflowId);
    if (goalMode) {
      const onEdge = topology.targets.some((t) => t.role === targetRole);
      if (!onEdge) {
        console.info(
          `[dispatchTeamAgentTask] Goal 模式：放行拓扑外角色 '${targetRole}'（按需拉入专家）`
        );
      }
    } else {
      assertTopologyTargetAllowed(topology, targetRole);
    }
  }

  const goal = String(params.goal ?? params.message ?? "").trim();
  if (!goal) throw new Error("dispatch team agent: goal is required");

  const extra =
    typeof params.params === "object" && params.params && !Array.isArray(params.params)
      ? (params.params as Record<string, unknown>)
      : {};

  const payload: TaskAssignPayload = {
    taskId: String(params.taskId ?? randomUUID()),
    taskType: String(params.taskType ?? "topology_dispatch"),
    assignedRole: targetRole,
    params: { goal, ...extra, ...(role !== targetRole ? { requestedRole: role } : {}) },
  };

  // 先登记再派发，避免进程内总线的快速 TASK_RESULT 在 waiter 建立前到达。
  const configuredTimeoutMs = Number(process.env.TOPOLOGY_TASK_TIMEOUT_MS ?? 120_000);
  const gatherTimeoutMs = Number.isFinite(configuredTimeoutMs)
    ? Math.min(Math.max(configuredTimeoutMs, 10_000), 300_000)
    : 120_000;
  const pendingResult = getA2AGather().expect([payload.taskId], { timeoutMs: gatherTimeoutMs });
  const { runId } = await dispatchTaskToRole({
    workflowId: ctx.workflowId,
    role: targetRole,
    payload,
    traceId: ctx.traceId,
    senderId: ctx.agentInstanceId,
  });
  const gathered = (await pendingResult).get(payload.taskId);
  return {
    dispatched: true,
    completed: !gathered?.timedOut,
    success: Boolean(gathered?.success),
    role: targetRole,
    runId,
    via: "topology_dispatch",
    ...(gathered?.result !== undefined ? { result: gathered.result } : {}),
    ...(gathered?.errorMessage !== undefined ? { errorMessage: gathered.errorMessage } : {}),
  };
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
