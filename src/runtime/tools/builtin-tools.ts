import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { analystSignal, auditLog, longtermMemory, midtermMemory } from "../../db/sqlite/schema";
import type { AgentRole } from "../../types/entities";
import type { TaskAssignPayload } from "../../types/a2a";
import { dispatchTaskToRole } from "../agent-pool";
import {
  assertTopologyTargetAllowed,
  isTopologyTeamTool,
  loadOrchestratorTopologyForWorkflow,
  parseRoleFromTopologyTeamTool,
  resolveDispatchRole,
} from "../orchestration/topology-dispatch";
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
import { parseHitlApproval } from "../workflow/hitl-service";
import { fuseSignals, type RawAnalystSignal } from "../msa/signal-fusion";
import { runStockScreener } from "../screener/stock-screener";
import { NativeMemoryConnector } from "../../connectors/memory/native/native.memory.connector";
import { factorService } from "../factor/factor-service";
import { ruleService } from "../rule/rule-service";
import { strategyComposer } from "../strategy/strategy-composer";
import { backtestJobService } from "../backtest/backtest-job-service";
import { discoveryService } from "../discovery/discovery-service";
import type { DiscoveryKind } from "../discovery/discovery-service";
import { runPythonSandbox } from "../sandbox/python-sandbox";
import type {
  FactorCategory,
  FactorLang,
  FactorStatus,
} from "../factor/factor-service";
import type {
  RuleAppliesTo,
  RuleLang,
  RuleStatus,
} from "../rule/rule-service";
import type {
  StrategyKind,
  WeightMethod,
} from "../strategy/strategy-composer";
import type { FactorComputeRow, RuleEvalContext } from "../provider/types";
import type { BuiltinToolContext, BuiltinToolHandler } from "./types";
import { resolveConnectorForTool } from "./tool-routes";
import { skillService } from "../skills/skill-service";
import type { AgentSkillOutcome } from "../../types/entities";

const memoryConnector = new NativeMemoryConnector();

