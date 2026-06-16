import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { debateSession, debateTurn, debateVerdict } from "../../db/sqlite/schema";
import type { AnalystSignalValue } from "../../types/entities";
import { loadModelConfig } from "../config/model-config";
import { runLlmGateway } from "../llm/gateway";
import { logResearchTeamInteraction } from "../research-team/interaction-log";
import { debateStreamBus } from "./debate-stream";

export interface DebateInput {
  workflowRunId: string;
  ticker: string;
  fusedSignal: AnalystSignalValue;
  fusedConfidence: number;
  analystSummary: string;
  maxRounds?: number;
}

export interface DebateOutput {
  debateSessionId: string;
  consensusScore: number;
  finalStance: "bull" | "bear" | "hold" | "abort";
  verdict: "agree_bull" | "agree_bear" | "no_consensus";
  reasoning: string;
}

/**
 * 单方（bull/bear）一回合发言。A2A 路径下由 bull/bear 专属实例的 runtime handler 调用，
 * 进程内路径下由 `runDebateSession` 默认直接调用——同一套 prompt，保证两条路径行为一致。
 */
export type DebateTurnRunner = (
  stance: "bull" | "bear",
  topic: string,
  summary: string
) => Promise<{ statement: string; confidence: number }>;

export const runDebateRoleTurn: DebateTurnRunner = async (role, topic, summary) => {
  const modelConfig = (await loadModelConfig()) ?? {
    provider: "mock" as const,
    model: "mock",
    apiKey: "",
  };
  const systemPrompt =
    role === "bull"
      ? "你是多方研究员，请提出支持买入的论据，重点强调上行空间、催化剂和风险补偿。"
      : "你是空方研究员，请提出反对买入的论据，重点强调下行风险、估值泡沫和不确定性。";
  const { answer } = await runLlmGateway({
    config: modelConfig,
    systemPrompt,
    userPrompt: `辩题：${topic}\n\n当前信号摘要：\n${summary}\n\n请输出：\n1) 核心观点（200字内）\n2) 置信度（0-1）`,
    onToken: () => {},
  });
  const c = answer.match(/(0(\.\d+)?|1(\.0+)?)/);
  const confidence = c ? Math.max(0, Math.min(1, Number(c[1]))) : 0.6;
  return { statement: answer, confidence };
};

/**
 * @param deps.runTurn 注入单回合发言的执行方式。默认进程内裸 LLM（`runDebateRoleTurn`）；
 *   A2A 路径传入「派 TASK_ASSIGN 给 bull/bear 专属实例并等回包」的实现，使辩论也走总线。
 *   无论哪条路径，评分 / debate_session / debate_turn / verdict 持久化 + 流事件都在本函数内统一完成。
 */
export async function runDebateSession(
  input: DebateInput,
  deps?: { runTurn?: DebateTurnRunner }
): Promise<DebateOutput> {
  const runTurn = deps?.runTurn ?? runDebateRoleTurn;
  const db = await getDb();
  const sessionId = randomUUID();
  const maxRounds = input.maxRounds ?? 2;
  const topic = `是否对 ${input.ticker} 执行 ${input.fusedSignal.toUpperCase()} 建议`;

  await db.insert(debateSession).values({
    id: sessionId,
    workflowRunId: input.workflowRunId,
    topic,
    triggerReason: "low_confidence",
    maxRounds,
    status: "in_progress",
  });
  debateStreamBus.publish({
    workflowRunId: input.workflowRunId,
    sessionId,
    type: "debate_start",
    ts: Date.now(),
    payload: { topic, triggerReason: "low_confidence", maxRounds },
  });

  let bullScore = 0;
  let bearScore = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const bull = await runTurn("bull", topic, input.analystSummary);
    await db.insert(debateTurn).values({
      id: randomUUID(),
      debateSessionId: sessionId,
      roundNumber: round,
      speakerRole: "researcher_bull",
      stance: "bull",
      statement: bull.statement,
      confidence: bull.confidence,
      evidenceJson: [],
    });
    debateStreamBus.publish({
      workflowRunId: input.workflowRunId,
      sessionId,
      type: "debate_turn",
      ts: Date.now(),
      payload: {
        roundNumber: round,
        speakerRole: "researcher_bull",
        stance: "bull",
        statement: bull.statement,
        confidence: bull.confidence,
      },
    });
    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: "researcher_bull",
      toRole: "researcher_bear",
      kind: "llm_message",
      contentText: bull.statement.slice(0, 8000),
      payloadJson: { roundNumber: round, stance: "bull", confidence: bull.confidence },
    });
    bullScore += bull.confidence;

    const bear = await runTurn("bear", topic, input.analystSummary);
    await db.insert(debateTurn).values({
      id: randomUUID(),
      debateSessionId: sessionId,
      roundNumber: round,
      speakerRole: "researcher_bear",
      stance: "bear",
      statement: bear.statement,
      confidence: bear.confidence,
      evidenceJson: [],
    });
    debateStreamBus.publish({
      workflowRunId: input.workflowRunId,
      sessionId,
      type: "debate_turn",
      ts: Date.now(),
      payload: {
        roundNumber: round,
        speakerRole: "researcher_bear",
        stance: "bear",
        statement: bear.statement,
        confidence: bear.confidence,
      },
    });
    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: "researcher_bear",
      toRole: "researcher_bull",
      kind: "llm_message",
      contentText: bear.statement.slice(0, 8000),
      payloadJson: { roundNumber: round, stance: "bear", confidence: bear.confidence },
    });
    bearScore += bear.confidence;
  }

  const total = bullScore + bearScore || 1;
  const bullRatio = bullScore / total;
  const consensusScore = Math.abs(bullRatio - 0.5) * 2;
  const finalStance: DebateOutput["finalStance"] =
    consensusScore < 0.2 ? "hold" : bullRatio >= 0.5 ? "bull" : "bear";
  const verdict: DebateOutput["verdict"] =
    finalStance === "bull" ? "agree_bull" : finalStance === "bear" ? "agree_bear" : "no_consensus";
  const reasoning = `多方总分=${bullScore.toFixed(2)}，空方总分=${bearScore.toFixed(
    2
  )}，共识度=${consensusScore.toFixed(2)}，最终立场=${finalStance}`;

  await db.insert(debateVerdict).values({
    id: randomUUID(),
    debateSessionId: sessionId,
    orchestratorRole: "orchestrator",
    reasoning,
    consensusScore,
    finalStance,
    vetoByRisk: false,
  });
  debateStreamBus.publish({
    workflowRunId: input.workflowRunId,
    sessionId,
    type: "debate_verdict",
    ts: Date.now(),
    payload: { consensusScore, finalStance, verdict, reasoning },
  });
  await logResearchTeamInteraction({
    workflowRunId: input.workflowRunId,
    fromRole: "orchestrator",
    toRole: "msa",
    kind: "llm_message",
    contentText: `辩论结论: ${verdict} / ${finalStance} — ${reasoning.slice(0, 4000)}`,
    payloadJson: { consensusScore, finalStance, verdict },
  });

  await db
    .update(debateSession)
    .set({
      status: "completed",
      consensusScore,
      verdict,
      endedAt: new Date().toISOString(),
    })
    .where(eq(debateSession.id, sessionId));
  debateStreamBus.publish({
    workflowRunId: input.workflowRunId,
    sessionId,
    type: "debate_end",
    ts: Date.now(),
    payload: { status: "completed" },
  });
  debateStreamBus.close(input.workflowRunId);

  return { debateSessionId: sessionId, consensusScore, finalStance, verdict, reasoning };
}
