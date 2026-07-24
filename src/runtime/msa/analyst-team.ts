/**
 * Analyst Team Engine
 *
 * 封装"并行驱动四位分析师 → 等待信号 → MSA 融合"的完整流程。
 * 供 Orchestrator 在 act 阶段调用 run_analyst_team 工具时使用。
 *
 * —— MSA × ReAct 边界 ADR (P2-C 定型) ——
 * 本文件是 MSA「Batch LLM Job 协调器」实现的主体。每个 analyst slot 在
 * `runResearchTeamSlotReact` 内是独立 ReAct loop；本协调器只负责：
 *   1) 解析编组拓扑 (`parseTeamRelations`) 划 wave
 *   2) 在每个 wave 内 Promise.allSettled fan-out
 *   3) 把前置 wave 的 outputByRole / auxDigestByRole 注入下一 wave 的 ctx
 *   4) 收集 RawAnalystSignal 调 fuseSignals 做 MSA 融合
 *
 * 不采用 LangGraph subgraph 方案的理由见 analyst-team-slot-react.ts 顶部
 * ADR。后续若再有人提议"把 MSA 实现为 subgraph"，请先阅读两处 ADR 并准备
 * 反驳上面三条拒绝理由。
 */

import { randomUUID } from "node:crypto";
import { eq, asc, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentInstance, agentProfile, workflowRun } from "../../db/sqlite/schema";
import type { AgentOutput } from "../types";
import type { AgentGroupPipelineKind } from "../seed-agent-catalog";
import { loadDebateConfig } from "../config/debate-config";
import { fuseSignals, type RawAnalystSignal } from "./signal-fusion";
import {
  resolveResearchScope,
  type NormalizedResearchScope,
  type ResearchScopeInput,
} from "../../types/research-scope";
import { defaultResearchUserContext } from "./analyst-team-scope";
import { type DebateInput, runDebateSession } from "../debate/debate-engine";
import { type DebateA2ASetup, setupDebateA2A } from "../debate/debate-a2a";
import { evaluateRiskAndVeto } from "../risk/veto-engine";
import { parseHandoffEnvelope } from "../research-team/handoff-envelope";
import { logResearchTeamInteraction } from "../research-team/interaction-log";
import type { AgentRole, AnalystSignalValue } from "../../types/entities";
import {
  parseTeamRelations,
  partitionSlotsIntoWaves,
  type TeamRelationEdge,
} from "./analyst-team-topology";
import {
  type PromptMode,
  getDataDir,
  mergeSystemPrompt,
  readPackFiles,
} from "../agent/agent-pack-service";
import { buildAnalystTeamDataContext } from "./analyst-team-context";
import { enrichSystemPromptWithFsi } from "../fsi/fsi-prompt-enricher";
import {
  decideShouldDebate,
  logOrchestratorKickoff,
  POST_FUSION_AUX_ROLES,
  resolveOrchestratorSlot,
  runOrchestratorPlanning,
  runPostFusionPipeline,
  slotOnlyRelationEdges,
  summarizeTeamDecision,
} from "./analyst-team-pipeline";
import {
  pauseForTeamOrchestratorHitl,
  pauseForUserInterrupt,
  type HitlApprovalPayload,
} from "../workflow/hitl-service";
import { consumeInterrupt } from "../workflow/workflow-interrupt";
import { pickAnalystReactDepth } from "./analyst-team-slot-react";
import { buildGroupRoleConstraintHint } from "./group-constraint-hint";
import {
  buildAuxSlotDispatchSpec,
  buildTeamSlotDispatchSpecs,
  createTeamSlotExecutor,
  DEFAULT_TEAM_SLOT_TIMEOUT_MS,
  dispatchAuxSlotMarkdown,
  mapDispatchResultsToWaveResults,
  resolveTeamSlotTransport,
} from "./team-slot-executor";
import { spawnTeamSlotRuntimes, type TeamSlotScope } from "./team-slot-a2a";

/**
 * A2A 团队 slot 派单的 gather 超时兜底（仅防「某 slot 彻底卡死」；正常 deep ReAct
 * 单 slot 实测约 1-3 分钟，留足余量）。进程内老路径无此超时，故设得很宽以免误伤。
 */
const TEAM_SLOT_A2A_TIMEOUT_MS = DEFAULT_TEAM_SLOT_TIMEOUT_MS;

/**
 * v2：把用户在 HITL 卡片提交的 response 拼成给下游分析师的上下文片段。
 * - approve_only / null → 空串
 * - single_choice → "用户选择了：{label or value}"
 * - multi_choice → "用户勾选了：{labels[]}"
 * - free_form → "用户给出指引：{text}"
 */
function formatHitlResponseForContext(approval: HitlApprovalPayload | null): string {
  if (!approval || approval.decision !== "approved" || !approval.response) return "";
  const r = approval.response;
  if (typeof r.text === "string" && r.text.trim()) {
    return `\n\n## 用户在审批环节追加指引\n${r.text.trim().slice(0, 1000)}`;
  }
  if (Array.isArray(r.values) && r.values.length > 0) {
    return `\n\n## 用户在审批环节勾选\n${r.values.map(String).join("、")}`;
  }
  if (typeof r.value === "string") {
    return `\n\n## 用户在审批环节选择\n${r.value}`;
  }
  return "";
}

async function enrichAnalystSlotsWithFsi(
  db: Awaited<ReturnType<typeof getDb>>,
  slots: AnalystSlot[]
): Promise<AnalystSlot[]> {
  if (slots.length === 0) return slots;
  const ids = [...new Set(slots.map((s) => s.definitionId))];
  const defs =
    ids.length > 0
      ? await db
          .select({ id: agentDefinition.id, skillsJson: agentDefinition.skillsJson })
          .from(agentDefinition)
          .where(inArray(agentDefinition.id, ids))
      : [];
  const skillsByDef = new Map(defs.map((d) => [d.id, (d.skillsJson as string[]) ?? []]));
  return Promise.all(
    slots.map(async (slot) => ({
      ...slot,
      systemPrompt: await enrichSystemPromptWithFsi({
        role: slot.role,
        basePrompt: slot.systemPrompt,
        declaredSkillIds: skillsByDef.get(slot.definitionId) ?? [],
      }),
    }))
  );
}

async function enrichAnalystSlotsWithPack(
  db: Awaited<ReturnType<typeof getDb>>,
  slots: AnalystSlot[]
): Promise<AnalystSlot[]> {
  if (slots.length === 0) return slots;
  const ids = [...new Set(slots.map((s) => s.definitionId))];
  const profRows =
    ids.length > 0
      ? await db.select().from(agentProfile).where(inArray(agentProfile.definitionId, ids))
      : [];
  const profByDef = new Map(profRows.map((p) => [p.definitionId, p]));
  return Promise.all(
    slots.map(async (slot) => {
      const prof = profByDef.get(slot.definitionId);
      const read = await readPackFiles({
        dataDir: getDataDir(),
        definitionId: slot.definitionId,
        configRootUri: prof?.configRootUri ?? "",
        soulFileRef: prof?.soulFileRef ?? "",
        promptTemplateRef: prof?.promptTemplateRef,
      });
      const mode = (prof?.promptMode as PromptMode | undefined) ?? "db_primary";
      return {
        ...slot,
        systemPrompt: mergeSystemPrompt({
          mode,
          dbPrompt: slot.systemPrompt,
          agentText: read.agentText,
          soulText: read.soulText,
          userText: read.userText,
          memoryText: read.memoryText,
          promptText: read.promptText,
        }),
      };
    })
  );
}

export const ANALYST_TEAM_ROLES: AgentRole[] = [
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
];

/**
 * 研究团队画布"可选 slot 角色"白名单——历史上同时承担三种角色：
 *   1) 路由层：限制 user 传入的 analyst_roles 字符串数组（防注入未定义 role）
 *   2) 默认编组路径：当 caller 不传 group_id 时，按 role 名过滤启用 def
 *   3) 编组 path 内的 second-level filter（**migration 0073 后已删除**）
 *
 * Phase B (2026-06)：dispatch 决策不再读这个 set——改为读 def.outputs 走
 * capability-driven 分桶（见下方 `slotProducesSignal` / `slotIsAuxReporter`）。
 * 这个 set 仅留作 "vocabulary 白名单" 兜底，新加入的角色（如 backtest_engineer）
 * 必须在这里登记才能被前端 / 路由接受。
 */