/** Tools implemented in-process (not routed to ACP connectors). */
const BUILTIN_HANDLERS: Record<string, BuiltinToolHandler> = {
  task_decompose: async (ctx, params) => {
    const goal =
      String(params.goal ?? params.task ?? ctx.inboundPayload?.["goal"] ?? ctx.reasonText ?? "").trim();
    const steps = [
      { id: "1", role: "market_data", action: "拉取行情与数据快照", tool: "fetch_klines" },
      { id: "2", role: "news_event", action: "抓取新闻与事件情绪", tool: "fetch_news" },
      {
        id: "3",
        role: "orchestrator",
        action: "启动四维分析师团队（MSA）",
        tool: "run_analyst_team",
      },
      { id: "4", role: "research", action: "因子/策略深化与实验", tool: "run_experiment" },
      { id: "5", role: "backtest", action: "历史回测验证", tool: "run_backtest" },
      {
        id: "6",
        role: "risk",
        action: "规则签核与组合风险审查",
        tool: "evaluate_risk",
      },
    ];
    return { goal, steps, workflowId: ctx.workflowId };
  },

  assign_task: async (ctx, params) => {
    const role = String(params.role ?? params.targetRole ?? "").trim() as AgentRole;
    if (!role) throw new Error("assign_task: role is required");
    return dispatchTeamAgentTask(ctx, role, params);
  },

  run_analyst_team: async (ctx, params) => {
    const ticker =
      String(params.ticker ?? ctx.inboundPayload?.["ticker"] ?? "").trim() || undefined;
    const scopeRaw = params.scope ?? ctx.inboundPayload?.["scope"];
    const scope =
      scopeRaw && typeof scopeRaw === "object" && !Array.isArray(scopeRaw)
        ? (scopeRaw as Record<string, unknown>)
        : undefined;
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
      scope: scope as import("../../types/research-scope").ResearchScopeInput | undefined,
      context: context || undefined,
      agentGroupId,
      analystRoles,
      analystDefinitionIds,
      runId: ctx.runId,
      traceId: ctx.traceId,
      hitlApproval: parseHitlApproval(
        (ctx.inboundPayload?.["params"] as Record<string, unknown> | undefined)?.["hitlApproval"]
      ),
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
    const items = [...brief.symbolNews, ...brief.sectorNews];
    return {
      keywords,
      discussionVolume: items.length,
      headlines: items.slice(0, 5).map((i) => i.title),
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
      scopeId: scopeStr === "org" ? "default" : (projectId || "default"),
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
      (await skillService.findById(idOrName)) ?? (await skillService.findByName(projectId, idOrName));
    if (!skill) return { error: `skill not found: ${idOrName}` };
    return skill;
  },

  "skill.list": async (ctx, params) => {
    const projectId = String(params.projectId ?? params.project_id ?? ctx.projectId ?? "");
    if (!projectId) throw new Error("skill.list: projectId is required");
    const opts: { includeArchived?: boolean; state?: "active" | "stale" | "archived" | "pending_review" } = {};
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
    return { skillId: archived.id, state: archived.state, message: "skill archived (recoverable via skill.patch state=active)" };
  },

  "skill.use_record": async (ctx, params) => {
    const skillId = String(params.skillId ?? params.id ?? "").trim();
    if (!skillId) throw new Error("skill.use_record: skillId is required");
    const outcomeRaw = String(params.outcome ?? "unknown") as AgentSkillOutcome;
    const outcome: AgentSkillOutcome = ["success", "fail", "partial", "unknown"].includes(outcomeRaw)
      ? outcomeRaw
      : "unknown";
    await skillService.recordUsage({
      skillId,
      workflowRunId: ctx.workflowId,
      agentInstanceId: ctx.agentInstanceId,
      definitionId: ctx.definition.id,
      outcome,
      score: typeof params.score === "number" ? params.score : 0,
      notes: typeof params.notes === "string" ? params.notes : "",
    });
    return { skillId, outcome, recorded: true };
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
    if (dryRunParam === false || dryRunParam === "false" || dryRunParam === 0 || dryRunParam === "off") {
      dryRun = false;
    } else if (
      dryRunParam &&
      typeof dryRunParam === "object" &&
      !Array.isArray(dryRunParam)
    ) {
      const cfg: { minRows?: number; minVariance?: number } = {};
      const dr = dryRunParam as Record<string, unknown>;
      if (dr.min_rows !== undefined) cfg.minRows = Number(dr.min_rows);
      if (dr.minRows !== undefined) cfg.minRows = Number(dr.minRows);
      if (dr.min_variance !== undefined) cfg.minVariance = Number(dr.min_variance);
      if (dr.minVariance !== undefined) cfg.minVariance = Number(dr.minVariance);
      dryRun = cfg;
    }
    return factorService.register({
      projectId,
      name: String(params.name ?? "").trim(),
      category: String(params.category ?? "momentum") as FactorCategory,
      expr: String(params.expr ?? "").trim(),
      ...(params.lang ? { lang: String(params.lang) as FactorLang } : {}),
      ...(params.universe ? { universe: String(params.universe) } : {}),
      ...(params.horizon !== undefined ? { horizon: Number(params.horizon) } : {}),
      ...(params.status ? { status: String(params.status) as FactorStatus } : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
      ...(definition ? { definition } : {}),
      dryRun,
    });
  },

  "factor.compute": async (_ctx, params) => {
    const factorId = String(params.factor_id ?? "").trim();
    if (!factorId) throw new Error("factor.compute: factor_id is required");
    const symbolsRaw = params.symbols;
    const symbols = Array.isArray(symbolsRaw)
      ? symbolsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : undefined;
    return factorService.compute({
      factorId,
      startDate: String(params.start_date ?? "").trim(),
      endDate: String(params.end_date ?? "").trim(),
      ...(symbols && symbols.length > 0 ? { symbols } : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
    });
  },

  "factor.evaluate": async (_ctx, params) => {
    const factorId = String(params.factor_id ?? "").trim();
    if (!factorId) throw new Error("factor.evaluate: factor_id is required");
    const valuesRaw = params.values;
    const values = Array.isArray(valuesRaw) ? (valuesRaw as FactorComputeRow[]) : [];
    const futureRaw = params.future_returns;
    const futureReturns = Array.isArray(futureRaw)
      ? (futureRaw as FactorComputeRow[])
      : undefined;
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

  "factor.autoEvaluate": async (_ctx, params) => {
    const factorId = String(params.factor_id ?? "").trim();
    if (!factorId) throw new Error("factor.autoEvaluate: factor_id is required");
    const startDate = String(params.start_date ?? "").trim();
    const endDate = String(params.end_date ?? "").trim();
    if (!startDate || !endDate) {
      throw new Error("factor.autoEvaluate: start_date and end_date are required");
    }
    const symbolsRaw = params.symbols;
    const symbols = Array.isArray(symbolsRaw)
      ? symbolsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : undefined;
    const decayRaw = params.decay_horizons;
    const decayHorizons = Array.isArray(decayRaw)
      ? decayRaw.filter((n): n is number => typeof n === "number")
      : undefined;
    return factorService.autoEvaluate({
      factorId,
      startDate,
      endDate,
      ...(symbols && symbols.length > 0 ? { symbols } : {}),
      ...(params.horizon_days !== undefined ? { horizonDays: Number(params.horizon_days) } : {}),
      ...(decayHorizons && decayHorizons.length > 0 ? { decayHorizons } : {}),
      ...(params.group_count !== undefined ? { groupCount: Number(params.group_count) } : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
    });
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
    const horizonDays =
      params.horizon_days !== undefined ? Number(params.horizon_days) : undefined;

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
      finite.length > 0
        ? finite.reduce((sum, i) => sum + i.rank_ic, 0) / finite.length
        : 0;
    const meanIr =
      finite.length > 0 ? finite.reduce((sum, i) => sum + i.ir, 0) / finite.length : 0;

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
          "一次至少产" + minCount + "个 qlib_expr 表达式以充分利用评估闸门"
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
    const horizonDays =
      params.horizon_days !== undefined ? Number(params.horizon_days) : undefined;
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

  "backtest.run": async (_ctx, params) => {
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
              ...((signals as Record<string, unknown>)["reverse"]
                ? { reverse: true }
                : {}),
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
      typeof params.timeout_sec === "number" && params.timeout_sec > 0
        ? params.timeout_sec
        : 30;
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

  "strategy.compose": async (_ctx, params) => {
    const strategyVersionId = String(params.strategy_version_id ?? "").trim();
    if (!strategyVersionId) {
      throw new Error("strategy.compose: strategy_version_id is required");
    }
    const factorIdsRaw = params.factor_ids;
    const ruleIdsRaw = params.rule_ids;
    const factorIds = Array.isArray(factorIdsRaw)
      ? factorIdsRaw.filter((s): s is string => typeof s === "string")
      : undefined;
    const ruleIds = Array.isArray(ruleIdsRaw)
      ? ruleIdsRaw.filter((s): s is string => typeof s === "string")
      : undefined;
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
      kind: String(params.kind ?? "factor_score") as StrategyKind,
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
};

async function dispatchTeamAgentTask(
  ctx: BuiltinToolContext,
  role: AgentRole,
  params: Record<string, unknown>
): Promise<{ dispatched: boolean; role: AgentRole; runId: string; via: string }> {
  const targetRole = resolveDispatchRole(role);
  const topology = await loadOrchestratorTopologyForWorkflow(ctx.workflowId);
  if (ctx.definition.role === "orchestrator" && topology && topology.targets.length > 0) {
    assertTopologyTargetAllowed(topology, targetRole);
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

  const { runId } = await dispatchTaskToRole({
    workflowId: ctx.workflowId,
    role: targetRole,
    payload,
    traceId: ctx.traceId,
    senderId: ctx.agentInstanceId,
  });
  return { dispatched: true, role: targetRole, runId, via: "topology_dispatch" };
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
