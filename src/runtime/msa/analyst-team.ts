/**
 * Analyst Team Engine
 *
 * 封装"并行驱动四位分析师 → 等待信号 → MSA 融合"的完整流程。
 * 供 Orchestrator 在 act 阶段调用 run_analyst_team 工具时使用。
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentInstance, agentStep } from "../../db/sqlite/schema";
import { runLlmGateway } from "../llm/gateway";
import { loadModelConfig } from "../config/model-config";
import { loadDebateConfig } from "../config/debate-config";
import { fuseSignals, type RawAnalystSignal } from "./signal-fusion";
import { runDebateSession } from "../debate/debate-engine";
import { evaluateRiskAndVeto } from "../risk/veto-engine";
import type { AgentRole, AnalystSignalValue } from "../../types/entities";

const ANALYST_ROLES: AgentRole[] = [
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
];

const ANALYST_DEF_IDS: Record<AgentRole, string> = {
  analyst_fundamental: "def-analyst-fundamental",
  analyst_technical: "def-analyst-technical",
  analyst_sentiment: "def-analyst-sentiment",
  analyst_macro: "def-analyst-macro",
  // fill other roles to satisfy type (unused in this map)
  orchestrator: "",
  market_data: "",
  news_event: "",
  research: "",
  backtest: "",
  simulation: "",
  risk: "",
  execution: "",
  memory: "",
  audit: "",
  researcher_bull: "",
  researcher_bear: "",
  risk_manager: "",
  portfolio_manager: "",
  stock_screener: "",
  backtest_engineer: "",
  execution_trader: "",
  memory_curator: "",
};

export interface AnalystTeamResult {
  fusionId: string;
  ticker: string;
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

/**
 * 模拟单个 Analyst Agent 的 LLM 推理，返回结构化信号。
 */
async function runAnalystLlm(params: {
  role: AgentRole;
  systemPrompt: string;
  ticker: string;
  context: string;
}): Promise<RawAnalystSignal & { agentInstanceId?: string }> {
  const modelConfig = (await loadModelConfig()) ?? {
    provider: "mock" as const,
    model: "mock-analyst",
    apiKey: "",
  };

  const userPrompt = `
请分析以下投资标的并给出你的专业判断：

**标的代码**：${params.ticker}
**背景信息**：${params.context}

请严格按照你角色的输出格式输出 JSON，不要添加其他内容。
`;

  let answer = "";
  try {
    answer = await runLlmGateway({
      config: modelConfig,
      systemPrompt: params.systemPrompt,
      userPrompt,
      onToken: () => {},
    });
  } catch (e) {
    answer = `{"signal":"hold","confidence":0.3,"reasoning":"LLM error: ${(e as Error).message}"}`;
  }

  // Extract JSON from the LLM response
  let parsed: Record<string, unknown> = {};
  try {
    const match = answer.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
  } catch {
    parsed = {};
  }

  const signal = (["buy", "sell", "hold"].includes(parsed["signal"] as string)
    ? parsed["signal"]
    : "hold") as AnalystSignalValue;

  const confidence = typeof parsed["confidence"] === "number"
    ? Math.max(0, Math.min(1, parsed["confidence"]))
    : 0.4;

  const reasoning = typeof parsed["reasoning"] === "string"
    ? parsed["reasoning"]
    : answer.slice(0, 500);

  return {
    definitionId: ANALYST_DEF_IDS[params.role],
    analystRole: params.role,
    ticker: params.ticker,
    signal,
    confidence,
    reasoning,
    dataSnapshot: { rawResponse: answer },
  };
}

/**
 * 主入口：并行运行四个 Analyst Agent，收集信号，执行 MSA 融合
 */