export const RESEARCH_TEAM_SLOT_ROLES: readonly AgentRole[] = [
  "market_data",
  "news_event",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
  "research",
  "backtest",
  /** P0-01 修复：walk-forward 验证师属于 discovery 编组成员，须能成为合法 slot */
  "backtest_engineer",
  "risk",
] as const;

/** 与 `RESEARCH_TEAM_SLOT_ROLES` 一致，供路由 / 图编排校验 */
export const RESEARCH_TEAM_SLOT_SET = new Set<string>(
  RESEARCH_TEAM_SLOT_ROLES as readonly string[]
);

/**
 * 可加入研究团队编组、可出现在 relations_json 拓扑中的角色（含 orchestrator）。
 * orchestrator 在编组拓扑中作为调度中心：启动时向各槽位写入 kickoff 交互，并出现在对话拓扑中。
 */
export const RESEARCH_TEAM_GROUP_TOPOLOGY_ROLE_SET = new Set<string>([
  ...(RESEARCH_TEAM_SLOT_ROLES as readonly string[]),
  "orchestrator",
]);

/**
 * @deprecated Phase B (2026-06) 起 dispatch 路径不再调用本函数——改用
 * `slotProducesSignal()` 走 def.outputs（migration 0073）。保留导出仅为兼容
 * 第三方代码 / 旧测试；新代码请勿继续使用。
 */
export function isMsAnalystRole(role: AgentRole): boolean {
  return (ANALYST_TEAM_ROLES as readonly string[]).includes(role);
}

/**
 * Capability-driven slot 分桶（migration 0073 配套，取代 `isMsAnalystRole`）。
 *
 * 优先看 def.outputs 是否声明 'signal'；只有声明了 signal 才进 MSA 投票
 * wave。outputs 为空（旧 def / 第三方）回退到 role-name 老判断保持兼容。
 *
 * 例子：
 *   - analyst_fundamental.outputs=['signal','report']  → true (进 MSA)
 *   - analyst_sentiment.outputs=['signal','report']    → true
 *   - news_event.outputs=['events','report']           → false (走 aux pipeline)
 *   - backtest_engineer.outputs=['backtest_results','report'] → false
 *   - research.outputs=['report','factor_candidates']  → false
 */
export function slotProducesSignal(slot: {
  role: AgentRole;
  outputs: readonly AgentOutput[];
}): boolean {
  if (slot.outputs.length > 0) return slot.outputs.includes("signal");
  return isMsAnalystRole(slot.role);
}

/**
 * Capability-driven aux 分桶（取代 `POST_FUSION_AUX_ROLES.has`）。
 *
 * "产任意非 signal 产物的 slot" → 走 post-fusion 串行 pipeline。
 *   - news_event (events+report)        → aux
 *   - backtest_engineer (backtest+report) → aux
 *   - research/backtest/risk (report+...) → aux
 *   - market_data (report)              → aux
 *   - analyst_* (signal+report)         → 不进 aux（已在 MSA wave）
 *
 * outputs 为空时回退到老 set。
 */
export function slotIsAuxReporter(slot: {
  role: AgentRole;
  outputs: readonly AgentOutput[];
}): boolean {
  if (slot.outputs.length === 0) return POST_FUSION_AUX_ROLES.has(slot.role);
  if (slot.outputs.includes("signal")) return false;
  return slot.outputs.length > 0;
}

export interface AnalystTeamResult {
  fusionId: string;
  ticker: string;
  /** 多标的/板块时的结构化范围（可选） */
  scope?: NormalizedResearchScope;
  /** 篮子模式下各标的子结果 */
  perSymbol?: Array<{ symbol: string; result: Omit<AnalystTeamResult, "perSymbol" | "scope"> }>;
  fusedSignal: AnalystSignalValue;
  fusedConfidence: number;
  debateTriggered: boolean;
  breakdown: Array<{
    role: AgentRole;
    signal: AnalystSignalValue;
    confidence: number;
    reasoning: string;
  }>;
  report: string;
  /**
   * 2026-06：MSA 融合后的核心报告文本（即原 `reportCore`，含分析师 breakdown 与可选辅助章节）。
   * 暴露给 Orchestrator Agent，使其在 ReAct loop 中可按需把它传给 builtin tool
   * `summarize_team_decision` 做"全局兜底总结"——这取代了老路径在 `runAnalystTeam` 内部
   * 强制跑一次裸 LLM 调用的设计。
   */
  fusionSummary: string;
  /** 实际产出合法 signal 的分析师角色，用于 summarize_team_decision 工具的硬约束 prompt */
  attendedRoles?: AgentRole[];
  /** 签到失败 / 未产出 signal 的分析师角色 */
  missingRoles?: AgentRole[];
  debate?: {
    sessionId: string;
    consensusScore: number;
    finalStance: "bull" | "bear" | "hold" | "abort";
    verdict: "agree_bull" | "agree_bear" | "no_consensus";
    reasoning: string;
  };
  risk?: {
    approved: boolean;
    vetoed: boolean;
    riskScore: number;
    reason: string;
    severity: "warning" | "block" | "critical";
    rulesTriggered: string[];
  };
}

/**
 * Slot 槽位元数据（Phase B：附带 def.outputs，dispatch 路径据此分桶）。
 * orchestrator 不进 slot 序列；其余成员一律由 dispatcher 按 outputs 桶化决定路径。
 */
type AnalystSlot = {
  role: AgentRole;
  definitionId: string;
  systemPrompt: string;
  outputs: readonly AgentOutput[];
};

function readSlotOutputs(raw: unknown): readonly AgentOutput[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is AgentOutput => typeof x === "string");
}

async function resolveAnalystSlots(params: {
  db: Awaited<ReturnType<typeof getDb>>;
}): Promise<AnalystSlot[]> {
  const { db } = params;
  const dbDefs = await db.select().from(agentDefinition).where(eq(agentDefinition.enabled, true));
  const slotDefs = dbDefs.filter((d) => RESEARCH_TEAM_SLOT_SET.has(d.role as string));
  const definitionIdByRole: Partial<Record<AgentRole, string>> = {};
  const outputsByRole: Partial<Record<AgentRole, readonly AgentOutput[]>> = {};
  for (const def of slotDefs) {
    const r = def.role as AgentRole;
    if (!definitionIdByRole[r]) {
      definitionIdByRole[r] = def.id;
      outputsByRole[r] = readSlotOutputs(def.outputsJson);
    }
  }

  const prompts: Record<AgentRole, string> = {
    analyst_fundamental:
      "你是基本面研究员，分析估值/成长/财务健康度/行业地位，输出JSON：{signal,confidence,reasoning,key_drivers,key_risks}",
    analyst_technical:
      "你是量化策略师，分析趋势/动量/量价/形态，输出JSON：{signal,confidence,reasoning,entry_zone,stop_loss}",
    analyst_sentiment:
      "你是舆情分析师，分析新闻情绪/社媒/分析师评级，输出JSON：{signal,confidence,sentiment_score,reasoning,catalysts,risks}",
    analyst_macro:
      "你是宏观策略师，分析货币政策/经济周期/产业政策/全球联动，输出JSON：{signal,confidence,macro_cycle,policy_stance,reasoning}",
    research:
      "你是策略/研究撰写专家，将观点落实为可验证的策略纲要。输出 Markdown 小节（不要 JSON）。",
    backtest:
      "你是回测工程师，给出可执行的回测假设、数据窗口与评价指标。输出 Markdown（不要 JSON）。",
    backtest_engineer:
      "你是量化工程/实现专家，关注代码结构与可维护性。输出 Markdown（不要 JSON）。",
    risk: "你是风控专员，从规则与敞口角度审视当前结论。输出 Markdown（不要 JSON）。",
    risk_manager: "你是风控经理，综合评估尾部风险与合规边界。输出 Markdown（不要 JSON）。",
    orchestrator: "",
    market_data: "",
    news_event: "",
    simulation: "",
    execution: "",
    memory: "",
    audit: "",
    researcher_bull: "",
    researcher_bear: "",
    portfolio_manager: "",
    stock_screener: "",
    execution_trader: "",
    memory_curator: "",
  };
  for (const def of slotDefs) {
    prompts[def.role as AgentRole] = def.systemPrompt;
  }

  const slots: AnalystSlot[] = [];
  for (const role of RESEARCH_TEAM_SLOT_ROLES) {
    const defId = definitionIdByRole[role];
    if (!defId) continue;
    slots.push({
      role,
      definitionId: defId,
      systemPrompt: prompts[role],
      outputs: outputsByRole[role] ?? [],
    });
  }
  if (slots.length === 0) {
    throw new Error(
      "未在数据库中找到已启用的研究团队槽位定义。请到「配置中心 → Agent」启用 analyst_*、research、backtest、risk* 等角色，或重启后端加载种子。"
    );
  }
  return slots;
}

