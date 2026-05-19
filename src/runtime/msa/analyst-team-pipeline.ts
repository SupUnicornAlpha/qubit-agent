import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { BacktestConnector } from "../../connectors/backtest/backtest.connector";
import { connectorRegistry } from "../../connectors/registry";
import { runSmaCrossoverBacktestJob } from "../market/backtest-job-runner";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentGroupMember,
  backtestJob,
  indicatorStrategyScript,
  workflowRun,
} from "../../db/sqlite/schema";
import type { AgentRole } from "../../types/entities";
import type { AnalystSignalValue } from "../../types/entities";
import { exportStrategyScriptToWorkflowDir } from "../strategy/strategy-script-files";
import { runLlmGateway } from "../llm/gateway";
import { loadModelConfig } from "../config/model-config";
import { logResearchTeamInteraction } from "../research-team/interaction-log";
import { partitionSlotsIntoWaves, parseTeamRelations, type TeamRelationEdge } from "./analyst-team-topology";

export type AnalystTeamSlot = {
  role: AgentRole;
  definitionId: string;
  systemPrompt: string;
};

export const POST_FUSION_AUX_ROLES = new Set<AgentRole>([
  "research",
  "backtest",
  "backtest_engineer",
  "risk",
  "risk_manager",
]);

const TOPOLOGY_ROLES_WITH_ORCHESTRATOR: readonly AgentRole[] = [
  "orchestrator",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
  "research",
  "backtest",
  "backtest_engineer",
  "risk",
  "risk_manager",
] as AgentRole[];

export { TOPOLOGY_ROLES_WITH_ORCHESTRATOR };

/** 解析编组拓扑（含 orchestrator 边，用于调度与展示） */
export function parseGroupRelationsWithOrchestrator(raw: unknown): TeamRelationEdge[] {
  return parseTeamRelations(raw, TOPOLOGY_ROLES_WITH_ORCHESTRATOR);
}

/** 仅保留槽位之间的边；orchestrator 星型边不进入 wave 分层 */
export function slotOnlyRelationEdges(
  edges: TeamRelationEdge[],
  slotRoles: Set<AgentRole>
): TeamRelationEdge[] {
  return edges.filter((e) => slotRoles.has(e.from) && slotRoles.has(e.to));
}

/** 从编组或种子定义解析 orchestrator（用于规划 / 汇总决策，不占分析师槽位） */
export async function resolveOrchestratorSlot(
  db: Awaited<ReturnType<typeof getDb>>,
  agentGroupId?: string | null
): Promise<AnalystTeamSlot | null> {
  if (agentGroupId) {
    const rows = await db
      .select({ d: agentDefinition })
      .from(agentGroupMember)
      .innerJoin(agentDefinition, eq(agentGroupMember.definitionId, agentDefinition.id))
      .where(eq(agentGroupMember.groupId, agentGroupId))
      .orderBy(asc(agentGroupMember.sortOrder));
    const row = rows.find((r) => r.d.role === "orchestrator" && r.d.enabled);
    if (row) {
      return {
        role: "orchestrator",
        definitionId: row.d.id,
        systemPrompt: row.d.systemPrompt,
      };
    }
  }
  const defs = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.role, "orchestrator"))
    .limit(1);
  const def = defs.find((d) => d.enabled);
  if (!def) return null;
  return {
    role: "orchestrator",
    definitionId: def.id,
    systemPrompt: def.systemPrompt,
  };
}

export interface OrchestratorDecision {
  signal: AnalystSignalValue;
  confidence: number;
  reasoning: string;
  proceedToStrategy: boolean;
}

/** 运行前：Orchestrator 阅读数据快照并生成对各角色的任务说明 */
export async function runOrchestratorPlanning(input: {
  workflowRunId: string;
  ticker: string;
  slotRoles: AgentRole[];
  dataAndUserContext: string;
  orchestrator: AnalystTeamSlot;
}): Promise<string> {
  const modelConfig = (await loadModelConfig()) ?? {
    provider: "mock" as const,
    model: "mock-orchestrator",
    apiKey: "",
  };
  const targets = input.slotRoles.filter((r) => r !== "orchestrator").join("、");
  const userPrompt = `你是研究团队 Orchestrator。标的：${input.ticker}
参与角色：${targets}

请阅读下方数据与用户背景，输出 **Markdown 任务简报**（不要 JSON），包含：
1. 本轮研究重点与待回答问题
2. 对各分析师角色的具体关注点（逐条列出角色名）
3. 要求：在引用下方数据快照前提下再下结论，信息不足时明确写「需补充」

---
${input.dataAndUserContext}`;

  let answer = "";
  try {
    answer = await runLlmGateway({
      config: modelConfig,
      systemPrompt: input.orchestrator.systemPrompt,
      userPrompt,
      onToken: () => {},
    });
  } catch (e) {
    answer = `（编排计划生成失败：${e instanceof Error ? e.message : String(e)}）`;
  }
  const brief = answer.trim() || "（无编排简报）";
  for (const role of input.slotRoles) {
    if (role === "orchestrator") continue;
    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: "orchestrator",
      toRole: role,
      kind: "llm_message",
      contentText: brief.slice(0, 4000),
      payloadJson: { phase: "orchestrator_plan", ticker: input.ticker },
    });
  }
  return brief;
}

