import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { backtestJobService } from "../backtest/backtest-job-service";
import { discoveryService } from "../discovery/discovery-service";
import type { DiscoveryKind } from "../discovery/discovery-service";
import { finalHoldoutEvaluationService } from "../effect-validation/final-holdout-evaluation-service";
import {
  type WalkForwardParameterCandidate,
  type WalkForwardRunOptions,
  walkForwardEvaluationService,
} from "../effect-validation/walk-forward-evaluation-service";
import { factorService } from "../factor/factor-service";
import type { FactorCategory, FactorLang, FactorStatus } from "../factor/factor-service";
import { isLikelyProjectIdFormat } from "./context-params";
export { resolveDelegatedParentTaskId } from "../orchestration/team-dispatch-adapter";
import type {
  BacktestCosts,
  BacktestInstrumentSpec,
  FactorComputeRow,
  RuleEvalContext,
} from "../provider/types";
import { factorBacktestPromotionService } from "../quant/factor-backtest-promotion-service";
import { ruleService } from "../rule/rule-service";
import type { RuleAppliesTo, RuleLang, RuleStatus } from "../rule/rule-service";
import { PYTHON_HANDLER } from "./python-handler";
import type { BuiltinToolHandler } from "./types";
import { coerceSymbolList, defaultDateWindow, unwrapToolArgs } from "./unwrap-tool-args";

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
  const direct = params.factor_id ?? params.factorId;
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

/** Accept the date aliases exposed by the Core/bridge tool surface. */
export function pickDateParam(
  params: Record<string, unknown>,
  snake: "start_date" | "end_date"
): string {
  const aliases =
    snake === "start_date"
      ? ["start_date", "startDate", "start", "from"]
      : ["end_date", "endDate", "end", "to", "asOf"];
  const v = aliases.map((key) => params[key]).find((value) => typeof value === "string");
  return typeof v === "string" ? v.trim() : "";
}

/** Prefer explicit dates; else last ~1y UTC window. */
function resolveDateWindow(params: Record<string, unknown>): {
  startDate: string;
  endDate: string;
  defaulted: boolean;
} {
  let startDate = pickDateParam(params, "start_date");
  let endDate = pickDateParam(params, "end_date");
  if (startDate && endDate) return { startDate, endDate, defaulted: false };
  const d = defaultDateWindow(365);
  if (!startDate) startDate = d.start_date;
  if (!endDate) endDate = d.end_date;
  return { startDate, endDate, defaulted: true };
}

function resolveBacktestExperiment(params: Record<string, unknown>): {
  parameterSelection: "fixed_before_run" | "full_sample_optimized" | "unknown";
  preRegistrationId?: string;
  candidateTrials?: number;
} {
  const raw = params.parameter_selection ?? params.parameterSelection ?? "unknown";
  if (raw !== "fixed_before_run" && raw !== "full_sample_optimized" && raw !== "unknown") {
    throw new Error(
      `parameter_selection must be fixed_before_run, full_sample_optimized, or unknown; got ${String(raw)}`
    );
  }
  const preRegistrationId = String(
    params.pre_registration_id ?? params.preRegistrationId ?? ""
  ).trim();
  const candidateTrialsRaw = params.candidate_trials ?? params.candidateTrials;
  const candidateTrials = candidateTrialsRaw === undefined ? undefined : Number(candidateTrialsRaw);
  if (
    candidateTrials !== undefined &&
    (!Number.isInteger(candidateTrials) || candidateTrials < 1 || candidateTrials > 10_000)
  ) {
    throw new Error(
      `candidate_trials must be an integer from 1 to 10000; got ${String(candidateTrialsRaw)}`
    );
  }
  return {
    parameterSelection: raw,
    ...(preRegistrationId ? { preRegistrationId } : {}),
    ...(candidateTrials !== undefined ? { candidateTrials } : {}),
  };
}

