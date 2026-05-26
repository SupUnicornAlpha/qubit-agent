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
import {
  agentDefinition,
  agentGroup,
  agentGroupMember,
  agentInstance,
  agentProfile,
  workflowRun,
} from "../../db/sqlite/schema";
import { loadDebateConfig } from "../config/debate-config";
import { fuseSignals, type RawAnalystSignal } from "./signal-fusion";
import {
  resolveResearchScope,
  type NormalizedResearchScope,
  type ResearchScopeInput,
} from "../../types/research-scope";
import { defaultResearchUserContext } from "./analyst-team-scope";
import { runDebateSession } from "../debate/debate-engine";
import { evaluateRiskAndVeto } from "../risk/veto-engine";
import { logResearchTeamInteraction } from "../research-team/interaction-log";
import type { AgentRole, AnalystSignalValue } from "../../types/entities";
import { parseTeamRelations, partitionSlotsIntoWaves, type TeamRelationEdge } from "./analyst-team-topology";
import {
  type PromptMode,
  getDataDir,
  mergeSystemPrompt,
  readPackFiles,
} from "../agent/agent-pack-service";
import { buildAnalystTeamDataContext } from "./analyst-team-context";
import { enrichSystemPromptWithFsi } from "../fsi/fsi-prompt-enricher";
import {
  logOrchestratorKickoff,
  parseGroupRelationsWithOrchestrator,
  POST_FUSION_AUX_ROLES,
  resolveOrchestratorSlot,
  runOrchestratorDecision,
  runOrchestratorPlanning,
  runPostFusionPipeline,
  slotOnlyRelationEdges,
} from "./analyst-team-pipeline";
import {
  pauseForTeamOrchestratorHitl,
  type HitlApprovalPayload,
} from "../workflow/hitl-service";
import { runResearchTeamSlotReact } from "./analyst-team-slot-react";

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
import { STRATEGY_PIPELINE_GROUP } from "../seed-agent-catalog";