/** MSA 之后：Orchestrator 汇总并给出买/卖/观望与是否进入策略阶段 */
export async function runOrchestratorDecision(input: {
  workflowRunId: string;
  ticker: string;
  orchestrator: AnalystTeamSlot;
  fusionSummary: string;
  msaSignal: AnalystSignalValue;
  msaConfidence: number;
}): Promise<OrchestratorDecision> {
  const modelConfig = (await loadModelConfig()) ?? {
    provider: "mock" as const,
    model: "mock-orchestrator",
    apiKey: "",
  };
  const userPrompt = `标的：${input.ticker}
MSA 融合信号：${input.msaSignal}（置信度 ${(input.msaConfidence * 100).toFixed(0)}%）

请阅读各分析师与融合报告，输出 **唯一一段 JSON**：
{"signal":"buy|sell|hold","confidence":0.0-1.0,"reasoning":"…","proceedToStrategy":true|false}
- proceedToStrategy：仅当信息充分且值得生成可回测策略时为 true

---
${input.fusionSummary}`;

  let answer = "";
  try {
    answer = await runLlmGateway({
      config: modelConfig,
      systemPrompt: input.orchestrator.systemPrompt,
      userPrompt,
      onToken: () => {},
    });
  } catch (e) {
    return {
      signal: input.msaSignal,
      confidence: input.msaConfidence,
      reasoning: `Orchestrator 决策失败，沿用 MSA：${(e as Error).message}`,
      proceedToStrategy: input.msaConfidence >= 0.5,
    };
  }
  let parsed: Record<string, unknown> = {};
  try {
    const m = answer.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {
    parsed = {};
  }
  const signal = (["buy", "sell", "hold"].includes(parsed["signal"] as string)
    ? parsed["signal"]
    : input.msaSignal) as AnalystSignalValue;
  const confidence =
    typeof parsed["confidence"] === "number"
      ? Math.max(0, Math.min(1, parsed["confidence"]))
      : input.msaConfidence;
  const reasoning =
    typeof parsed["reasoning"] === "string" ? parsed["reasoning"] : answer.slice(0, 800);
  const proceedToStrategy =
    typeof parsed["proceedToStrategy"] === "boolean"
      ? parsed["proceedToStrategy"]
      : confidence >= 0.45 && signal !== "hold";

  await logResearchTeamInteraction({
    workflowRunId: input.workflowRunId,
    fromRole: "orchestrator",
    toRole: "msa",
    kind: "llm_message",
    contentText: `[Orchestrator 决策] ${signal} ${(confidence * 100).toFixed(0)}% — ${reasoning.slice(0, 3500)}`,
    payloadJson: { phase: "orchestrator_decision", proceedToStrategy },
  });

  return { signal, confidence, reasoning, proceedToStrategy };
}

/**
 * 按拓扑确定 MSA/编排器 之后的辅助槽位顺序（research → backtest → risk…）。
 * 画布边语义：from 完成后结论传给 to。
 */
export function orderPostFusionSlotsByTopology(
  auxSlots: AnalystTeamSlot[],
  relationEdges: TeamRelationEdge[]
): AnalystTeamSlot[] {
  if (auxSlots.length <= 1) return auxSlots;
  const roleSet = new Set(auxSlots.map((s) => s.role));
  let slotEdges = relationEdges.filter((e) => roleSet.has(e.from) && roleSet.has(e.to));
  if (slotEdges.length === 0) {
    slotEdges = defaultAuxPipelineEdges(auxSlots);
  }
  const waves = partitionSlotsIntoWaves(auxSlots, slotEdges);
  const ordered = waves.flat();
  const seen = new Set<AgentRole>();
  const out: AnalystTeamSlot[] = [];
  for (const s of ordered) {
    if (!seen.has(s.role)) {
      seen.add(s.role);
      out.push(s);
    }
  }
  for (const s of auxSlots) {
    if (!seen.has(s.role)) out.push(s);
  }
  return out;
}

/** 无槽位间边时：分析师并行，其余辅助角色在 MSA 之后串行 */
export function defaultAuxPipelineEdges(slots: AnalystTeamSlot[]): TeamRelationEdge[] {
  const roles = new Set(slots.map((s) => s.role));
  const edges: TeamRelationEdge[] = [];
  const chain: AgentRole[] = ["research", "backtest", "backtest_engineer", "risk", "risk_manager"];
  let prev: AgentRole | null = null;
  for (const r of chain) {
    if (!roles.has(r)) continue;
    if (prev) edges.push({ from: prev, to: r });
    prev = r;
  }
  return edges;
}

export async function logOrchestratorKickoff(input: {
  workflowRunId: string;
  ticker: string;
  slotRoles: AgentRole[];
  relationEdges: TeamRelationEdge[];
}): Promise<void> {
  const fromOrch = input.relationEdges
    .filter((e) => e.from === "orchestrator")
    .map((e) => e.to);
  const targets =
    fromOrch.length > 0
      ? [...new Set(fromOrch)]
      : input.slotRoles.filter((r) => r !== "orchestrator");

  const plan = [
    `【Orchestrator 编排】研究团队任务已启动`,
    `标的：${input.ticker}`,
    `参与槽位：${input.slotRoles.join("、")}`,
    `流程：分析师并行 → MSA 融合 → 策略撰写 → 回测执行 → 风控复核`,
  ].join("\n");

  for (const toRole of targets) {
    if (toRole === "orchestrator") continue;
    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: "orchestrator",
      toRole,
      kind: "llm_message",
      contentText: plan,
      payloadJson: { phase: "kickoff", ticker: input.ticker },
    });
  }
}