/** Preserve the full frozen execution-cost contract instead of silently dropping fields. */
function resolveBacktestCosts(params: Record<string, unknown>): BacktestCosts | undefined {
  const raw = params.costs;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("costs must be an object");
  }
  const costs = raw as Record<string, unknown>;
  const optionalNumber = (camel: string, snake: string): number | undefined => {
    const value = costs[camel] ?? costs[snake];
    return value === undefined ? undefined : Number(value);
  };
  const optionalText = (camel: string, snake: string): string | undefined => {
    const value = costs[camel] ?? costs[snake];
    if (value === undefined) return undefined;
    const text = String(value).trim();
    return text || undefined;
  };
  const restricted = costs.restrictedShortSymbols ?? costs.restricted_short_symbols;
  const minCommission = optionalNumber("minCommission", "min_commission");
  const impactCoefficient = optionalNumber("impactCoefficient", "impact_coefficient");
  const maxVolumeParticipation = optionalNumber(
    "maxVolumeParticipation",
    "max_volume_participation"
  );
  const borrowRateAnnualBps = optionalNumber("borrowRateAnnualBps", "borrow_rate_annual_bps");
  const costModelVersion = optionalText("costModelVersion", "cost_model_version");
  const costModelSource = optionalText("costModelSource", "cost_model_source");
  const costModelAsOf = optionalText("costModelAsOf", "cost_model_as_of");
  return {
    commissionBps: Number(costs.commissionBps ?? costs.commission_bps ?? 5),
    slippageBps: Number(costs.slippageBps ?? costs.slippage_bps ?? 5),
    ...(minCommission !== undefined ? { minCommission } : {}),
    ...(costs.slippageModel !== undefined || costs.slippage_model !== undefined
      ? {
          slippageModel: String(costs.slippageModel ?? costs.slippage_model) as NonNullable<
            BacktestCosts["slippageModel"]
          >,
        }
      : {}),
    ...(impactCoefficient !== undefined ? { impactCoefficient } : {}),
    ...(maxVolumeParticipation !== undefined ? { maxVolumeParticipation } : {}),
    ...(borrowRateAnnualBps !== undefined ? { borrowRateAnnualBps } : {}),
    ...(Array.isArray(restricted) ? { restrictedShortSymbols: restricted.map(String) } : {}),
    ...(costModelVersion ? { costModelVersion } : {}),
    ...(costModelSource ? { costModelSource } : {}),
    ...(costModelAsOf ? { costModelAsOf } : {}),
  };
}

function resolveBacktestInstruments(
  params: Record<string, unknown>
): Record<string, BacktestInstrumentSpec> | undefined {
  const raw = params.instruments ?? params.instrument_specs ?? params.instrumentSpecs;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("instruments must be an object keyed by symbol");
  }
  const result: Record<string, BacktestInstrumentSpec> = {};
  for (const [symbol, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`instruments.${symbol} must be an object`);
    }
    const item = value as Record<string, unknown>;
    result[symbol] = {
      assetClass: String(
        item.asset_class ?? item.assetClass ?? "stock"
      ) as BacktestInstrumentSpec["assetClass"],
      ...(item.contract_kind !== undefined || item.contractKind !== undefined
        ? {
            contractKind: String(item.contract_kind ?? item.contractKind) as NonNullable<
              BacktestInstrumentSpec["contractKind"]
            >,
          }
        : {}),
      ...(item.contract_multiplier !== undefined || item.contractMultiplier !== undefined
        ? { contractMultiplier: Number(item.contract_multiplier ?? item.contractMultiplier) }
        : {}),
      ...(item.lot_size !== undefined || item.lotSize !== undefined
        ? { lotSize: Number(item.lot_size ?? item.lotSize) }
        : {}),
      ...(item.initial_margin_rate !== undefined || item.initialMarginRate !== undefined
        ? { initialMarginRate: Number(item.initial_margin_rate ?? item.initialMarginRate) }
        : {}),
      ...(item.maintenance_margin_rate !== undefined || item.maintenanceMarginRate !== undefined
        ? {
            maintenanceMarginRate: Number(
              item.maintenance_margin_rate ?? item.maintenanceMarginRate
            ),
          }
        : {}),
      ...(item.target_leverage !== undefined || item.targetLeverage !== undefined
        ? { targetLeverage: Number(item.target_leverage ?? item.targetLeverage) }
        : {}),
      ...(item.expiry_date !== undefined || item.expiryDate !== undefined
        ? { expiryDate: String(item.expiry_date ?? item.expiryDate) }
        : {}),
      ...(item.settlement_mode !== undefined || item.settlementMode !== undefined
        ? {
            settlementMode: String(item.settlement_mode ?? item.settlementMode) as NonNullable<
              BacktestInstrumentSpec["settlementMode"]
            >,
          }
        : {}),
      ...(item.underlying_symbol !== undefined || item.underlyingSymbol !== undefined
        ? { underlyingSymbol: String(item.underlying_symbol ?? item.underlyingSymbol) }
        : {}),
      ...(item.strike !== undefined ? { strike: Number(item.strike) } : {}),
      ...(item.option_right !== undefined || item.optionRight !== undefined
        ? {
            optionRight: String(item.option_right ?? item.optionRight) as NonNullable<
              BacktestInstrumentSpec["optionRight"]
            >,
          }
        : {}),
      ...(item.exercise_style !== undefined || item.exerciseStyle !== undefined
        ? {
            exerciseStyle: String(item.exercise_style ?? item.exerciseStyle) as NonNullable<
              BacktestInstrumentSpec["exerciseStyle"]
            >,
          }
        : {}),
      ...(item.pricing_model !== undefined || item.pricingModel !== undefined
        ? {
            pricingModel: String(item.pricing_model ?? item.pricingModel) as NonNullable<
              BacktestInstrumentSpec["pricingModel"]
            >,
          }
        : {}),
      ...(item.future_roll !== undefined || item.futureRoll !== undefined
        ? { futureRoll: resolveFutureRoll(item.future_roll ?? item.futureRoll, symbol) }
        : {}),
    };
  }
  return result;
}