export async function runAnalystTeam(params: {
  workflowRunId: string;
  ticker: string;
  context?: string;
}): Promise<AnalystTeamResult> {
  const db = await getDb();
  const { workflowRunId, ticker } = params;
  const context = params.context ?? `请对 ${ticker} 进行全面分析`;

  // Load analyst definitions from DB (or use defaults)
  const dbDefs = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.enabled, true));

  const analystDefs = dbDefs.filter((d) =>
    ANALYST_ROLES.includes(d.role as AgentRole)
  );

  // If no analyst defs in DB, fall back to seed defaults
  const prompts: Record<AgentRole, string> = {
    analyst_fundamental: "你是基本面研究员，分析估值/成长/财务健康度/行业地位，输出JSON：{signal,confidence,reasoning,key_drivers,key_risks}",
    analyst_technical: "你是量化策略师，分析趋势/动量/量价/形态，输出JSON：{signal,confidence,reasoning,entry_zone,stop_loss}",
    analyst_sentiment: "你是舆情分析师，分析新闻情绪/社媒/分析师评级，输出JSON：{signal,confidence,sentiment_score,reasoning,catalysts,risks}",
    analyst_macro: "你是宏观策略师，分析货币政策/经济周期/产业政策/全球联动，输出JSON：{signal,confidence,macro_cycle,policy_stance,reasoning}",
    // unused roles
    orchestrator: "", market_data: "", news_event: "", research: "",
    backtest: "", simulation: "", risk: "", execution: "", memory: "", audit: "",
    researcher_bull: "", researcher_bear: "", risk_manager: "", portfolio_manager: "",
    stock_screener: "", backtest_engineer: "", execution_trader: "", memory_curator: "",
  };

  for (const def of analystDefs) {
    prompts[def.role as AgentRole] = def.systemPrompt;
  }

  // Create agent instances for tracking
  const instanceIds: Record<AgentRole, string> = {} as Record<AgentRole, string>;
  for (const role of ANALYST_ROLES) {
    const defId = ANALYST_DEF_IDS[role] || `def-${role.replace("_", "-")}`;
    const instanceId = randomUUID();
    instanceIds[role] = instanceId;
    await db.insert(agentInstance).values({
      id: instanceId,
      definitionId: defId,
      workflowRunId,
      status: "running",
      currentIteration: 0,
      startedAt: new Date().toISOString(),
    });
  }

  // Run all analysts in parallel
  const analystResults = await Promise.allSettled(
    ANALYST_ROLES.map((role) =>
      runAnalystLlm({
        role,
        systemPrompt: prompts[role],
        ticker,
        context,
      }).then((result) => ({ ...result, agentInstanceId: instanceIds[role] }))
    )
  );

  // Collect successful signals
  const rawSignals: RawAnalystSignal[] = [];
  const persistSignals: Array<{ agentInstanceId?: string; signal: RawAnalystSignal }> = [];

  for (let i = 0; i < ANALYST_ROLES.length; i++) {
    const role = ANALYST_ROLES[i];
    const result = analystResults[i];
    if (result.status === "fulfilled") {
      const { agentInstanceId: _id, ...signal } = result.value;
      rawSignals.push(signal);
      persistSignals.push({ agentInstanceId: instanceIds[role], signal });
    } else {
      // Default to hold with low confidence if analyst fails
      const fallback: RawAnalystSignal = {
        definitionId: ANALYST_DEF_IDS[role],
        analystRole: role,
        ticker,
        signal: "hold",
        confidence: 0.2,
        reasoning: `Analyst ${role} failed: ${result.reason}`,
      };
      rawSignals.push(fallback);
      persistSignals.push({ agentInstanceId: instanceIds[role], signal: fallback });
    }

    // Mark agent instance as stopped
    await db
      .update(agentInstance)
      .set({ status: "stopped", endedAt: new Date().toISOString() })
      .where(eq(agentInstance.id, instanceIds[role]));
  }

  // Run MSA fusion
  const fusionResult = await fuseSignals({
    workflowRunId,
    signals: rawSignals,
    persistSignals,
  });

  // Build human-readable report
  const report = buildTeamReport(ticker, fusionResult.fusedSignal, fusionResult.fusedConfidence, fusionResult.signalBreakdown);
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
    ticker,
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