function extractPythonBlock(markdown: string): string {
  const m = markdown.match(/```(?:python|py)?\s*\n([\s\S]*?)```/i);
  return m?.[1]?.trim() ?? "";
}

export async function runPostFusionPipeline(input: {
  workflowRunId: string;
  ticker: string;
  fusionReport: string;
  fusedSignal: string;
  fusedConfidence: number;
  orchestratorDecision?: OrchestratorDecision | null;
  relationEdges: TeamRelationEdge[];
  auxSlots: AnalystTeamSlot[];
  runAuxLlm: (slot: AnalystTeamSlot, context: string) => Promise<string>;
}): Promise<{ auxSections: Array<{ role: AgentRole; body: string }>; strategyScriptId?: string; backtestSummary?: string }> {
  const auxSections: Array<{ role: AgentRole; body: string }> = [];
  if (input.auxSlots.length === 0) {
    return { auxSections };
  }

  const orch = input.orchestratorDecision;
  const fusionCtx = [
    input.fusionReport,
    "",
    `MSA 结论：${input.fusedSignal}（置信度 ${(input.fusedConfidence * 100).toFixed(0)}%）`,
    orch
      ? [
          "",
          `Orchestrator 汇总决策：${orch.signal}（${(orch.confidence * 100).toFixed(0)}%）`,
          orch.reasoning,
          orch.proceedToStrategy ? "→ 进入策略撰写与回测" : "→ 暂不生成策略（信息不足或观望）",
        ].join("\n")
      : "",
  ].join("\n");

  if (orch && !orch.proceedToStrategy) {
    return {
      auxSections: [
        {
          role: "research",
          body: `Orchestrator 判断暂不进入策略/回测阶段。\n\n${orch.reasoning}`,
        },
      ],
    };
  }

  let strategyScriptId: string | undefined;
  let backtestSummary: string | undefined;
  let prevRole: AgentRole | null = "orchestrator";

  const orderedAux = orderPostFusionSlotsByTopology(input.auxSlots, input.relationEdges);

  for (const slot of orderedAux) {
    if (prevRole) {
      await logResearchTeamInteraction({
        workflowRunId: input.workflowRunId,
        fromRole: prevRole,
        toRole: slot.role,
        kind: "llm_message",
        contentText: `[${prevRole} → ${slot.role}] 融合与编排结论已传入本阶段`,
        payloadJson: { phase: "post_fusion_handoff" },
      });
    }

    const extra =
      slot.role === "research"
        ? "\n\n请输出可回测的 Python 策略：在 Markdown 末尾附 ```python 代码块，含 `def on_bar(ctx):` 或清晰买卖逻辑；若暂无法生成代码，说明原因。"
        : slot.role === "backtest" || slot.role === "backtest_engineer"
          ? strategyScriptId
            ? `\n\n已生成策略脚本 id=${strategyScriptId}；请给出回测参数建议与结果解读要点。`
            : "\n\n请基于上游策略结论给出回测方案与参数建议。"
          : "";

    let body = await input.runAuxLlm(slot, `${fusionCtx}${extra}`);

    if (slot.role === "research") {
      const py = extractPythonBlock(body);
      if (py.length > 20) {
        const saved = await persistStrategyScript({
          workflowRunId: input.workflowRunId,
          ticker: input.ticker,
          name: `${input.ticker} 研究团队策略`,
          signalCode: py,
          fusionReport: input.fusionReport,
        });
        strategyScriptId = saved?.scriptId;
        if (saved?.scriptId) {
          await logResearchTeamInteraction({
            workflowRunId: input.workflowRunId,
            fromRole: "research",
            toRole: "backtest",
            kind: "tool_call",
            contentText: `已保存策略脚本 ${saved.scriptId}`,
            payloadJson: { tool: "save_strategy_script", scriptId: saved.scriptId },
          });
        }
      }
    }

    if ((slot.role === "backtest" || slot.role === "backtest_engineer") && !backtestSummary) {
      backtestSummary = await runNativeBacktestForTicker(input.workflowRunId, input.ticker);
      if (backtestSummary) {
        body = `${body}\n\n### 引擎回测结果\n\n${backtestSummary}`;
        await logResearchTeamInteraction({
          workflowRunId: input.workflowRunId,
          fromRole: "backtest",
          toRole: "msa",
          kind: "llm_message",
          contentText: backtestSummary.slice(0, 4000),
          payloadJson: { phase: "backtest_engine" },
        });
      }
    }

    auxSections.push({ role: slot.role, body });

    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: prevRole ?? "orchestrator",
      toRole: slot.role,
      kind: "llm_message",
      contentText: body.slice(0, 4000),
      payloadJson: { phase: "post_fusion", role: slot.role },
    });

    prevRole = slot.role;
  }

  return { auxSections, strategyScriptId, backtestSummary };
}