function resolveFutureRoll(
  raw: unknown,
  symbol: string
): NonNullable<BacktestInstrumentSpec["futureRoll"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`instruments.${symbol}.future_roll must be an object`);
  }
  const item = raw as Record<string, unknown>;
  return {
    rollDate: String(item.roll_date ?? item.rollDate ?? ""),
    successorSymbol: String(item.successor_symbol ?? item.successorSymbol ?? ""),
  };
}

function resolveWalkForwardOptions(params: Record<string, unknown>): WalkForwardRunOptions {
  const foldsRaw = params.folds ?? params.fold_count ?? params.foldCount;
  const purgeDaysRaw = params.purge_days ?? params.purgeDays;
  const embargoDaysRaw = params.embargo_days ?? params.embargoDays;
  const selectionRaw = params.selection;
  const selectionObject =
    selectionRaw && typeof selectionRaw === "object" && !Array.isArray(selectionRaw)
      ? (selectionRaw as Record<string, unknown>)
      : undefined;
  const candidatesRaw =
    selectionObject?.candidates ??
    params.selection_candidates ??
    params.selectionCandidates ??
    params.candidates;
  const candidates = Array.isArray(candidatesRaw)
    ? candidatesRaw.map((raw): WalkForwardParameterCandidate => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const candidate = raw as Record<string, unknown>;
        const topNRaw = candidate.top_n ?? candidate.topN;
        const rebalanceRaw = candidate.rebalance;
        const longShortRaw = candidate.long_short ?? candidate.longShort;
        return {
          ...(topNRaw !== undefined ? { topN: Number(topNRaw) } : {}),
          ...(rebalanceRaw !== undefined
            ? {
                rebalance: String(rebalanceRaw) as "daily" | "weekly" | "monthly",
              }
            : {}),
          ...(longShortRaw !== undefined
            ? { longShort: longShortRaw === true || longShortRaw === "true" }
            : {}),
        };
      })
    : undefined;
  const objectiveRaw = selectionObject?.objective ?? params.selection_objective ?? params.objective;
  return {
    ...(foldsRaw !== undefined ? { folds: Number(foldsRaw) } : {}),
    ...(purgeDaysRaw !== undefined ? { purgeDays: Number(purgeDaysRaw) } : {}),
    ...(embargoDaysRaw !== undefined ? { embargoDays: Number(embargoDaysRaw) } : {}),
    ...(candidates
      ? {
          selection: {
            objective: String(objectiveRaw ?? "sharpe") as "sharpe" | "calmar" | "annual_return",
            candidates,
          },
        }
      : {}),
  };
}

