import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  instrument as instrumentTable,
  recommendationSnapshot,
  strategy as strategyTable,
  strategyVersion as strategyVersionTable,
} from "../../db/sqlite/schema";
import type { OrderSide, OrderType, TimeInForce } from "../../types/entities";
import {
  recommendationService,
} from "../effect-validation/recommendation-service";
import { createOrderIntentWithExecution } from "../execution/order-intent-service";
import { factorService } from "../factor/factor-service";
import { isLikelyProjectIdFormat } from "./context-params";
import {
  coerceConfidence01,
  coerceRecommendationSide,
} from "./research-arg-normalize";
export { resolveDelegatedParentTaskId } from "../orchestration/team-dispatch-adapter";
import { strategyComposer } from "../strategy/strategy-composer";
import type { StrategyKind, WeightMethod } from "../strategy/strategy-composer";
import type { BuiltinToolContext, BuiltinToolHandler } from "./types";

function optionalFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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

export const STRATEGY_EXECUTION_HANDLERS: Record<string, BuiltinToolHandler> = {
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
    const nestedStrategy =
      params.strategy && typeof params.strategy === "object" && !Array.isArray(params.strategy)
        ? (params.strategy as Record<string, unknown>)
        : null;
    const name = String(
      params.name ?? params.strategyName ?? nestedStrategy?.name ?? ""
    ).trim();
    if (!name) {
      throw new Error(
        "strategy.create_version: name (策略名) is required（也接受 strategyName / strategy.name）"
      );
    }
    /**
     * projectId 解析：优先 ctx（来自 workflow_run.project_id），其次 params 显式传入；
     * 与 factor.register 完全一致的优先级，避免 LLM 用错。
     */
    const fromParams = String(params.project_id ?? "").trim();
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
   *   - dispatch_mode (可选)：'paper' | 'sim' | 'live'（默认 paper；sim=Futu 等券商模拟盘）
   *   - broker_account_id (sim/live 建议)：sim 可省略，自动解析启用的 Futu sandbox
   *
   * 返回：{ orderIntentId, executionTaskId, riskOutcome, riskReason, riskReviewTicketId }
   */
  "order.create_intent": async (ctx, params) => {
    let strategyVersionId = String(params.strategy_version_id ?? "").trim();
    if (!strategyVersionId && ctx.workflowId) {
      const db = await getDb();
      const latest = await db
        .select({ id: strategyVersionTable.id })
        .from(strategyVersionTable)
        .where(eq(strategyVersionTable.workflowRunId, ctx.workflowId))
        .orderBy(desc(strategyVersionTable.createdAt))
        .limit(1);
      strategyVersionId = latest[0]?.id ?? "";
    }
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
    const sideMap: Record<string, OrderSide> = {
      buy: "buy",
      long: "buy",
      bullish: "buy",
      sell: "sell",
      short: "sell",
      bearish: "sell",
    };
    const side = sideMap[sideRaw];
    if (!side) {
      throw new Error(
        `order.create_intent: side 必须是 'buy'/'sell'（或 long/short），收到: ${sideRaw}`
      );
    }
    const qtyRaw = Number(params.qty);
    if (!Number.isFinite(qtyRaw) || qtyRaw <= 0) {
      throw new Error(`order.create_intent: qty 必须是正数，收到: ${String(params.qty ?? "")}`);
    }
    const qty = qtyRaw;
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
    const { parseDispatchMode } = await import("../execution/live-trading-gate");
    const { resolveDefaultSimBrokerAccountId } = await import(
      "../execution/resolve-sim-broker-account"
    );
    let dispatchMode;
    try {
      dispatchMode = parseDispatchMode(params.dispatch_mode ?? "paper");
    } catch {
      throw new Error(
        `order.create_intent: dispatch_mode 必须是 'paper' | 'sim' | 'live'（sim=券商模拟盘如 Futu sandbox），收到: ${String(params.dispatch_mode ?? "")}`
      );
    }
    let brokerAccountId =
      String(params.broker_account_id ?? params.brokerAccountId ?? "").trim() || null;
    if (dispatchMode === "sim" && !brokerAccountId) {
      brokerAccountId = await resolveDefaultSimBrokerAccountId("futu");
      if (!brokerAccountId) {
        throw new Error(
          "order.create_intent: dispatch_mode=sim 需要 broker_account_id，或先配置启用的 Futu sandbox 券商账户"
        );
      }
    }
    if ((dispatchMode === "live" || dispatchMode === "sim") && !brokerAccountId) {
      throw new Error(
        `order.create_intent: dispatch_mode=${dispatchMode} 必须传 broker_account_id`
      );
    }
    const snapshotId = String(params.snapshot_id ?? params.snapshotId ?? "").trim() || null;
    const thesisId = String(params.thesis_id ?? params.thesisId ?? "").trim() || null;
    if (dispatchMode === "live" && !thesisId) {
      throw new Error(
        "order.create_intent: dispatch_mode=live 必须传 thesisId（先 research.thesis.write；snapshot 可从 thesis 派生）"
      );
    }
    if (dispatchMode === "live" && !snapshotId && !thesisId) {
      throw new Error(
        "order.create_intent: dispatch_mode=live 必须传 snapshotId 或 thesisId"
      );
    }

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
      timeframe: typeof params.timeframe === "string" ? (params.timeframe as string) : null,
      dispatchMode,
      brokerAccountId,
      snapshotId,
      thesisId,
      requireDataQualityGate: dispatchMode === "live" || snapshotId != null || thesisId != null,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    });

    const paperLifecycle =
      result.riskOutcome === "block"
        ? "risk_blocked"
        : result.riskOutcome === "review"
          ? "pending_approval"
          : "risk_checked";
    return {
      orderIntentId: result.orderIntentId,
      executionTaskId: result.executionTaskId,
      riskOutcome: result.riskOutcome,
      riskReason: result.riskReason,
      riskReviewTicketId: result.riskReviewTicketId,
      paperLifecycle,
      symbol: sym,
      snapshotId: result.snapshotId ?? snapshotId,
      thesisId: result.thesisId ?? thesisId,
      dataQualityWarnings: result.dataQualityWarnings ?? [],
      side,
      qty,
      orderType,
      dispatchMode,
    };
  },

  "recommendation.record": async (ctx, params) => {
    if (!ctx.workflowId || ctx.workflowId === "prime-bridge") {
      throw new Error(
        "recommendation.record: 需要绑定真实 workflow（当前无 workflow 上下文）。请在研究工作流内调用，勿在游离 bridge 会话落库。"
      );
    }
    // Models often nest fields under `arguments`; top-level wins on conflict.
    const nested =
      params.arguments &&
      typeof params.arguments === "object" &&
      !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : null;
    const p: Record<string, unknown> = nested ? { ...nested, ...params } : params;
    delete p.arguments;

    const symbol = String(p.symbol ?? p.ticker ?? p.code ?? "")
      .trim()
      .replace(/^(US|HK|CN|SH|SZ):/i, "");
    if (!symbol) {
      throw new Error(
        "recommendation.record: symbol/ticker is required（可放在顶层或 arguments 内；US:TICKER 前缀会自动剥掉）"
      );
    }
    const side =
      coerceRecommendationSide(p.side) ??
      coerceRecommendationSide(p.action) ??
      coerceRecommendationSide(p.conviction) ??
      "long";
    const horizonDays = Number(p.horizon_days ?? p.horizonDays ?? 20);
    const confidence = coerceConfidence01(p.confidence ?? p.conviction, 0.5);
    const scoreRaw = p.score;
    const evidenceRaw = p.evidence ?? p.evidence_json;
    const evidence = Array.isArray(evidenceRaw) ? evidenceRaw : [];
    let result;
    try {
      result = await recommendationService.record({
      workflowRunId: ctx.workflowId,
      symbol,
      market: typeof p.market === "string" ? p.market : "US",
      side,
      horizonDays: Number.isFinite(horizonDays) && horizonDays > 0 ? Math.floor(horizonDays) : 20,
      confidence,
      score: scoreRaw !== undefined && Number.isFinite(Number(scoreRaw)) ? Number(scoreRaw) : null,
      entryLow: optionalFiniteNumber(p.entry_low ?? p.entryLow),
      entryHigh: optionalFiniteNumber(p.entry_high ?? p.entryHigh),
      stopLoss: optionalFiniteNumber(p.stop_loss ?? p.stopLoss),
      takeProfit: optionalFiniteNumber(
        p.take_profit ?? p.takeProfit ?? p.target_price
      ),
      positionSizePct: optionalFiniteNumber(p.position_size_pct ?? p.positionSizePct),
      riskRewardRatio: optionalFiniteNumber(p.risk_reward_ratio ?? p.riskRewardRatio),
      rationale: String(p.rationale ?? p.reasoning ?? p.strategy ?? p.action ?? ""),
      evidence,
      invalidation:
        Array.isArray(p.invalidation_conditions) && p.invalidation_conditions.length > 0
          ? p.invalidation_conditions
          : [
              "价格跌破止损价",
              "关键基本面假设失效（业绩/指引大幅低于预期）",
              "持有期结束仍未触发目标价",
            ],
      watchConditions: Array.isArray(p.watch_conditions) ? p.watch_conditions : [],
      benchmarkSymbol: typeof p.benchmark_symbol === "string" ? p.benchmark_symbol : null,
      expiresAt: typeof p.expires_at === "string" ? p.expires_at : null,
      dataAsof: typeof p.data_asof === "string" ? p.data_asof : null,
      sourceArtifactKind:
        typeof p.source_artifact_kind === "string" ? p.source_artifact_kind : null,
      sourceArtifactId:
        typeof p.source_artifact_id === "string" ? p.source_artifact_id : null,
      createdBy: "agent",
      agentInstanceId: ctx.agentInstanceId || null,
      ...(typeof p.asof === "string" ? { asof: p.asof } : {}),
    });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/FOREIGN KEY/i.test(msg)) {
        throw new Error(
          `recommendation.record: FK 失败（workflow=${ctx.workflowId}, project=${ctx.projectId ?? "?"}, agentInstance=${ctx.agentInstanceId || "null"}）。` +
            `通常是 workflow 未绑定 / project 缺失 / agent_instance 无效。原始错误: ${msg}`
        );
      }
      throw err;
    }
    // Write-after-read: tool success must mean snapshot is queryable for this workflow+side.
    const db = await getDb();
    const verified = await db
      .select({ id: recommendationSnapshot.id })
      .from(recommendationSnapshot)
      .where(
        and(
          eq(recommendationSnapshot.id, result.id),
          eq(recommendationSnapshot.workflowRunId, ctx.workflowId),
          eq(recommendationSnapshot.side, side)
        )
      )
      .limit(1);
    if (!verified[0]) {
      throw new Error(
        `recommendation.record: write-after-read failed (id=${result.id}, workflow=${ctx.workflowId}, side=${side})`
      );
    }
    return {
      recommendationId: result.id,
      symbol: result.symbol,
      side,
      workflowRunId: ctx.workflowId,
      next_steps:
        "推荐已进入 DecisionSignal 生命周期；outcome worker 会按 horizon_days 自动回填效果。",
    };
  },

  "strategy.compose": async (ctx, params) => {
    let strategyVersionId = String(params.strategy_version_id ?? "").trim();
    if (!strategyVersionId && ctx.workflowId) {
      const db = await getDb();
      const latest = await db
        .select({ id: strategyVersionTable.id })
        .from(strategyVersionTable)
        .where(eq(strategyVersionTable.workflowRunId, ctx.workflowId))
        .orderBy(desc(strategyVersionTable.createdAt))
        .limit(1);
      strategyVersionId = latest[0]?.id ?? "";
    }
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
};