async function persistStrategyScript(input: {
  workflowRunId: string;
  ticker: string;
  name: string;
  signalCode: string;
  fusionReport: string;
}): Promise<{ scriptId: string } | null> {
  const db = await getDb();
  const wf = await db.select().from(workflowRun).where(eq(workflowRun.id, input.workflowRunId)).limit(1);
  const row = wf[0];
  if (!row?.sessionId) return null;

  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(indicatorStrategyScript).values({
    id,
    sessionId: row.sessionId,
    workflowRunId: input.workflowRunId,
    name: input.name,
    ideCode: "",
    signalCode: input.signalCode,
    aiPromptSnapshot: input.fusionReport.slice(0, 8000),
    chartSnapshotJson: JSON.stringify({ ticker: input.ticker }),
    purpose: "research",
    createdAt: now,
    updatedAt: now,
  });

  await exportStrategyScriptToWorkflowDir({
    projectId: row.projectId,
    workflowRunId: input.workflowRunId,
    scriptId: id,
    name: input.name,
    ideCode: "",
    signalCode: input.signalCode,
  });

  return { scriptId: id };
}

async function runNativeBacktestForTicker(
  workflowRunId: string,
  ticker: string
): Promise<string | null> {
  try {
    const body: Record<string, unknown> = {
      symbol: ticker,
      exchange: "US",
      timeframe: "1d",
      limit: 250,
      fastPeriod: 5,
      slowPeriod: 20,
      initialCapital: 100_000,
    };
    const bt = connectorRegistry.get("qubit-backtest") as BacktestConnector | undefined;
    if (bt?.runBacktest) {
      const end = new Date();
      const start = new Date(end);
      start.setFullYear(start.getFullYear() - 1);
      const result = await bt.runBacktest({
        strategyCode: "",
        strategyParams: body,
        datasetUri: "",
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        initialCapital: 100_000,
        commission: 0.001,
        slippage: 0,
        benchmarkSymbol: ticker,
      });
      const perf = result.performance;
      const lines = [
        `状态：${result.status}`,
        `总收益：${(perf.totalReturn * 100).toFixed(2)}%`,
        `Sharpe：${perf.sharpeRatio.toFixed(2)}`,
        `最大回撤：${(perf.maxDrawdown * 100).toFixed(2)}%`,
        `交易次数：${perf.tradeCount}`,
        `说明：内置 SMA 金叉死叉回测（workflow=${workflowRunId}）。`,
      ];
      return lines.join("\n");
    }
    const jobId = randomUUID();
    const db = await getDb();
    await db.insert(backtestJob).values({
      id: jobId,
      status: "queued",
      kind: "sma_crossover",
      paramsJson: body,
    });
    await runSmaCrossoverBacktestJob(jobId, body);
    return `状态：completed（直连 job-runner）\n说明：workflow=${workflowRunId}，标的 ${ticker}`;
  } catch (e) {
    return `（回测引擎执行失败：${e instanceof Error ? e.message : String(e)}）`;
  }
}