/** Factor, rule, discovery and backtest handlers. */
export const FACTOR_RESEARCH_HANDLERS: Record<string, BuiltinToolHandler> = {
  // ─── M2：因子/规则/策略 三段式 Agent 工具 ────────────────────────────────
  // 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.1-6.3
  // 调用方向：handler → Service → ProviderResolver → 具体 Provider 实现

  "factor.register": async (ctx, params) => {
    const projectId = String(params.project_id ?? ctx.projectId ?? "").trim();
    if (!projectId) throw new Error("factor.register: project_id is required");
    const definitionRaw = params.definition;
    const definition: Record<string, unknown> =
      definitionRaw && typeof definitionRaw === "object" && !Array.isArray(definitionRaw)
        ? { ...(definitionRaw as Record<string, unknown>) }
        : {};
    const modelFactorRaw =
      params.model_factor ??
      params.modelFactor ??
      definition.modelFactor ??
      definition.model_factor;
    if (modelFactorRaw && typeof modelFactorRaw === "object" && !Array.isArray(modelFactorRaw)) {
      definition.modelFactor = modelFactorRaw as Record<string, unknown>;
    }
    const researchContractRaw =
      params.research_contract ?? params.researchContract ?? definition.researchContract;
    if (researchContractRaw !== undefined) {
      if (
        !researchContractRaw ||
        typeof researchContractRaw !== "object" ||
        Array.isArray(researchContractRaw)
      ) {
        throw new Error("factor.register: research_contract must be an object");
      }
      definition.researchContract = researchContractRaw as Record<string, unknown>;
    }
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
    const exprRaw = String(
      params.expr ?? params.expression ?? params.factor_expression ?? params.factorExpression ?? ""
    ).trim();
    const explicitLang = params.lang ? String(params.lang) : null;
    const isModelFactor =
      explicitLang === "ml_score" ||
      Boolean(definition.modelFactor) ||
      /^model:\/\//i.test(exprRaw);

    if (isModelFactor) {
      return factorService.register({
        projectId,
        name: String(params.name ?? "").trim(),
        category: String(params.category ?? "momentum") as FactorCategory,
        expr: exprRaw,
        lang: "ml_score",
        providerKey: String(params.provider_key ?? params.providerKey ?? "external_ml"),
        ...(params.universe ? { universe: String(params.universe) } : {}),
        ...(params.horizon !== undefined ? { horizon: Number(params.horizon) } : {}),
        ...(params.status ? { status: String(params.status) as FactorStatus } : {}),
        definition,
        ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
        createdBy: "agent",
        ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
        dryRun,
      });
    }

    const { normalizeFactorExpression, inferFactorLang, formatUnsupportedExpressionError } =
      await import("../policy/factor-expression-contract");
    const normalized = normalizeFactorExpression(exprRaw);
    if (normalized.unsupported.length > 0) {
      throw new Error(
        formatUnsupportedExpressionError({
          expr: exprRaw,
          reason: `contains unsupported symbols: ${normalized.unsupported.join(", ")}`,
          rewrites: normalized.rewrites,
        })
      );
    }
    const lang = inferFactorLang(normalized.expr, explicitLang);
    const expr = normalized.expr;
    return factorService.register({
      projectId,
      name: String(params.name ?? "").trim(),
      category: String(params.category ?? "momentum") as FactorCategory,
      expr,
      lang: lang as FactorLang,
      ...(params.universe ? { universe: String(params.universe) } : {}),
      ...(params.horizon !== undefined ? { horizon: Number(params.horizon) } : {}),
      ...(params.status ? { status: String(params.status) as FactorStatus } : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
      ...(Object.keys(definition).length > 0 ? { definition } : {}),
      // ctx.workflowId 在 react act 节点保证非空；落库后用于研究产出严格过滤
      ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
      // lineage（migration 0080）：所有 builtin tool 路径默认归为 'agent'，
      // 让前端 LineageBadge 能与 IDE / REST 直接调用的 'user' 路径区分。
      createdBy: "agent",
      ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
      dryRun,
    });
  },

  "factor.set_research_contract": async (_ctx, params) => {
    const factorId = pickFactorId(params);
    if (!factorId) {
      throw new Error("factor.set_research_contract: factor_id is required");
    }
    const contract = params.research_contract ?? params.researchContract ?? params.contract;
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      throw new Error("factor.set_research_contract: research_contract object is required");
    }
    return factorService.setResearchContract(factorId, contract);
  },

  "factor.activate": async (_ctx, params) => {
    const factorId = pickFactorId(params);
    if (!factorId) throw new Error("factor.activate: factor_id is required");
    return factorService.activate(factorId);
  },

  /**
   * 把外部已训好的模型 / 实时打分服务发布为可评估的 ml_score 因子。
   * 不训练；只写 factor_definition + modelFactor 绑定。
   */
  "model.publish_as_factor": async (ctx, params) => {
    const projectId = String(params.project_id ?? ctx.projectId ?? "").trim();
    if (!projectId) throw new Error("model.publish_as_factor: project_id is required");
    const modelFactorRaw = params.model_factor ?? params.modelFactor ?? params;
    const { parseModelFactorBinding, buildModelFactorExpr } = await import(
      "../provider/model-factor-contract"
    );
    const binding = parseModelFactorBinding({
      adapterKey:
        (modelFactorRaw as Record<string, unknown>).adapterKey ??
        (modelFactorRaw as Record<string, unknown>).adapter_key ??
        params.adapter_key ??
        params.adapterKey,
      modelId:
        (modelFactorRaw as Record<string, unknown>).modelId ??
        (modelFactorRaw as Record<string, unknown>).model_id ??
        params.model_id ??
        params.modelId,
      modelVersion:
        (modelFactorRaw as Record<string, unknown>).modelVersion ??
        (modelFactorRaw as Record<string, unknown>).model_version ??
        params.model_version ??
        params.modelVersion,
      artifactUri:
        (modelFactorRaw as Record<string, unknown>).artifactUri ??
        (modelFactorRaw as Record<string, unknown>).artifact_uri ??
        params.artifact_uri ??
        params.artifactUri,
      contentHash:
        (modelFactorRaw as Record<string, unknown>).contentHash ??
        (modelFactorRaw as Record<string, unknown>).content_hash ??
        params.content_hash ??
        params.contentHash,
      framework: (modelFactorRaw as Record<string, unknown>).framework ?? params.framework,
      featureSpecId:
        (modelFactorRaw as Record<string, unknown>).featureSpecId ??
        (modelFactorRaw as Record<string, unknown>).feature_spec_id ??
        params.feature_spec_id ??
        params.featureSpecId,
      trainEndAsOf:
        (modelFactorRaw as Record<string, unknown>).trainEndAsOf ??
        (modelFactorRaw as Record<string, unknown>).train_end_as_of ??
        params.train_end_as_of ??
        params.trainEndAsOf,
      scoreTransform:
        (modelFactorRaw as Record<string, unknown>).scoreTransform ??
        (modelFactorRaw as Record<string, unknown>).score_transform ??
        params.score_transform ??
        params.scoreTransform,
      adapterConfig:
        (modelFactorRaw as Record<string, unknown>).adapterConfig ??
        (modelFactorRaw as Record<string, unknown>).adapter_config ??
        params.adapter_config ??
        params.adapterConfig,
    });
    const name =
      String(params.name ?? "").trim() ||
      `${binding.modelId}_${binding.modelVersion}`.replace(/[^a-zA-Z0-9_.-]+/g, "_");
    const dryRunParam = params.dry_run ?? params.dryRun;
    const dryRun = !(
      dryRunParam === false ||
      dryRunParam === "false" ||
      dryRunParam === 0 ||
      dryRunParam === "off"
    );
    return factorService.register({
      projectId,
      name,
      category: String(params.category ?? "momentum") as FactorCategory,
      expr: buildModelFactorExpr(binding),
      lang: "ml_score",
      providerKey: "external_ml",
      ...(params.universe ? { universe: String(params.universe) } : {}),
      ...(params.horizon !== undefined ? { horizon: Number(params.horizon) } : {}),
      ...(params.status ? { status: String(params.status) as FactorStatus } : {}),
      definition: { modelFactor: binding },
      ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
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
      ...((params.dataset_snapshot_id ??
      params.datasetSnapshotId ??
      params.snapshot_id ??
      params.snapshotId)
        ? {
            datasetSnapshotId: String(
              params.dataset_snapshot_id ??
                params.datasetSnapshotId ??
                params.snapshot_id ??
                params.snapshotId
            ),
          }
        : {}),
      ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
    });
    if (result.meta.rowCount === 0) {
      throw new Error(
        `factor.compute: no_factor_values_written (factor_id=${factorId}). 行情源在该 symbols/区间没有返回可计算数据；不要继续调用 factor.autoEvaluate。请切换可用数据源、市场或 symbols 后最多重试一次；仍为空则明确报告数据不可用并终止因子评估。`
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

  "factor.autoEvaluate": async (ctx, paramsIn) => {
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
    const params = unwrapToolArgs(paramsIn);
    let factorId = pickFactorId(params);
    const exprRaw =
      typeof params.factor_expression === "string"
        ? params.factor_expression
        : typeof params.expr === "string"
          ? (params.expr as string)
          : "";
    const isOneShot = exprRaw.trim().length > 0 && !factorId;

    const { startDate, endDate } = resolveDateWindow(params);
    const datasetSnapshotId = String(
      params.dataset_snapshot_id ??
        params.datasetSnapshotId ??
        params.snapshot_id ??
        params.snapshotId ??
        ""
    ).trim();

    if (!factorId && exprRaw.trim().length > 0) {
      /**
       * 双保险（B+ Phase 1.1）：act 入口已 rewrite placeholder，但这里仍做
       * 形态校验，避免任何旁路绕过 act（e.g. 直接 dispatchBuiltinTool 单测）。
       *
       * 优先级：ctx.projectId（来自 workflow_run.project_id）> params["project_id"]
       *   （仅当形态合法时使用），其他情况报清晰错误。
       */
      const fromParams = String(params.project_id ?? "").trim();
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
      const name = String(params.name ?? `auto_${Date.now()}`).trim();
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
          category: String(params.category ?? "momentum") as FactorCategory,
          expr: exprRaw.trim(),
          ...(params.lang
            ? { lang: String(params.lang) as FactorLang }
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
          ...(datasetSnapshotId ? { datasetSnapshotId } : {}),
          ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
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
          `factor.autoEvaluate: ${partial} 内部 factor.compute 失败: ${(err as Error).message}。请检查 expr 语法 / symbols 是否有真实 K 线数据 / provider 是否可用。`
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
        `factor.autoEvaluate: symbols 数量过少（当前 ${symbols.length} 只: ${symbols.join(",")}）。IC/RankIC 是 **横截面** 指标，每日至少需要 3 只 symbols 才能计算 Pearson/Spearman；推荐 ≥ 10 只。请改用 ≥3 只 symbols 重跑，例如 ["AAPL","MSFT","NVDA","GOOG","META"]，或不传 symbols（用 factor.compute 时录入的全部 symbols）。`
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
      ...(datasetSnapshotId ? { datasetSnapshotId } : {}),
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
        ...(datasetSnapshotId ? { datasetSnapshotId } : {}),
        ...(params.provider_key ? { providerKey: String(params.provider_key) } : {}),
      });
      if (computeResult.meta.rowCount === 0) {
        throw new Error(
          `factor.autoEvaluate: no_factor_values_written (factor_id=${factorId}). 已自动执行一次 factor.compute，但行情源仍未返回数据；不要继续重试 autoEvaluate。请切换数据源、市场或 symbols，仍为空则明确报告数据不可用。`
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
          sortedByRankIc.length > 0 ? sortedByRankIc[sortedByRankIc.length - 1]?.factor_id : null,
      },
      results: items,
    };
  },

  "factor.correlation.diagnose": async (_ctx, paramsIn) => {
    const params = unwrapToolArgs(paramsIn);
    const rawFactorIds = params.factor_ids ?? params.factorIds;
    const factorIds = Array.isArray(rawFactorIds)
      ? [
          ...new Set(
            rawFactorIds
              .filter(
                (value): value is string => typeof value === "string" && value.trim().length > 0
              )
              .map((value) => value.trim())
          ),
        ]
      : [];
    if (factorIds.length < 2) {
      throw new Error("factor.correlation.diagnose: at least two factor_ids are required");
    }
    const datasetSnapshotId = String(
      params.dataset_snapshot_id ??
        params.datasetSnapshotId ??
        params.snapshot_id ??
        params.snapshotId ??
        ""
    ).trim();
    if (!datasetSnapshotId) {
      throw new Error("factor.correlation.diagnose: dataset_snapshot_id is required");
    }
    const maxAbsCorrelation = Number(params.max_abs_correlation ?? params.maxAbsCorrelation ?? 0.7);
    const minimumObservations = Number(
      params.minimum_observations ?? params.minimumObservations ?? 60
    );
    if (!Number.isFinite(maxAbsCorrelation) || maxAbsCorrelation <= 0 || maxAbsCorrelation > 1) {
      throw new Error("factor.correlation.diagnose: max_abs_correlation must be in (0, 1]");
    }
    if (!Number.isInteger(minimumObservations) || minimumObservations < 2) {
      throw new Error("factor.correlation.diagnose: minimum_observations must be an integer >= 2");
    }
    return factorService.diagnoseCorrelation({
      factorIds,
      datasetSnapshotId,
      maxAbsCorrelation,
      minimumObservations,
    });
  },

  "factor.exposure.diagnose": async (_ctx, paramsIn) => {
    const params = unwrapToolArgs(paramsIn);
    const rawFactorIds = params.factor_ids ?? params.factorIds;
    const factorIds = Array.isArray(rawFactorIds)
      ? [
          ...new Set(
            rawFactorIds
              .filter(
                (value): value is string => typeof value === "string" && value.trim().length > 0
              )
              .map((value) => value.trim())
          ),
        ]
      : [];
    if (factorIds.length < 2) {
      throw new Error("factor.exposure.diagnose: at least two factor_ids are required");
    }
    const datasetSnapshotId = String(
      params.dataset_snapshot_id ??
        params.datasetSnapshotId ??
        params.snapshot_id ??
        params.snapshotId ??
        ""
    ).trim();
    if (!datasetSnapshotId) {
      throw new Error("factor.exposure.diagnose: dataset_snapshot_id is required");
    }
    const maximumVif = Number(params.maximum_vif ?? params.maximumVif ?? 5);
    const minimumObservations = Number(
      params.minimum_observations ?? params.minimumObservations ?? 60
    );
    if (!Number.isFinite(maximumVif) || maximumVif <= 1) {
      throw new Error("factor.exposure.diagnose: maximum_vif must be > 1");
    }
    if (!Number.isInteger(minimumObservations) || minimumObservations < 2) {
      throw new Error("factor.exposure.diagnose: minimum_observations must be an integer >= 2");
    }
    return factorService.diagnoseExposure({
      factorIds,
      datasetSnapshotId,
      maximumVif,
      minimumObservations,
    });
  },

  "factor.risk_exposure.regress": async (_ctx, paramsIn) => {
    const params = unwrapToolArgs(paramsIn);
    const factorId = pickFactorId(params);
    const datasetSnapshotId = String(
      params.dataset_snapshot_id ?? params.datasetSnapshotId ?? ""
    ).trim();
    if (!factorId || !datasetSnapshotId) {
      throw new Error(
        "factor.risk_exposure.regress: factor_id and dataset_snapshot_id are required"
      );
    }
    const minimumObservations = Number(
      params.minimum_observations ?? params.minimumObservations ?? 60
    );
    if (!Number.isInteger(minimumObservations) || minimumObservations < 2) {
      throw new Error("factor.risk_exposure.regress: minimum_observations must be an integer >= 2");
    }
    return factorService.regressRiskExposures({ factorId, datasetSnapshotId, minimumObservations });
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
        `factor.mine.llm: expressions.length(${expressions.length}) < min_count(${minCount}). 必须传 expressions:string[]（≥${minCount} 条 qlib_expr），不要只传 task/targets。示例: ["EMA(close,12)-EMA(close,26)","(close-Min(low,9))/(Max(high,9)-Min(low,9)+1e-8)","volume/Mean(volume,20)","close/Ref(close,20)-1","Corr(volume,Abs(Delta(close,1)),20)"]。若只要注册 1 条，请改用 factor.register。`
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
    const autoPromote = params.auto_promote !== false;
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
        const cand = eligible[i];
        if (!cand) continue;
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
      evaluated: job.candidateAudit.length,
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
      candidate_audit: job.candidateAudit.map((candidate) => ({
        candidate_id: candidate.id,
        decision: candidate.discoveryDecision,
        ...(candidate.error ? { error: candidate.error } : {}),
      })),
      ...(promote_errors.length > 0 ? { promote_errors } : {}),
      ...(eligible.length === 0
        ? {
            warning: `no_candidate_passed_ic_threshold(${icThreshold}); 建议：(1) 检查表达式是否过于简单 (2) 降低 ic_threshold (3) 让 LLM 重新生成一组`,
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

  "backtest.run": async (ctx, paramsIn) => {
    const params = unwrapToolArgs(paramsIn);
    const strategyVersionId = String(
      params.strategy_version_id ?? params.strategyVersionId ?? ""
    ).trim();
    if (!strategyVersionId) throw new Error("backtest.run: strategy_version_id is required");

    let symbols = coerceSymbolList(params);
    const { startDate, endDate } = resolveDateWindow(params);

    let compositionId = params.composition_id
      ? String(params.composition_id)
      : params.compositionId
        ? String(params.compositionId)
        : undefined;

    if (!compositionId) {
      const db = await getDb();
      const { strategyComposition } = await import("../../db/sqlite/schema");
      const latest = await db
        .select({
          id: strategyComposition.id,
          universe: strategyComposition.universe,
          paramsJson: strategyComposition.paramsJson,
        })
        .from(strategyComposition)
        .where(eq(strategyComposition.strategyVersionId, strategyVersionId))
        .orderBy(desc(strategyComposition.createdAt))
        .limit(1);
      if (latest[0]) {
        compositionId = latest[0].id;
        if (symbols.length === 0) {
          const pj =
            latest[0].paramsJson &&
            typeof latest[0].paramsJson === "object" &&
            !Array.isArray(latest[0].paramsJson)
              ? (latest[0].paramsJson as Record<string, unknown>)
              : {};
          symbols = coerceSymbolList({ ...pj, symbols: pj.symbols ?? pj.tickers });
        }
      }
    }

    const rawSignal = params.signals;
    const datasetSnapshotId = String(
      params.dataset_snapshot_id ??
        params.datasetSnapshotId ??
        params.snapshot_id ??
        params.snapshotId ??
        ""
    ).trim();
    const signals =
      !compositionId && rawSignal && typeof rawSignal === "object" && !Array.isArray(rawSignal)
        ? (rawSignal as Record<string, unknown>)
        : undefined;
    if (!compositionId && !signals) {
      throw new Error(
        "backtest.run: composition_id or signals is required（先 strategy.compose；若刚 compose 过可不传 composition_id，会自动取该 strategy_version 最新组合）"
      );
    }
    if (symbols.length === 0) {
      throw new Error(
        "backtest.run: symbols is required（可传 symbols[] 或单标 symbol/ticker；勿只传指数代码当唯一标的）"
      );
    }
    if (!datasetSnapshotId) {
      throw new Error(
        "backtest.run: dataset_snapshot_id is required（先调用 market.snapshot.get 冻结覆盖同一 symbols 和日期区间的数据）"
      );
    }

    const instruments = resolveBacktestInstruments(params);
    const costs = resolveBacktestCosts(params);

    return backtestJobService.submitAndRun({
      strategyVersionId,
      symbols,
      ...(params.timeframe ? { timeframe: String(params.timeframe) } : {}),
      startDate,
      endDate,
      datasetSnapshotId,
      ...(instruments ? { instruments } : {}),
      ...(compositionId ? { compositionId } : {}),
      ...(signals
        ? {
            signals: {
              kind: String((signals as Record<string, unknown>).kind ?? "factor_score"),
              expr: String((signals as Record<string, unknown>).expr ?? ""),
              lang: String((signals as Record<string, unknown>).lang ?? "qlib_expr"),
              ...((signals as Record<string, unknown>).reverse ? { reverse: true } : {}),
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
      experiment: resolveBacktestExperiment(params),
      // lineage（migration 0080）：tool 路径标 agent
      createdBy: "agent",
      ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
      ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
    });
  },

  "backtest.walk_forward": async (_ctx, paramsIn) => {
    const params = unwrapToolArgs(paramsIn);
    const backtestRunId = String(
      params.backtest_run_id ?? params.backtestRunId ?? params.job_id ?? params.jobId ?? ""
    ).trim();
    if (!backtestRunId) {
      throw new Error("backtest.walk_forward: backtest_run_id is required");
    }
    return walkForwardEvaluationService.run(backtestRunId, resolveWalkForwardOptions(params));
  },

  "backtest.final_holdout": async (_ctx, paramsIn) => {
    const params = unwrapToolArgs(paramsIn);
    const backtestRunId = String(
      params.backtest_run_id ?? params.backtestRunId ?? params.job_id ?? params.jobId ?? ""
    ).trim();
    if (!backtestRunId) {
      throw new Error("backtest.final_holdout: backtest_run_id is required");
    }
    const trainEnd = String(params.train_end ?? params.trainEnd ?? "").trim();
    const holdoutStart = String(params.holdout_start ?? params.holdoutStart ?? "").trim();
    const holdoutEnd = String(params.holdout_end ?? params.holdoutEnd ?? "").trim();
    if (!trainEnd || !holdoutStart || !holdoutEnd) {
      throw new Error(
        "backtest.final_holdout: train_end, holdout_start, and holdout_end are required"
      );
    }
    const purgeDays = params.purge_days ?? params.purgeDays;
    const embargoDays = params.embargo_days ?? params.embargoDays;
    return finalHoldoutEvaluationService.run(backtestRunId, {
      trainEnd,
      holdoutStart,
      holdoutEnd,
      ...(purgeDays !== undefined ? { purgeDays: Number(purgeDays) } : {}),
      ...(embargoDays !== undefined ? { embargoDays: Number(embargoDays) } : {}),
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
    const costs = resolveBacktestCosts(params);
    const projectId = String(params.project_id ?? ctx.projectId ?? "").trim();
    const datasetSnapshotId = String(
      params.dataset_snapshot_id ??
        params.datasetSnapshotId ??
        params.snapshot_id ??
        params.snapshotId ??
        ""
    ).trim();
    if (!datasetSnapshotId) {
      throw new Error(
        "factor.promote_backtest: dataset_snapshot_id is required（先调用 market.snapshot.get 冻结回测数据）"
      );
    }
    return factorBacktestPromotionService.promoteAndBacktest({
      ...(projectId ? { projectId } : {}),
      factorIds,
      startDate,
      endDate,
      datasetSnapshotId,
      ...(symbols && symbols.length > 0 ? { symbols } : {}),
      ...(params.timeframe ? { timeframe: String(params.timeframe) } : {}),
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
      experiment: resolveBacktestExperiment(params),
      createdBy: "agent",
      ...(ctx.workflowId ? { workflowRunId: ctx.workflowId } : {}),
      ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
    });
  },

  "code.run_python": PYTHON_HANDLER,
};
