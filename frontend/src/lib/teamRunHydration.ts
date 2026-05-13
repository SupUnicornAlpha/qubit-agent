import type {
  AnalystSignalRecord,
  AnalystTeamResult,
  DebateSessionRecord,
  DebateStreamEvent,
  DebateTurnRecord,
  DebateVerdictRecord,
  RiskVetoLogRecord,
} from "../api/types";
import {
  getAnalystSignals,
  getDebateTurns,
  getDebateVerdict,
  getRiskVetoLogs,
  getSignalFusion,
  listDebateSessionsForWorkflow,
} from "../api/backend";

function mapVetoLogToRisk(log: RiskVetoLogRecord): NonNullable<AnalystTeamResult["risk"]> {
  const rules = Array.isArray(log.riskRulesTriggeredJson)
    ? (log.riskRulesTriggeredJson as string[])
    : [];
  return {
    approved: false,
    vetoed: true,
    riskScore: log.riskScore,
    reason: log.vetoReason,
    severity: log.severity,
    rulesTriggered: rules,
  };
}

function buildDebateSummary(
  session: DebateSessionRecord,
  verdict: DebateVerdictRecord | null
): AnalystTeamResult["debate"] | undefined {
  if (!verdict && !session.verdict) return undefined;
  const v = verdict;
  const verdictEnum =
    session.verdict === "agree_bull" || session.verdict === "agree_bear" || session.verdict === "no_consensus"
      ? session.verdict
      : v?.finalStance === "bull"
        ? "agree_bull"
        : v?.finalStance === "bear"
          ? "agree_bear"
          : "no_consensus";
  return {
    sessionId: session.id,
    consensusScore: v?.consensusScore ?? session.consensusScore ?? 0,
    finalStance: (v?.finalStance ?? "hold") as NonNullable<AnalystTeamResult["debate"]>["finalStance"],
    verdict: verdictEnum,
    reasoning: v?.reasoning ?? "",
  };
}

export function analystSignalsToReplayEvents(
  signals: AnalystSignalRecord[],
  workflowRunId: string
): DebateStreamEvent[] {
  return signals.map((s) => ({
    workflowRunId,
    sessionId: "",
    type: "debate_turn" as const,
    ts: new Date(s.createdAt).getTime(),
    payload: {
      source: "analyst_signal",
      speakerRole: s.analystRole,
      statement: s.reasoning,
      reasoning: s.reasoning,
      signal: s.signal,
      confidence: s.confidence,
    },
  }));
}

export function debateRecordsToReplayEvents(
  session: DebateSessionRecord,
  turns: DebateTurnRecord[],
  verdict: DebateVerdictRecord | null,
  workflowRunId: string
): DebateStreamEvent[] {
  const out: DebateStreamEvent[] = [];
  out.push({
    workflowRunId,
    sessionId: session.id,
    type: "debate_start",
    ts: new Date(session.createdAt).getTime(),
    payload: { topic: session.topic, triggerReason: session.triggerReason, maxRounds: session.maxRounds },
  });
  for (const t of turns) {
    out.push({
      workflowRunId,
      sessionId: session.id,
      type: "debate_turn",
      ts: new Date(t.createdAt).getTime(),
      payload: {
        roundNumber: t.roundNumber,
        speakerRole: t.speakerRole,
        stance: t.stance,
        statement: t.statement,
        confidence: t.confidence,
      },
    });
  }
  if (verdict) {
    out.push({
      workflowRunId,
      sessionId: session.id,
      type: "debate_verdict",
      ts: new Date(verdict.createdAt).getTime(),
      payload: {
        consensusScore: verdict.consensusScore,
        finalStance: verdict.finalStance,
        reasoning: verdict.reasoning,
        verdict: session.verdict,
      },
    });
  }
  return out;
}

export interface TeamWorkbenchHydration {
  result: AnalystTeamResult | null;
  debateReplay: DebateStreamEvent[];
  analystReplay: DebateStreamEvent[];
}

/**
 * 从 SQLite 恢复某 workflow 的研究团队产物：融合结论、分析师发言、辩论轮次、风控否决记录。
 */
export async function hydrateTeamWorkbenchFromDb(workflowRunId: string): Promise<TeamWorkbenchHydration> {
  const [baseFusion, signals, sessions, riskLogs] = await Promise.all([
    getSignalFusion(workflowRunId),
    getAnalystSignals(workflowRunId).catch(() => [] as AnalystSignalRecord[]),
    listDebateSessionsForWorkflow(workflowRunId).catch(() => [] as DebateSessionRecord[]),
    getRiskVetoLogs(workflowRunId).catch(() => [] as RiskVetoLogRecord[]),
  ]);

  const analystReplay = analystSignalsToReplayEvents(signals, workflowRunId);

  const latestSession = sessions[0];
  let debateReplay: DebateStreamEvent[] = [];
  let debateBlock: AnalystTeamResult["debate"] | undefined;
  if (latestSession) {
    const [turns, verdict] = await Promise.all([
      getDebateTurns(latestSession.id).catch(() => [] as DebateTurnRecord[]),
      getDebateVerdict(latestSession.id).catch(() => null as DebateVerdictRecord | null),
    ]);
    debateReplay = debateRecordsToReplayEvents(latestSession, turns, verdict, workflowRunId);
    debateBlock = buildDebateSummary(latestSession, verdict);
  }

  let result = baseFusion;
  if (result && debateBlock) {
    result = { ...result, debate: debateBlock };
  }
  if (result && riskLogs[0]) {
    result = { ...result, risk: mapVetoLogToRisk(riskLogs[0]) };
  }

  return { result, debateReplay, analystReplay };
}