/**
 * F-P0-02 修复（2026-06）：runDebateSession 的 try/catch 兜底封装。
 *
 * 旧 path 没兜底——LLM 失败（429 / timeout / connector_call_failed）会让异常
 * 直接冒泡，整个 workflow 标 failed；evaluation canvas 写成的 F-P0-02
 * "debate triggered 但 debate_session 表里没行 + workflow failed"就是这个
 * 现象。
 *
 * 软失败策略：
 *   - 成功 → 返回完整 debate 结构
 *   - 失败 → console.warn + 写一条 phase=debate_failed interaction 留痕 +
 *     返回 undefined。downstream risk 评估自动回退到 fusedConfidence-only
 *     判定（veto-engine 处理过 debateConsensusScore=undefined 这条 path）。
 *
 * helper 把 runDebateSession / logResearchTeamInteraction 作为依赖注入，
 * 便于单测 mock。export 以便 __tests__/ 下直接复用。
 */
export async function executeDebateSafely(input: {
  workflowRunId: string;
  ticker: string;
  fusedSignal: AnalystSignalValue;
  fusedConfidence: number;
  analystSummary: string;
  maxRounds: number;
  run: typeof runDebateSession;
  logFailure: typeof logResearchTeamInteraction;
}): Promise<NonNullable<AnalystTeamResult["debate"]> | undefined> {
  try {
    const d = await input.run({
      workflowRunId: input.workflowRunId,
      ticker: input.ticker,
      fusedSignal: input.fusedSignal,
      fusedConfidence: input.fusedConfidence,
      analystSummary: input.analystSummary,
      maxRounds: input.maxRounds,
    });
    return {
      sessionId: d.debateSessionId,
      consensusScore: d.consensusScore,
      finalStance: d.finalStance,
      verdict: d.verdict,
      reasoning: d.reasoning,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[analyst-team] debate session failed for ${input.ticker} (workflow=${input.workflowRunId}): ${msg}; ` +
        `continuing without consensus (risk evaluation will fall back to confidence-only).`
    );
    await input.logFailure({
      workflowRunId: input.workflowRunId,
      fromRole: "orchestrator",
      toRole: "__team__",
      kind: "llm_message",
      contentText: `Bull/Bear 辩论会话执行失败：${msg.slice(0, 800)}。已跳过共识评估，继续走 risk + 最终报告。`,
      payloadJson: {
        phase: "debate_failed",
        ticker: input.ticker,
        fusedSignal: input.fusedSignal,
        fusedConfidence: input.fusedConfidence,
        errorMessage: msg.slice(0, 1200),
      },
    });
    return undefined;
  }
}

function mergeMultiSymbolAnalystResults(
  scope: NormalizedResearchScope,
  results: AnalystTeamResult[]
): AnalystTeamResult {
  if (results.length === 0) {
    throw new Error("mergeMultiSymbolAnalystResults: empty results");
  }
  if (results.length === 1) {
    return {
      ...results[0],
      scope,
      perSymbol: [{ symbol: results[0].ticker, result: stripScopeFields(results[0]) }],
    };
  }

  const buy = results.filter((r) => r.fusedSignal === "buy").length;
  const sell = results.filter((r) => r.fusedSignal === "sell").length;
  let fusedSignal: AnalystSignalValue = "hold";
  if (buy > sell && buy > results.length / 2) fusedSignal = "buy";
  else if (sell > buy && sell > results.length / 2) fusedSignal = "sell";

  const fusedConfidence =
    Math.round((results.reduce((a, r) => a + r.fusedConfidence, 0) / results.length) * 100) / 100;

  const report = [
    `# 多标的研究报告`,
    ``,
    `**范围**：${scope.displayLabel}`,
    `**标的数**：${results.length}`,
    `**组合倾向**：${fusedSignal.toUpperCase()}（各标的信号均值置信度 ${(fusedConfidence * 100).toFixed(0)}%）`,
    ``,
    ...results.map(
      (r) =>
        `### ${r.ticker}\n\n**${r.fusedSignal.toUpperCase()}**（${(r.fusedConfidence * 100).toFixed(0)}%）\n\n${r.report.split("\n").slice(2).join("\n").slice(0, 4000)}`
    ),
  ].join("\n\n");

  return {
    fusionId: results.map((r) => r.fusionId).join(","),
    ticker: scope.displayLabel,
    scope,
    perSymbol: results.map((r) => ({ symbol: r.ticker, result: stripScopeFields(r) })),
    fusedSignal,
    fusedConfidence,
    debateTriggered: results.some((r) => r.debateTriggered),
    breakdown: results.flatMap((r) =>
      r.breakdown.map((b) => ({
        ...b,
        reasoning: `[${r.ticker}] ${b.reasoning}`,
      }))
    ),
    report,
    debate: results.find((r) => r.debate)?.debate,
    risk: results.find((r) => r.risk)?.risk,
  };
}

function stripScopeFields(r: AnalystTeamResult): Omit<AnalystTeamResult, "perSymbol" | "scope"> {
  const { perSymbol: _p, scope: _s, ...rest } = r;
  return rest;
}

/**
 * 主入口：并行运行 Analyst Agent（按当前启用专家；可选 role/definition 子集），收集信号，执行 MSA 融合
 */
export async function runAnalystTeam(params: {
  workflowRunId: string;
  /** 兼容：单标的代码；多标的请用 scope.symbols 或逗号分隔 */
  ticker?: string;
  scope?: ResearchScopeInput | null;
  context?: string;
  analystRoles?: AgentRole[] | null;
  analystDefinitionIds?: string[] | null;
  runId?: string;
  traceId?: string;
  hitlApproval?: import("../workflow/hitl-service").HitlApprovalPayload | null;
}): Promise<AnalystTeamResult> {
  const scope = resolveResearchScope({ ticker: params.ticker, scope: params.scope });

  if (scope.symbols.length > 1 && scope.kind === "basket") {
    const perSymbolResults: AnalystTeamResult[] = [];
    for (const sym of scope.symbols) {
      const sub = await runAnalystTeamCore({ ...params, ticker: sym, scope });
      perSymbolResults.push(sub);
    }
    return mergeMultiSymbolAnalystResults(scope, perSymbolResults);
  }

  return runAnalystTeamCore({ ...params, ticker: scope.primarySymbol, scope });
}

async function runAnalystTeamCore(params: {
  workflowRunId: string;
  ticker: string;
  scope: NormalizedResearchScope;
  context?: string;
  analystRoles?: AgentRole[] | null;
  analystDefinitionIds?: string[] | null;
  runId?: string;
  traceId?: string;
  hitlApproval?: import("../workflow/hitl-service").HitlApprovalPayload | null;
}): Promise<AnalystTeamResult> {
  const db = await getDb();
  const { workflowRunId, ticker, scope } = params;
  const userContext = params.context ?? defaultResearchUserContext(scope);
  const dataContext = await buildAnalystTeamDataContext({ scope });
  let context = [dataContext, userContext].filter((s) => s.trim().length > 0).join("\n\n");
  const orchestratorSlot = await resolveOrchestratorSlot(db);
  let slots = await resolveAnalystSlots({ db });
  if (params.analystDefinitionIds && params.analystDefinitionIds.length > 0) {
    const allowIds = new Set(params.analystDefinitionIds);
    slots = slots.filter((s) => allowIds.has(s.definitionId));
    if (slots.length === 0) {
      throw new Error("所选分析师定义与当前可用分析师槽位无交集。请调整选择的 Agent。");
    }
  } else if (params.analystRoles && params.analystRoles.length > 0) {
    const allow = new Set(params.analystRoles);
    slots = slots.filter((s) => allow.has(s.role));
    if (slots.length === 0) {
      throw new Error("所选参与角色与当前可用分析师定义无交集。请调整参与角色。");
    }
  }

  slots = await enrichAnalystSlotsWithPack(db, slots);
  slots = await enrichAnalystSlotsWithFsi(db, slots);

  /**
   * Phase B：把 agent_group.pipeline_kind 拉出来供 dispatch 决策。
   * - msa_fusion (default)：现行行为（signal contributors → fusion → aux post-fusion）
   * - sequential_research / factor_discovery / event_radar：跳过 MSA，
   *   所有非 signal 角色直接进 aux 串行 pipeline
   *
   * 注意：dispatch 行为仍然主要由 outputs 能力驱动（slotProducesSignal /
   * slotIsAuxReporter）。pipelineKind 只影响"无 signal contributor 时是否
   * 显式标记 strategyPipelineMode"——这决定了 fusion 是否写 placeholder /
   * 报告头是否显示"未运行 MSA"。
   */
  let relationEdges: TeamRelationEdge[] = [];
  let pipelineKind: AgentGroupPipelineKind = "msa_fusion";
  const groupDescription: string | null = null;

  let analystSlots = slots.filter((s) => slotProducesSignal(s));
  const explicitAnalystSelection =
    (params.analystDefinitionIds?.length ?? 0) > 0 || (params.analystRoles?.length ?? 0) > 0;
  if (
    !explicitAnalystSelection &&
    process.env["QUBIT_ADAPTIVE_TEAM_FANOUT_DISABLED"] !== "1" &&
    analystSlots.length > 2
  ) {
    const query = `${scope.displayLabel} ${userContext}`.toLowerCase();
    const roleHints: Partial<Record<AgentRole, string[]>> = {
      analyst_technical: ["技术", "趋势", "动量", "k线", "因子", "策略", "回测"],
      analyst_fundamental: ["基本面", "财报", "估值", "盈利", "行业", "公司"],
      analyst_sentiment: ["新闻", "事件", "舆情", "情绪", "催化"],
      analyst_macro: ["宏观", "政策", "利率", "周期", "汇率", "通胀"],
    };
    analystSlots = analystSlots
      .map((slot, index) => ({
        slot,
        index,
        score: (roleHints[slot.role] ?? []).reduce(
          (score, hint) => score + (query.includes(hint) ? 1 : 0),
          0
        ),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 2)
      .map((item) => item.slot);
  }
  const auxSlots = slots.filter((s) => slotIsAuxReporter(s));
  /**
   * strategyPipelineMode：跳过 MSA 共识评估、跳过辩论触发条件、跳过 placeholder
   * 信号写入。判定条件（Phase B：纯 declarative）：
   *   1) group.pipeline_kind 显式非 msa_fusion；或
   *   2) 编组里没有任何 signal 产出者，但有 aux 产出者（自动适配 P2-D 推荐
   *      路径下的策略专岗 / discovery / postmortem 等场景）。
   */
  const strategyPipelineMode =
    pipelineKind !== "msa_fusion" || (analystSlots.length === 0 && auxSlots.length > 0);
  const slotRoleSet = new Set(slots.map((s) => s.role));

  await logOrchestratorKickoff({
    workflowRunId,
    ticker,
    slotRoles: slots.map((s) => s.role),
    relationEdges,
  });

  if (orchestratorSlot) {
    const planResult = await runOrchestratorPlanning({
      workflowRunId,
      ticker: scope.displayLabel,
      slotRoles: slots.map((s) => s.role),
      dataAndUserContext: context,
      orchestrator: orchestratorSlot,
    });
    await pauseForTeamOrchestratorHitl({
      workflowRunId,
      runId: params.runId ?? workflowRunId,
      traceId: params.traceId ?? workflowRunId,
      ticker: scope.displayLabel,
      planBrief: planResult.brief,
      slotRoles: slots.map((s) => s.role),
      symbols: Array.isArray(scope.symbols) ? scope.symbols : [scope.displayLabel],
      hitlHint: planResult.hitlHint,
      hitlApproval: params.hitlApproval ?? null,
    });
    // v2：若用户在 HITL 中填了 response（single_choice/free_form），注入给后续分析师上下文。
    const respText = formatHitlResponseForContext(params.hitlApproval ?? null);
    context = `${context}\n\n## Orchestrator 任务简报\n${planResult.brief}${respText}`;

    // 面向用户的进度播报（toRole="user"）：让右栏对话框看到 Orchestrator 在干什么，
    // 而不只是 A2A 派单。这些 toRole=user 的消息在前端默认「只看 Orchestrator」视图里可见。
    await logResearchTeamInteraction({
      workflowRunId,
      fromRole: "orchestrator",
      toRole: "user",
      kind: "llm_message",
      contentText:
        `📋 研究规划已就绪。我会协调 ${analystSlots.length} 位分析师并行展开` +
        `（${analystSlots.map((s) => s.role).join("、")}）。\n\n**规划要点**\n${planResult.brief.slice(0, 700)}`,
    });
  }

  /**
   * Phase B：拓扑边只保留 signal 产出者之间——非 signal 角色走 aux 串行 pipeline，
   * 不参与 MSA wave 拓扑。原来用 `isMsAnalystRole` 硬编码，现在按 analystSlots
   * 集合判断（capability-driven）。
   */
  const signalRoleSet = new Set(analystSlots.map((s) => s.role));
  let analystEdges = slotOnlyRelationEdges(relationEdges, slotRoleSet);
  analystEdges = analystEdges.filter((e) => signalRoleSet.has(e.from) && signalRoleSet.has(e.to));
  const waveSlots = analystSlots;
  const waves = waveSlots.length > 0 ? partitionSlotsIntoWaves(waveSlots, analystEdges) : [];

  const instanceBySlotIndex: string[] = [];
  for (let i = 0; i < waveSlots.length; i++) {
    const instanceId = randomUUID();
    instanceBySlotIndex[i] = instanceId;
    await db.insert(agentInstance).values({
      id: instanceId,
      definitionId: waveSlots[i].definitionId,
      workflowRunId,
      status: "running",
      currentIteration: 0,
      startedAt: new Date().toISOString(),
    });
  }

  /**
   * 团队 slot 传输路径决策（默认 A2A）。需 A2A pool 已启动以拿到 orchestrator 实例
   * 作为派单 sender；拿不到（脱离 pool 的单测 / 脚本）则回退进程内执行，行为与历史一致。
   */
  const { useA2a, orchestratorInstanceId } = resolveTeamSlotTransport({
    slotCount: waveSlots.length,
  });
  const useTeamA2a = useA2a && orchestratorInstanceId !== null;
  const teamSlotExecutor = createTeamSlotExecutor({
    workflowRunId,
    traceId: params.traceId ?? workflowRunId,
    useA2a: useTeamA2a,
    orchestratorInstanceId,
    timeoutMs: TEAM_SLOT_A2A_TIMEOUT_MS,
  });
  let teamSlotScope: TeamSlotScope | null = null;
  if (useTeamA2a && orchestratorInstanceId) {
    teamSlotScope = await spawnTeamSlotRuntimes(
      waveSlots.map((s, i) => ({
        instanceId: instanceBySlotIndex[i] as string,
        definitionId: s.definitionId,
        role: s.role,
      }))
    );
    console.log(
      `[analyst-team] workflow=${workflowRunId} team transport=A2A (${waveSlots.length} analyst slot runtimes spawned)`
    );
  } else if (useA2a && waveSlots.length > 0) {
    console.warn(
      `[analyst-team] workflow=${workflowRunId} teamExecutionPath=a2a but A2A pool orchestrator unavailable; falling back to in-process slot execution.`
    );
  }

  type SlotRow = (typeof slots)[number];
  const outputByRole = new Map<AgentRole, RawAnalystSignal>();
  const auxDigestByRole = new Map<AgentRole, string>();
  let auxSections: Array<{ role: AgentRole; body: string }> = [];

  const rawSignals: RawAnalystSignal[] = [];
  const persistSignals: Array<{ agentInstanceId?: string; signal: RawAnalystSignal }> = [];

  const predsByTo = new Map<AgentRole, AgentRole[]>();
  for (const e of analystEdges) {
    const arr = predsByTo.get(e.to) ?? [];
    arr.push(e.from);
    predsByTo.set(e.to, arr);
  }

  /** 单 slot ReAct 结果（TeamSlotExecutor 两条传输路径共用）。 */

  let waveNo = 0;
  try {
    for (const wave of waves) {
      waveNo += 1;
      // 用户发起的协作式中断：在每个 wave 边界（无 slot 在飞的安全点）检查。命中则起一个
      // free_form team_orchestrator HITL 停在断点，等用户输入新提示词后走既有恢复链续跑。
      if (consumeInterrupt(workflowRunId)) {
        await pauseForUserInterrupt({
          workflowRunId,
          runId: params.runId ?? workflowRunId,
          traceId: params.traceId ?? workflowRunId,
          ticker: scope.displayLabel,
        });
      }
      // 面向用户的进度播报：当前组分析师开跑（coding-agent 式 play-by-play）。
      await logResearchTeamInteraction({
        workflowRunId,
        fromRole: "orchestrator",
        toRole: "user",
        kind: "llm_message",
        contentText: `🔬 第 ${waveNo}/${waves.length} 组分析进行中：${wave.map((s) => s.role).join("、")}…`,
      });
      /**
       * 先为每个 slot 拼好「前置成员结论 appendix」上下文并记录拓扑 handoff——这两件事
       * A2A 路径与进程内路径完全一致，故抽到派发之前统一做（保留 research_team_interaction
       * 的画布连线）。
       */
      const waveSpecs = await Promise.all(
        wave.map(async (slot) => {
          const predChain = (predsByTo.get(slot.role) ?? []).filter(
            (pr) => outputByRole.has(pr) || auxDigestByRole.has(pr)
          );
          const appendix =
            predChain.length > 0
              ? `\n\n### 前置成员结论（编组通信拓扑）\n${predChain
                  .map((pr) => {
                    const o = outputByRole.get(pr);
                    if (o) {
                      // Tier1+2：上游结论从 600 字放开到 1500，并附结构化关键驱动/风险，下游分析师不再"管中窥豹"。
                      const struct = formatStructuredFields(o.structured, { maxArr: 5 });
                      const structLine = struct.length > 0 ? `\n  ${struct.join("\n  ")}` : "";
                      return `- **${pr}**（信号）：${o.signal}（置信度 ${(o.confidence * 100).toFixed(0)}%）\n  ${String(o.reasoning).slice(0, 1500)}${structLine}`;
                    }
                    const md = auxDigestByRole.get(pr);
                    if (md) return `- **${pr}**（辅助）：\n  ${md.slice(0, 1200)}`;
                    return "";
                  })
                  .filter((line) => line.length > 0)
                  .join("\n")}\n`
              : "";
          const ctx = `${context}${appendix}`;
          for (const pr of predChain) {
            await logResearchTeamInteraction({
              workflowRunId,
              fromRole: pr,
              toRole: slot.role,
              kind: "llm_message",
              contentText: `[topology handoff] ${pr} → ${slot.role}：将前置结论文本传入本轮推理上下文`,
              payloadJson: { topology: true, ticker },
            });
          }
          const slotIdx = waveSlots.findIndex((s) => s.role === slot.role);
          const preInstanceId = slotIdx >= 0 ? instanceBySlotIndex[slotIdx] : undefined;
          return { slot, ctx, preInstanceId };
        })
      );

      const reactDepth = pickAnalystReactDepth({ pipelineKind, expectJsonSignal: true });

      /**
       * TeamSlotExecutor 统一 wave 派发（A2A / inprocess 仅 transport 不同）。
       */
      const dispatchSpecs = buildTeamSlotDispatchSpecs({
        workflowRunId,
        ticker,
        scope,
        reactDepth,
        waveSpecs: waveSpecs.map((ws) => ({
          slot: ws.slot,
          ctx: ws.ctx,
          ...(ws.preInstanceId !== undefined ? { preInstanceId: ws.preInstanceId } : {}),
          groupConstraintHint: buildGroupRoleConstraintHint({
            groupId: null,
            role: ws.slot.role,
            groupDescription,
          }),
        })),
      });
      const dispatchResults = await teamSlotExecutor.dispatchWave(dispatchSpecs);
      const waveResults = mapDispatchResultsToWaveResults(dispatchSpecs, dispatchResults);

      for (let wi = 0; wi < wave.length; wi++) {
        const slot = wave[wi] as SlotRow;
        const idx = waveSlots.findIndex((s) => s.role === slot.role);
        const instanceId = idx >= 0 ? instanceBySlotIndex[idx] : undefined;
        const result = waveResults[wi];
        if (!result) continue;
        if (result.status === "fulfilled" && result.value.kind === "analyst") {
          const { agentInstanceId: reactInstId, ...signal } = result.value.payload;
          outputByRole.set(slot.role, signal);
          rawSignals.push(signal);
          const persistInstanceId = reactInstId ?? instanceId;
          persistSignals.push({
            signal,
            ...(persistInstanceId !== undefined ? { agentInstanceId: persistInstanceId } : {}),
          });
          // 解析交接信封（thesis/metrics/data_refs/handoffs…）落 payloadJson.handoff，供下游程序化消费。
          const analystHandoff =
            parseHandoffEnvelope(signal.structured ?? null) ??
            parseHandoffEnvelope(
              typeof (signal.dataSnapshot as Record<string, unknown> | undefined)?.rawResponse ===
                "string"
                ? ((signal.dataSnapshot as Record<string, unknown>).rawResponse as string)
                : null
            );
          await logResearchTeamInteraction({
            workflowRunId,
            fromRole: slot.role,
            toRole: "orchestrator",
            kind: "llm_message",
            contentText: `[${signal.signal}] ${(signal.confidence * 100).toFixed(0)}% — ${signal.reasoning.slice(0, 3500)}`,
            payloadJson: {
              phase: "analyst_report",
              ticker,
              ...(analystHandoff ? { handoff: analystHandoff } : {}),
            },
          });
          // coding-agent 式即时点评：每个分析师一回来，Orchestrator 对用户说一句（toRole=user）。
          {
            const conf = Math.round(signal.confidence * 100);
            const tone =
              signal.signal === "buy" ? "偏多" : signal.signal === "sell" ? "偏空" : "中性";
            const gist = signal.reasoning.trim().split("\n")[0]?.slice(0, 80) ?? "";
            await logResearchTeamInteraction({
              workflowRunId,
              fromRole: "orchestrator",
              toRole: "user",
              kind: "llm_message",
              contentText: `🗒️ ${slot.role} 已返回：${signal.signal.toUpperCase()}（${conf}%，${tone}）${gist ? ` — ${gist}…` : ""}`,
              payloadJson: { phase: "analyst_reaction", role: slot.role },
            });
          }
        } else if (
          result.status === "fulfilled" &&
          result.value.kind === "missing_signal" &&
          slotProducesSignal(slot)
        ) {
          /**
           * Analyst slot 跑完但 LLM 输出无法解析为合法 JSON 信号。
           * 不再塌缩 hold@0.4 —— 改为不向 fusion 提供假信号，但记录互动事件
           * 让前端 / 用户能看到"X 分析师没产出有效信号"。下游 fusion 会因为
           * 信号数变少而触发更高优先级的辩论 / 数据补充。
           */
          await logResearchTeamInteraction({
            workflowRunId,
            fromRole: slot.role,
            toRole: "orchestrator",
            kind: "llm_message",
            contentText: `[signal_parse_failed] ${result.value.body.slice(0, 3500)}`,
            payloadJson: { phase: "analyst_report", ticker, missingSignal: true },
          });
          await logResearchTeamInteraction({
            workflowRunId,
            fromRole: "orchestrator",
            toRole: "user",
            kind: "llm_message",
            contentText: `⚠️ ${slot.role} 本轮未给出有效信号，融合时我会降低它的权重。`,
            payloadJson: { phase: "analyst_reaction", role: slot.role, missingSignal: true },
          });
        } else if (result.status === "rejected" && slotProducesSignal(slot)) {
          /**
           * Slot 整体抛错（异常路径）：保留 fallback 信号但 confidence=0，
           * 让 fusion 加权时这个信号无投票力，同时在 reasoning 里记录原因。
           * 不再使用 0.2 这种"看似有效但实际只是兜底"的置信度。
           */
          const fallback: RawAnalystSignal = {
            definitionId: slot.definitionId,
            analystRole: slot.role,
            ticker,
            signal: "hold",
            confidence: 0,
            reasoning: `[slot_runtime_error] Analyst ${slot.role} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason).slice(0, 400)}`,
          };
          outputByRole.set(slot.role, fallback);
          rawSignals.push(fallback);
          persistSignals.push({ agentInstanceId: instanceId, signal: fallback });
          await logResearchTeamInteraction({
            workflowRunId,
            fromRole: slot.role,
            toRole: "orchestrator",
            kind: "llm_message",
            contentText: `[slot_runtime_error] ${fallback.reasoning.slice(0, 3500)}`,
            payloadJson: { phase: "analyst_report", ticker, slotError: true },
          });
          await logResearchTeamInteraction({
            workflowRunId,
            fromRole: "orchestrator",
            toRole: "user",
            kind: "llm_message",
            contentText: `⚠️ ${slot.role} 执行出错，本轮不计入。`,
            payloadJson: { phase: "analyst_reaction", role: slot.role, slotError: true },
          });
        }

        if (instanceId) {
          await db
            .update(agentInstance)
            .set({ status: "stopped", endedAt: new Date().toISOString() })
            .where(eq(agentInstance.id, instanceId));
        }
      }
    }
  } finally {
    // 团队跑完 / 中途 HITL pause throw / 异常——都要停掉临时 analyst runtime（解订阅）。
    if (teamSlotScope) await teamSlotScope.stopAll();
  }

  /** 融合顺序与 slots 声明顺序一致（便于对照 UI） */
  const orderKey = new Map(slots.map((s, i) => [s.role, i] as const));
  rawSignals.sort(
    (a, b) =>
      (orderKey.get(a.analystRole as AgentRole) ?? 0) -
      (orderKey.get(b.analystRole as AgentRole) ?? 0)
  );
  persistSignals.sort(
    (a, b) =>
      (orderKey.get(a.signal.analystRole as AgentRole) ?? 0) -
      (orderKey.get(b.signal.analystRole as AgentRole) ?? 0)
  );

  /**
   * Run MSA fusion（仅 analyst_* 信号；无信号时由 tickerHint 生成占位融合）。
   *
   * P2b：策略专岗编组没有 analyst_* 角色，rawSignals 必为空。这种场景下
   * 强行写一条 `hold@25%, debateTriggered=true` 到 signal_fusion_result 是
   * 垃圾数据 —— 通过 skipPlaceholderForNoSignals 告知 fuseSignals 跳过 db 写入，
   * 同时返回 `noAnalystSignals: true` 让下游识别"未跑共识"。
   */
  const fusionResult = await fuseSignals({
    workflowRunId,
    signals: rawSignals,
    persistSignals,
    tickerHint: ticker,
    skipPlaceholderForNoSignals: strategyPipelineMode && rawSignals.length === 0,
  });

  for (const { signal } of persistSignals) {
    await logResearchTeamInteraction({
      workflowRunId,
      fromRole: String(signal.analystRole),
      toRole: "msa",
      kind: "llm_message",
      contentText: `[${signal.signal}] ${(signal.confidence * 100).toFixed(0)}% — ${signal.reasoning.slice(0, 4000)}`,
      payloadJson: { ticker, signal: signal.signal, confidence: signal.confidence },
    });
  }

  // 面向用户的进度播报：多信号融合完成（toRole="user"）。
  await logResearchTeamInteraction({
    workflowRunId,
    fromRole: "orchestrator",
    toRole: "user",
    kind: "llm_message",
    contentText:
      `✅ 已汇总 ${rawSignals.length} 位分析师的信号并完成多信号融合（MSA）。\n\n` +
      `**综合结论**：${String(fusionResult.fusedSignal).toUpperCase()}` +
      `（置信度 ${(fusionResult.fusedConfidence * 100).toFixed(0)}%）。` +
      `${fusionResult.noAnalystSignals === true ? "（注：本轮无有效分析师信号，结论仅供参考）" : ""}`,
    payloadJson: {
      ticker,
      fusedSignal: fusionResult.fusedSignal,
      fusedConfidence: fusionResult.fusedConfidence,
    },
  });

  let reportCore = buildTeamReport(
    ticker,
    fusionResult.fusedSignal,
    fusionResult.fusedConfidence,
    fusionResult.signalBreakdown,
    fusionResult.noAnalystSignals === true
  );

  let orchestratorDecision = null;
  if (strategyPipelineMode && auxSlots.length > 0) {
    /**
     * 策略专岗编组没有 MSA 分析师 → signalBreakdown 必然为空 / 仅 1 条。
     *
     * P2b：之前这个分支强行把 confidence 抬到 0.55、reasoning 还说"建议粘贴
     * 全分析师/MSA 报告"，结果数据库里就出现假的 "Orchestrator 决策 HOLD@55%"
     * 假信号 + 误导用户去找根本不存在的 MSA 报告。
     *
     * 现在显式表达"未运行 MSA"：reasoning 去掉对 MSA 报告的依赖，confidence
     * 保留中性 0.55（避免触发下游 risk LOW_CONFIDENCE_BLOCK，但绝不假装是高
     * 置信度共识）。配合 buildTeamReport 的 noAnalystSignals 分支，
     * 整份报告里都不再出现"分析师团队结论 HOLD@25%"这种伪造文案。
     */
    orchestratorDecision = {
      signal: fusionResult.fusedSignal,
      confidence: 0.55,
      reasoning:
        "策略专岗编组：本工作流未配置 MSA 分析师角色，跳过共识评估，直接进入 research → backtest → risk 串行 pipeline。",
      proceedToStrategy: true,
      shouldDebate: false,
      debateReason: "策略专岗编组：未配置 MSA 分析师，无对立视角可辩论",
    };
    reportCore += `\n\n### Orchestrator 调度决策\n\n⏭️ **跳过 MSA 共识评估**（${(orchestratorDecision.confidence * 100).toFixed(0)}% 中性置信度，仅作 downstream 风控阈值占位）\n\n${orchestratorDecision.reasoning}`;
    await logResearchTeamInteraction({
      workflowRunId,
      fromRole: "orchestrator",
      toRole: "research",
      kind: "llm_message",
      contentText: "策略专岗编组：跳过 MSA 共识评估，进入策略撰写与回测阶段。",
      payloadJson: {
        phase: "strategy_pipeline_mode",
        msaSkipped: true,
        confidence: 0.55,
      },
    });
  }
  /**
   * 2026-06 架构调整：MSA 之后那次"裸 LLM 决策汇总"被拆成 builtin tool
   * `summarize_team_decision`，由 Orchestrator Agent 在自己的 ReAct loop 中按需调用
   * （典型条件：fusedConfidence < 0.6 / 信号分歧 / missingRoles >= 2）。
   *
   * 收益：
   *   - 节省 1 次 ~2-5s LLM 调用（高置信场景）
   *   - Orchestrator 的所有 LLM 调用统一走 ReAct 路径，不再有 act 节点之外的裸调用
   *   - 兜底逻辑（proceedToStrategy / shouldDebate）天然回落到 decideShouldDebate 的
   *     "orchestratorDecision=null + 阈值"分支，不影响下游
   *
   * 留下的 strategyPipelineMode stub 是**硬编码数据**（无 LLM 调用），保留即可。
   * 历史强制调用 `runOrchestratorDecision` 的逻辑已删除；如需保留报告中"汇总决策"段，
   * 让 Orchestrator 自行在 ReAct 中调工具后用工具结果追加到对话回复即可。
   */

  /**
   * F-P0-08（2026-06-04 eval batch 3 / case 5 explore-fallback 修复）：
   *
   * research_team_execute 短路路径**不进 Orchestrator 的 ReAct loop**，所以
   * `summarize_team_decision` 这个 builtin tool 永远不会被 Orchestrator 主动调到。
   * 结果：当 4 个分析师都返回 hold/0.3 / 0 个签到时，`orchestratorDecision` 一直保持
   * `null`，下游 `runPostFusionPipeline` 的 `if (orch && !orch.proceedToStrategy)`
   * 守门条件因 `orch === null` 短路 false → explore_fallback 分支**永远不进**，
   * 草稿 tab 永远是 0。
   *
   * 兜底：当 orch 还是 null 且 auxSlots 非空时，按"签到事实"主动合成一个决策。
   *
   * 决策矩阵：
   *   - 0 个分析师签到 → 直接生成 hold / confidence≤0.4 / proceedToStrategy=false
   *     （匹配 summarizeTeamDecision prompt 里的硬约束 #2，不必再花一次 ~2-5s LLM 调用）
   *   - 有签到但 fusedConfidence < 0.45 + fusedSignal=hold → 跑一次真正的
   *     summarizeTeamDecision LLM 决策（恢复老 runOrchestratorDecision 行为，
   *     仅在确实"信息不足或观望"时多花这次 LLM 调用）
   *   - 其它情况 → 保持 orch=null，让 decideShouldDebate 走阈值兜底，下游 pipeline
   *     按 sequential_research 跑（不进 fallback，因为信号充分）
   *
   * 这条短路只影响 research_team_execute 路径；Orchestrator 自己跑 ReAct 时仍可显式
   * 调 summarize_team_decision 来覆盖（决策的 reasoning 比这里硬合成的更细）。
   */
  if (auxSlots.length > 0 && orchestratorDecision == null) {
    const attendedNow = fusionResult.signalBreakdown.map((s) => s.role);
    const missingNow = analystSlots.map((s) => s.role).filter((r) => !attendedNow.includes(r));

    if (attendedNow.length === 0) {
      orchestratorDecision = {
        signal: "hold" as const,
        confidence: Math.min(fusionResult.fusedConfidence, 0.4),
        reasoning:
          "本轮无任何分析师产出合法 signal（attended=0）；按签到硬约束自动判定为 hold / 低置信 / 不推进策略，触发 research 角色 explore_fallback 输出候选研究方向草稿。",
        proceedToStrategy: false,
        shouldDebate: false,
        debateReason: "0 个分析师签到，无对立视角可辩论",
      };
      await logResearchTeamInteraction({
        workflowRunId,
        fromRole: "orchestrator",
        toRole: "__team__",
        kind: "llm_message",
        contentText:
          "签到事实：0 个分析师产出合法 signal — 短路合成 hold / proceedToStrategy=false，跳过辩论，触发 explore fallback。",
        payloadJson: {
          phase: "team_decision",
          source: "short_circuit_no_signal",
          attendedRoles: attendedNow,
          missingRoles: missingNow,
          decision: {
            signal: orchestratorDecision.signal,
            confidence: orchestratorDecision.confidence,
            proceedToStrategy: orchestratorDecision.proceedToStrategy,
            shouldDebate: orchestratorDecision.shouldDebate,
          },
        },
      });
    } else if (fusionResult.fusedSignal === "hold" && fusionResult.fusedConfidence < 0.45) {
      orchestratorDecision = await summarizeTeamDecision({
        workflowRunId,
        ticker,
        orchestratorSystemPrompt: orchestratorSlot?.systemPrompt ?? "",
        fusionSummary: reportCore,
        msaSignal: fusionResult.fusedSignal,
        msaConfidence: fusionResult.fusedConfidence,
        attendedRoles: attendedNow,
        missingRoles: missingNow,
      });
      await logResearchTeamInteraction({
        workflowRunId,
        fromRole: "orchestrator",
        toRole: "__team__",
        kind: "llm_message",
        contentText: `Orchestrator 决策：${orchestratorDecision.signal} ${(orchestratorDecision.confidence * 100).toFixed(0)}% / proceedToStrategy=${orchestratorDecision.proceedToStrategy} / shouldDebate=${orchestratorDecision.shouldDebate ?? "auto"}。`,
        payloadJson: {
          phase: "team_decision",
          source: "low_confidence_summarize",
          attendedRoles: attendedNow,
          missingRoles: missingNow,
          decision: {
            signal: orchestratorDecision.signal,
            confidence: orchestratorDecision.confidence,
            proceedToStrategy: orchestratorDecision.proceedToStrategy,
            shouldDebate: orchestratorDecision.shouldDebate,
          },
        },
      });
    }
  }

  if (auxSlots.length > 0) {
    /**
     * aux pipeline（research/backtest/risk 等串行后置角色）同样切 A2A：为每个 aux 角色
     * 预建专属实例 + 起临时 runtime，使其也成为总线真实参与方（a2a_message / 拓扑可见）。
     * 行为不变——slot 仍走 runResearchTeamSlotReact（expectJsonSignal=false → markdown）。
     */
    let auxScope: TeamSlotScope | null = null;
    const auxInstanceByRole = new Map<AgentRole, string>();
    if (useTeamA2a && orchestratorInstanceId) {
      for (const s of auxSlots) {
        const instId = randomUUID();
        auxInstanceByRole.set(s.role, instId);
        await db.insert(agentInstance).values({
          id: instId,
          definitionId: s.definitionId,
          workflowRunId,
          status: "running",
          currentIteration: 0,
          startedAt: new Date().toISOString(),
        });
      }
      auxScope = await spawnTeamSlotRuntimes(
        auxSlots.map((s) => ({
          instanceId: auxInstanceByRole.get(s.role) as string,
          definitionId: s.definitionId,
          role: s.role,
        }))
      );
    }
    const auxReactDepth = pickAnalystReactDepth({ pipelineKind, expectJsonSignal: false });
    try {
      const post = await runPostFusionPipeline({
        workflowRunId,
        ticker,
        fusionReport: reportCore,
        fusedSignal: fusionResult.fusedSignal,
        fusedConfidence: fusionResult.fusedConfidence,
        orchestratorDecision,
        relationEdges,
        auxSlots,
        runAuxLlm: async (slot, ctx) => {
          const auxInstanceId = auxInstanceByRole.get(slot.role) ?? randomUUID();
          const spec = buildAuxSlotDispatchSpec({
            workflowRunId,
            instanceId: auxInstanceId,
            definitionId: slot.definitionId,
            role: slot.role,
            systemPrompt: slot.systemPrompt,
            ticker,
            scope,
            context: ctx,
            reactDepth: auxReactDepth,
            groupConstraintHint: buildGroupRoleConstraintHint({
              groupId: null,
              role: slot.role,
              groupDescription,
            }),
          });
          return dispatchAuxSlotMarkdown(teamSlotExecutor, spec);
        },
      });
      auxSections = post.auxSections;
    } finally {
      if (auxScope) {
        await auxScope.stopAll();
        for (const instId of auxInstanceByRole.values()) {
          await db
            .update(agentInstance)
            .set({ status: "stopped", endedAt: new Date().toISOString() })
            .where(eq(agentInstance.id, instId));
        }
      }
    }
  }

  // Build human-readable report + 辅助角色 Markdown 章节（按编组槽位顺序）
  const roleOrder = new Map(slots.map((s, i) => [s.role, i] as const));
  auxSections.sort((a, b) => (roleOrder.get(a.role) ?? 0) - (roleOrder.get(b.role) ?? 0));
  const auxSectionTitle: Partial<Record<AgentRole, string>> = {
    research: "策略撰写（research）",
    backtest: "回测方案（backtest）",
    backtest_engineer: "策略实现（backtest_engineer）",
    risk: "风控视角（risk）",
    risk_manager: "风控经理（risk_manager）",
  };
  let report = reportCore;
  for (const sec of auxSections) {
    const title = auxSectionTitle[sec.role] ?? `研究团队辅助（${sec.role}）`;
    report += `\n\n### ${title}\n\n${sec.body}`;
  }
  let debate: AnalystTeamResult["debate"];
  const debateConfig = await loadDebateConfig();
  /**
   * 是否触发 Bull/Bear 辩论：
   *   - 硬守门 `signalBreakdown.length < 2`：无对手可辩
   *   - Orchestrator 显式表态：优先于阈值
   *   - 兜底：置信度低于阈值才辩
   * 详见 `decideShouldDebate` 注释。无论结果如何都写一条 __team__ 广播留痕，
   * 便于前端拓扑 / 日志解释"为什么辩 / 为什么没辩"。
   */
  const debateDecision = decideShouldDebate({
    fusedConfidence: fusionResult.fusedConfidence,
    signalBreakdownCount: fusionResult.signalBreakdown.length,
    directionalSignalCount: fusionResult.signalBreakdown.filter((item) => item.signal !== "hold")
      .length,
    orchestratorDecision,
    confidenceThreshold: debateConfig.confidenceThreshold,
  });
  const shouldDebate = debateDecision.shouldDebate;
  await logResearchTeamInteraction({
    workflowRunId,
    fromRole: "orchestrator",
    toRole: "__team__",
    kind: "llm_message",
    contentText: shouldDebate
      ? `触发 Bull/Bear 辩论：${debateDecision.reason}`
      : `跳过 Bull/Bear 辩论：${debateDecision.reason}`,
    payloadJson: {
      phase: "debate_decision",
      shouldDebate,
      source: debateDecision.source,
      reason: debateDecision.reason,
      targetRoles: ["researcher_bull", "researcher_bear", "research"],
    },
  });
  if (shouldDebate) {
    // Tier1+2：辩论摘要从 120 字放开到 600 字，并带上结构化的关键驱动/风险，让 Bull/Bear 辩得更实。
    const analystSummary = fusionResult.signalBreakdown
      .map((s) => {
        const struct = formatStructuredFields(s.structured, { maxArr: 4 });
        const structLine = struct.length > 0 ? `\n    ${struct.join("｜")}` : "";
        return `${s.role}: ${s.signal} (${(s.confidence * 100).toFixed(0)}%) ${s.reasoning.slice(0, 600)}${structLine}`;
      })
      .join("\n");
    /**
     * A2A 路径：把 bull/bear 做成总线真实参与方——建专属实例 + 起临时 runtime，注入
     * runTurn 让每回合发言走 TASK_ASSIGN/TASK_RESULT。评分/持久化仍在 runDebateSession 内。
     */
    let debateA2A: DebateA2ASetup | null = null;
    if (useTeamA2a && orchestratorInstanceId) {
      debateA2A = await setupDebateA2A({
        workflowRunId,
        traceId: params.traceId ?? workflowRunId,
        orchestratorInstanceId,
        timeoutMs: TEAM_SLOT_A2A_TIMEOUT_MS,
      });
    }
    try {
      const debateRunTurn = debateA2A?.runTurn;
      const runDebate = debateRunTurn
        ? (di: DebateInput) => runDebateSession(di, { runTurn: debateRunTurn })
        : runDebateSession;
      debate = await executeDebateSafely({
        workflowRunId,
        ticker,
        fusedSignal: fusionResult.fusedSignal,
        fusedConfidence: fusionResult.fusedConfidence,
        analystSummary,
        maxRounds: debateConfig.maxRounds,
        run: runDebate,
        logFailure: logResearchTeamInteraction,
      });
    } finally {
      if (debateA2A) await debateA2A.cleanup();
    }
  }
  const risk = await evaluateRiskAndVeto({
    workflowRunId,
    ticker,
    fusedSignal: fusionResult.fusedSignal,
    fusedConfidence: fusionResult.fusedConfidence,
    debateConsensusScore: debate?.consensusScore,
  });

  /**
   * 2026-06：把 reportCore（融合后的核心报告，未拼 aux 章节）和签到清单暴露给 caller，
   * 让 Orchestrator 在 ReAct loop 中可按需把它们传给 `summarize_team_decision` 工具做
   * 全局兜底总结。注意：`report` 仍是含 aux 章节的完整报告；`fusionSummary` 只到 MSA
   * 融合层为止，避免工具 prompt 被 aux 章节膨胀。
   */
  const attendedRoles = fusionResult.signalBreakdown.map((s) => s.role);
  const allAnalystRoles = analystSlots.map((s) => s.role);
  const missingRoles = allAnalystRoles.filter((r) => !attendedRoles.includes(r));

  // 面向用户的最终交付：Orchestrator 把完整研究结论发给用户（而不只是给子 Agent 派单）。
  // 这是 coding-agent 式"过程里也对用户说话"的收尾——用户在对话框直接拿到结论与建议。
  const riskNote = risk?.vetoed
    ? `\n\n> ⚠️ 风控拦截：${risk.reason ?? ""}`
    : debate
      ? `\n\n> 🗣️ 已经过 Bull/Bear 辩论：${debate.verdict ?? debate.finalStance ?? ""}`
      : "";
  await logResearchTeamInteraction({
    workflowRunId,
    fromRole: "orchestrator",
    toRole: "user",
    kind: "llm_message",
    contentText: `🏁 研究完成，这是我的结论：\n\n${report.slice(0, 6000)}${riskNote}`,
    payloadJson: {
      phase: "final_report",
      fusedSignal: fusionResult.fusedSignal,
      fusedConfidence: fusionResult.fusedConfidence,
      vetoed: risk?.vetoed ?? false,
    },
  });

  return {
    fusionId: fusionResult.fusionId,
    ticker: scope.displayLabel,
    scope,
    fusedSignal: fusionResult.fusedSignal,
    fusedConfidence: fusionResult.fusedConfidence,
    debateTriggered: shouldDebate,
    breakdown: fusionResult.signalBreakdown.map((s) => ({
      role: s.role,
      signal: s.signal,
      confidence: s.confidence,
      reasoning: s.reasoning,
    })),
    report,
    fusionSummary: reportCore,
    attendedRoles,
    missingRoles,
    debate,
    risk,
  };
}

function buildTeamReport(
  ticker: string,
  fusedSignal: AnalystSignalValue,
  fusedConfidence: number,
  breakdown: Array<{
    role: AgentRole;
    signal: AnalystSignalValue;
    confidence: number;
    reasoning: string;
    structured?: Record<string, unknown>;
  }>,
  noAnalystSignals = false
): string {
  const signalEmoji: Record<AnalystSignalValue, string> = {
    buy: "📈",
    sell: "📉",
    hold: "⏸️",
  };
  const roleNames: Partial<Record<AgentRole, string>> = {
    analyst_fundamental: "基本面",
    analyst_technical: "技术面",
    analyst_sentiment: "情绪面",
    analyst_macro: "宏观面",
  };

  /**
   * P2b：策略专岗编组（无 MSA 分析师）专用报告头。
   * 不再骗用户/Agent 说"分析师团队结论 HOLD@25%, 建议辩论"——明示"未跑共识"。
   */
  if (noAnalystSignals) {
    return [
      `## ${ticker} 策略 pipeline 调度报告`,
      ``,
      `**MSA 共识评估**：⏭️ **未运行**（当前 agent group 未配置 analyst_* 角色）`,
      `> 直接进入 research → backtest → risk 串行 pipeline，跳过 Bull/Bear 辩论。`,
      ``,
      `### 各分析师信号`,
      `- _无_（请由 research 角色基于行情数据自主形成假设）`,
    ].join("\n");
  }

  const lines = [
    `## ${ticker} 分析师团队研究报告`,
    ``,
    `**综合结论**：${signalEmoji[fusedSignal]} **${fusedSignal.toUpperCase()}**（置信度：${(fusedConfidence * 100).toFixed(0)}%）`,
    fusedConfidence < 0.55
      ? `⚠️ 置信度不足，建议触发辩论协议（SDP）`
      : `✅ 置信度充分，可进入风控审核`,
    ``,
    `### 各分析师信号`,
  ];

  for (const s of breakdown) {
    const name = roleNames[s.role] ?? s.role;
    lines.push(
      `- **${name}**：${signalEmoji[s.signal]} ${s.signal.toUpperCase()}（${(s.confidence * 100).toFixed(0)}%）`
    );
    // Tier1：论据放开到 1000 字（原 200 字会丢掉大量关键信息）。
    lines.push(`  > ${s.reasoning.slice(0, 1000)}`);
    // Tier2：渲染结构化字段（关键驱动/关键风险/催化剂/入场·止损…），不再丢弃。
    for (const f of formatStructuredFields(s.structured)) lines.push(`  > ${f}`);
  }

  return lines.join("\n");
}

/** 结构化分析师字段（FSI outputSchema）→ 人类可读行；用于报告/辩论/handoff。 */
const STRUCTURED_FIELD_LABELS: Record<string, string> = {
  key_drivers: "关键驱动",
  key_risks: "关键风险",
  catalysts: "催化剂",
  risks: "风险",
  entry_zone: "入场区间",
  stop_loss: "止损",
  target_price: "目标价",
  sentiment_score: "情绪分",
};
function formatStructuredFields(
  structured: Record<string, unknown> | undefined,
  opts?: { maxArr?: number }
): string[] {
  if (!structured) return [];
  const maxArr = opts?.maxArr ?? 6;
  const out: string[] = [];
  for (const [key, label] of Object.entries(STRUCTURED_FIELD_LABELS)) {
    const v = structured[key];
    if (v == null) continue;
    if (Array.isArray(v)) {
      const items = v.filter((x) => typeof x === "string" && x.trim()).slice(0, maxArr);
      if (items.length > 0) out.push(`${label}：${items.join("；")}`);
    } else if (typeof v === "string" || typeof v === "number") {
      const sv = String(v).trim();
      if (sv) out.push(`${label}：${sv}`);
    }
  }
  return out;
}