async function enrichAnalystSlotsWithFsi(
  db: Awaited<ReturnType<typeof getDb>>,
  slots: Array<{ role: AgentRole; definitionId: string; systemPrompt: string }>
): Promise<Array<{ role: AgentRole; definitionId: string; systemPrompt: string }>> {
  if (slots.length === 0) return slots;
  const ids = [...new Set(slots.map((s) => s.definitionId))];
  const defs =
    ids.length > 0
      ? await db
          .select({ id: agentDefinition.id, skillsJson: agentDefinition.skillsJson })
          .from(agentDefinition)
          .where(inArray(agentDefinition.id, ids))
      : [];
  const skillsByDef = new Map(
    defs.map((d) => [d.id, (d.skillsJson as string[]) ?? []])
  );
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
  slots: Array<{ role: AgentRole; definitionId: string; systemPrompt: string }>
): Promise<Array<{ role: AgentRole; definitionId: string; systemPrompt: string }>> {
  if (slots.length === 0) return slots;
  const ids = [...new Set(slots.map((s) => s.definitionId))];
  const profRows =
    ids.length > 0 ? await db.select().from(agentProfile).where(inArray(agentProfile.definitionId, ids)) : [];
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

/** 研究团队画布可选角色：analyst_* 参与 MSA；其余产出 Markdown 辅助章节 */
export const RESEARCH_TEAM_SLOT_ROLES: readonly AgentRole[] = [
  "market_data",
  "news_event",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
  "research",
  "backtest",
  "risk",
] as const;

/** 与 `RESEARCH_TEAM_SLOT_ROLES` 一致，供路由 / 图编排校验 */
export const RESEARCH_TEAM_SLOT_SET = new Set<string>(RESEARCH_TEAM_SLOT_ROLES as readonly string[]);

/**
 * 可加入研究团队编组、可出现在 relations_json 拓扑中的角色（含 orchestrator）。
 * orchestrator 在编组拓扑中作为调度中心：启动时向各槽位写入 kickoff 交互，并出现在对话拓扑中。
 */
export const RESEARCH_TEAM_GROUP_TOPOLOGY_ROLE_SET = new Set<string>([
  ...(RESEARCH_TEAM_SLOT_ROLES as readonly string[]),
  "orchestrator",
]);

export function isMsAnalystRole(role: AgentRole): boolean {
  return (ANALYST_TEAM_ROLES as readonly string[]).includes(role);
}

/** 策略专岗编组：无 analyst_*，直接进入 research → backtest → risk */
export function isStrategyPipelineGroup(agentGroupId?: string | null): boolean {
  return agentGroupId === STRATEGY_PIPELINE_GROUP.id;
}

function isStrategyFocusedSlots(slots: Array<{ role: AgentRole }>): boolean {
  const hasAnalyst = slots.some((s) => isMsAnalystRole(s.role));
  const hasAux = slots.some((s) => POST_FUSION_AUX_ROLES.has(s.role));
  return hasAux && !hasAnalyst;
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

async function resolveAnalystSlots(params: {
  db: Awaited<ReturnType<typeof getDb>>;
  agentGroupId?: string | null;
}): Promise<Array<{ role: AgentRole; definitionId: string; systemPrompt: string }>> {
  const { db, agentGroupId } = params;
  if (agentGroupId) {
    const rows = await db
      .select({ m: agentGroupMember, d: agentDefinition })
      .from(agentGroupMember)
      .innerJoin(agentDefinition, eq(agentGroupMember.definitionId, agentDefinition.id))
      .where(eq(agentGroupMember.groupId, agentGroupId))
      .orderBy(asc(agentGroupMember.sortOrder));
    const slots: Array<{ role: AgentRole; definitionId: string; systemPrompt: string }> = [];
    for (const row of rows) {
      if (!row.d.enabled) continue;
      const role = row.d.role as AgentRole;
      if (!RESEARCH_TEAM_SLOT_SET.has(role)) continue;
      slots.push({ role, definitionId: row.d.id, systemPrompt: row.d.systemPrompt });
    }
    if (slots.length === 0) {
      throw new Error(
        "所选 Agent 组中没有可用的研究团队槽位定义（需为 analyst_* / research / backtest / risk 之一且已启用）"
      );
    }
    return slots;
  }

  const dbDefs = await db.select().from(agentDefinition).where(eq(agentDefinition.enabled, true));
  const slotDefs = dbDefs.filter((d) => RESEARCH_TEAM_SLOT_SET.has(d.role as string));
  const definitionIdByRole: Partial<Record<AgentRole, string>> = {};
  for (const def of slotDefs) {
    const r = def.role as AgentRole;
    if (!definitionIdByRole[r]) definitionIdByRole[r] = def.id;
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
    risk:
      "你是风控专员，从规则与敞口角度审视当前结论。输出 Markdown（不要 JSON）。",
    risk_manager:
      "你是风控经理，综合评估尾部风险与合规边界。输出 Markdown（不要 JSON）。",
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

  const slots: Array<{ role: AgentRole; definitionId: string; systemPrompt: string }> = [];
  for (const role of RESEARCH_TEAM_SLOT_ROLES) {
    const defId = definitionIdByRole[role];
    if (!defId) continue;
    slots.push({ role, definitionId: defId, systemPrompt: prompts[role] });
  }
  if (slots.length === 0) {
    throw new Error(
      "未在数据库中找到已启用的研究团队槽位定义。请到「配置中心 → Agent」启用 analyst_*、research、backtest、risk* 等角色，或重启后端加载种子。"
    );
  }
  return slots;
}

function mergeMultiSymbolAnalystResults(
  scope: NormalizedResearchScope,
  results: AnalystTeamResult[]
): AnalystTeamResult {
  if (results.length === 0) {
    throw new Error("mergeMultiSymbolAnalystResults: empty results");
  }
  if (results.length === 1) {
    return { ...results[0], scope, perSymbol: [{ symbol: results[0].ticker, result: stripScopeFields(results[0]) }] };
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
 * 主入口：并行运行 Analyst Agent（默认四类；可选用 Agent 组子集/顺序），收集信号，执行 MSA 融合
 */
export async function runAnalystTeam(params: {
  workflowRunId: string;
  /** 兼容：单标的代码；多标的请用 scope.symbols 或逗号分隔 */
  ticker?: string;
  scope?: ResearchScopeInput | null;
  context?: string;
  agentGroupId?: string | null;
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
  agentGroupId?: string | null;
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

  const orchestratorSlot = await resolveOrchestratorSlot(db, params.agentGroupId);

  await db
    .update(workflowRun)
    .set({ agentGroupId: params.agentGroupId ?? null })
    .where(eq(workflowRun.id, workflowRunId));

  let slots = await resolveAnalystSlots({ db, agentGroupId: params.agentGroupId });
  if (params.analystDefinitionIds && params.analystDefinitionIds.length > 0) {
    const allowIds = new Set(params.analystDefinitionIds);
    slots = slots.filter((s) => allowIds.has(s.definitionId));
    if (slots.length === 0) {
      throw new Error(
        "所选分析师定义与当前编组或可用分析师槽位无交集。请调整左侧勾选的 Agent，或更换分析师编组。"
      );
    }
  } else if (params.analystRoles && params.analystRoles.length > 0) {
    const allow = new Set(params.analystRoles);
    slots = slots.filter((s) => allow.has(s.role));
    if (slots.length === 0) {
      throw new Error(
        "所选「团队成员」与当前编组或可用分析师定义无交集。请调整左侧参与角色，或换一个分析师编组。"
      );
    }
  }

  slots = await enrichAnalystSlotsWithPack(db, slots);
  slots = await enrichAnalystSlotsWithFsi(db, slots);

  let relationEdges: TeamRelationEdge[] = [];
  if (params.agentGroupId) {
    const grp = await db.select().from(agentGroup).where(eq(agentGroup.id, params.agentGroupId)).limit(1);
    if (grp[0]) {
      relationEdges = parseGroupRelationsWithOrchestrator(grp[0].relationsJson);
    }
  }

  const analystSlots = slots.filter((s) => isMsAnalystRole(s.role));
  const auxSlots = slots.filter((s) => POST_FUSION_AUX_ROLES.has(s.role));
  const strategyPipelineMode =
    isStrategyPipelineGroup(params.agentGroupId) || isStrategyFocusedSlots(slots);
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
  }

  let analystEdges = slotOnlyRelationEdges(relationEdges, slotRoleSet);
  analystEdges = analystEdges.filter((e) => isMsAnalystRole(e.from) && isMsAnalystRole(e.to));
  const waveSlots = analystSlots;
  const waves =
    waveSlots.length > 0 ? partitionSlotsIntoWaves(waveSlots, analystEdges) : [];

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

  for (const wave of waves) {
    const waveResults = await Promise.allSettled(
      wave.map((slot) => {
        const predChain = (predsByTo.get(slot.role) ?? []).filter(
          (pr) => outputByRole.has(pr) || auxDigestByRole.has(pr)
        );
        const appendix =
          predChain.length > 0
            ? `\n\n### 前置成员结论（编组通信拓扑）\n${predChain
                .map((pr) => {
                  const o = outputByRole.get(pr);
                  if (o) {
                    return `- **${pr}**（信号）：${o.signal}（置信度 ${(o.confidence * 100).toFixed(0)}%）\n  ${String(o.reasoning).slice(0, 600)}`;
                  }
                  const md = auxDigestByRole.get(pr);
                  if (md) return `- **${pr}**（辅助）：\n  ${md.slice(0, 600)}`;
                  return "";
                })
                .filter((line) => line.length > 0)
                .join("\n")}\n`
            : "";
        const ctx = `${context}${appendix}`;
        type SlotResult =
          | { kind: "analyst"; payload: RawAnalystSignal & { agentInstanceId?: string } }
          | { kind: "missing_signal"; agentInstanceId?: string; body: string };
        return (async (): Promise<SlotResult> => {
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
          const reactOut = await runResearchTeamSlotReact({
            workflowRunId,
            definitionId: slot.definitionId,
            role: slot.role,
            systemPrompt: slot.systemPrompt,
            ticker,
            scope,
            context: ctx,
            ...(preInstanceId !== undefined ? { agentInstanceId: preInstanceId } : {}),
            expectJsonSignal: true,
          });
          /**
           * 2026-05-26 修复：旧逻辑无脑 cast 成 analyst payload，遇到 LLM 输出
           * 不是合法 JSON 时 parseJsonSignalFromText 会塌缩为 hold@0.4，污染整批
           * 信号。新逻辑：当 slot ReAct 返回 markdown（即 signal_parse_failed），
           * 不再生成假 RawAnalystSignal，把它降级为 "missing_signal" 让上层 fusion
           * 看到真实的"信号缺失"状态。
           */
          if (reactOut.kind === "analyst") {
            return { kind: "analyst", payload: reactOut.payload };
          }
          return {
            kind: "missing_signal",
            ...(reactOut.agentInstanceId !== undefined
              ? { agentInstanceId: reactOut.agentInstanceId }
              : {}),
            body: reactOut.body,
          };
        })();
      })
    );

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
        await logResearchTeamInteraction({
          workflowRunId,
          fromRole: slot.role,
          toRole: "orchestrator",
          kind: "llm_message",
          contentText: `[${signal.signal}] ${(signal.confidence * 100).toFixed(0)}% — ${signal.reasoning.slice(0, 3500)}`,
          payloadJson: { phase: "analyst_report", ticker },
        });
      } else if (
        result.status === "fulfilled" &&
        result.value.kind === "missing_signal" &&
        isMsAnalystRole(slot.role)
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
      } else if (result.status === "rejected" && isMsAnalystRole(slot.role)) {
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
      }

      if (instanceId) {
        await db
          .update(agentInstance)
          .set({ status: "stopped", endedAt: new Date().toISOString() })
          .where(eq(agentInstance.id, instanceId));
      }
    }
  }

  /** 融合顺序与 slots 声明顺序一致（便于对照 UI） */
  const orderKey = new Map(slots.map((s, i) => [s.role, i] as const));
  rawSignals.sort((a, b) => (orderKey.get(a.analystRole as AgentRole) ?? 0) - (orderKey.get(b.analystRole as AgentRole) ?? 0));
  persistSignals.sort(
    (a, b) =>
      (orderKey.get(a.signal.analystRole as AgentRole) ?? 0) - (orderKey.get(b.signal.analystRole as AgentRole) ?? 0)
  );

  // Run MSA fusion（仅 analyst_* 信号；无信号时由 tickerHint 生成占位融合）
  const fusionResult = await fuseSignals({
    workflowRunId,
    signals: rawSignals,
    persistSignals,
    tickerHint: ticker,
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

  let reportCore = buildTeamReport(
    ticker,
    fusionResult.fusedSignal,
    fusionResult.fusedConfidence,
    fusionResult.signalBreakdown
  );

  let orchestratorDecision = null;
  if (strategyPipelineMode && auxSlots.length > 0) {
    orchestratorDecision = {
      signal: fusionResult.fusedSignal,
      confidence: Math.max(fusionResult.fusedConfidence, 0.55),
      reasoning:
        "策略专岗编组：基于当前工作流上下文（建议粘贴全分析师/MSA 报告）直接进入策略撰写与回测。",
      proceedToStrategy: true,
    };
    reportCore += `\n\n### Orchestrator 汇总决策\n\n**${orchestratorDecision.signal.toUpperCase()}**（${(orchestratorDecision.confidence * 100).toFixed(0)}%）\n\n${orchestratorDecision.reasoning}`;
    await logResearchTeamInteraction({
      workflowRunId,
      fromRole: "orchestrator",
      toRole: "research",
      kind: "llm_message",
      contentText: "策略专岗编组：进入策略撰写与回测阶段。",
      payloadJson: { phase: "strategy_pipeline_mode" },
    });
  } else if (orchestratorSlot) {
    orchestratorDecision = await runOrchestratorDecision({
      workflowRunId,
      ticker,
      orchestrator: orchestratorSlot,
      fusionSummary: reportCore,
      msaSignal: fusionResult.fusedSignal,
      msaConfidence: fusionResult.fusedConfidence,
    });
    reportCore += `\n\n### Orchestrator 汇总决策\n\n**${orchestratorDecision.signal.toUpperCase()}**（${(orchestratorDecision.confidence * 100).toFixed(0)}%）\n\n${orchestratorDecision.reasoning}`;
    if (orchestratorDecision.proceedToStrategy) {
      await logResearchTeamInteraction({
        workflowRunId,
        fromRole: "orchestrator",
        toRole: "research",
        kind: "llm_message",
        contentText: "Orchestrator 批准进入策略撰写与回测阶段。",
        payloadJson: { phase: "orchestrator_to_research" },
      });
    }
  }

  if (auxSlots.length > 0) {
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
        const out = await runResearchTeamSlotReact({
          workflowRunId,
          definitionId: slot.definitionId,
          role: slot.role,
          systemPrompt: slot.systemPrompt,
          ticker,
          scope,
          context: ctx,
          expectJsonSignal: false,
        });
        return out.kind === "markdown" ? out.body : "";
      },
    });
    auxSections = post.auxSections;
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
  const shouldDebate = fusionResult.fusedConfidence < debateConfig.confidenceThreshold;
  if (shouldDebate) {
    const analystSummary = fusionResult.signalBreakdown
      .map((s) => `${s.role}: ${s.signal} (${(s.confidence * 100).toFixed(0)}%) ${s.reasoning.slice(0, 120)}`)
      .join("\n");
    const d = await runDebateSession({
      workflowRunId,
      ticker,
      fusedSignal: fusionResult.fusedSignal,
      fusedConfidence: fusionResult.fusedConfidence,
      analystSummary,
      maxRounds: debateConfig.maxRounds,
    });
    debate = {
      sessionId: d.debateSessionId,
      consensusScore: d.consensusScore,
      finalStance: d.finalStance,
      verdict: d.verdict,
      reasoning: d.reasoning,
    };
  }
  const risk = await evaluateRiskAndVeto({
    workflowRunId,
    ticker,
    fusedSignal: fusionResult.fusedSignal,
    fusedConfidence: fusionResult.fusedConfidence,
    debateConsensusScore: debate?.consensusScore,
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
    debate,
    risk,
  };
}

function buildTeamReport(
  ticker: string,
  fusedSignal: AnalystSignalValue,
  fusedConfidence: number,
  breakdown: Array<{ role: AgentRole; signal: AnalystSignalValue; confidence: number; reasoning: string }>
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

  const lines = [
    `## ${ticker} 分析师团队研究报告`,
    ``,
    `**综合结论**：${signalEmoji[fusedSignal]} **${fusedSignal.toUpperCase()}**（置信度：${(fusedConfidence * 100).toFixed(0)}%）`,
    fusedConfidence < 0.55 ? `⚠️ 置信度不足，建议触发辩论协议（SDP）` : `✅ 置信度充分，可进入风控审核`,
    ``,
    `### 各分析师信号`,
  ];

  for (const s of breakdown) {
    const name = roleNames[s.role] ?? s.role;
    lines.push(`- **${name}**：${signalEmoji[s.signal]} ${s.signal.toUpperCase()}（${(s.confidence * 100).toFixed(0)}%）`);
    lines.push(`  > ${s.reasoning.slice(0, 200)}`);
  }

  return lines.join("\n");
}
