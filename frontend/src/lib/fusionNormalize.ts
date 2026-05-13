import type { AnalystSignalValue, AnalystTeamResult } from "../api/types";

type FusionBreakdownRow = {
  role?: string;
  analystRole?: string;
  signal?: AnalystSignalValue;
  confidence?: number;
  reasoning?: string;
};

/**
 * 将 GET /analyst/fusion/:id 返回的 FusionOutput（含 signalBreakdown）规范为 AnalystTeamResult。
 */
export function normalizeFusionApiToTeamResult(data: unknown): AnalystTeamResult | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const fusionId = String(o.fusionId ?? o.id ?? "");
  const ticker = String(o.ticker ?? "");
  if (!fusionId || !ticker) return null;

  const fusedSignal = (["buy", "sell", "hold"].includes(String(o.fusedSignal))
    ? o.fusedSignal
    : "hold") as AnalystSignalValue;
  const fusedConfidence = typeof o.fusedConfidence === "number" ? o.fusedConfidence : Number(o.fusedConfidence) || 0;
  const debateTriggered = Boolean(o.debateTriggered);

  const rawBreakdown = (Array.isArray(o.breakdown) ? o.breakdown : o.signalBreakdown) as FusionBreakdownRow[] | undefined;
  const breakdown: AnalystTeamResult["breakdown"] = (rawBreakdown ?? []).map((s) => ({
    role: String(s.role ?? s.analystRole ?? "analyst"),
    signal: (["buy", "sell", "hold"].includes(String(s.signal)) ? s.signal : "hold") as AnalystSignalValue,
    confidence: typeof s.confidence === "number" ? s.confidence : Number(s.confidence) || 0,
    reasoning: String(s.reasoning ?? ""),
  }));

  const reportFromApi = typeof o.report === "string" ? o.report.trim() : "";
  const report =
    reportFromApi ||
    buildClientTeamReport(ticker, fusedSignal, fusedConfidence, breakdown, Boolean(o.debateTriggered));

  const debate = o.debate && typeof o.debate === "object" ? (o.debate as AnalystTeamResult["debate"]) : undefined;
  const risk = o.risk && typeof o.risk === "object" ? (o.risk as AnalystTeamResult["risk"]) : undefined;

  return {
    fusionId,
    ticker,
    fusedSignal,
    fusedConfidence,
    debateTriggered,
    breakdown,
    report,
    debate,
    risk,
  };
}

export function buildClientTeamReport(
  ticker: string,
  fusedSignal: AnalystSignalValue,
  fusedConfidence: number,
  breakdown: AnalystTeamResult["breakdown"],
  debateTriggered: boolean
): string {
  const emoji: Record<AnalystSignalValue, string> = { buy: "📈", sell: "📉", hold: "⏸️" };
  const lines = [
    `## ${ticker} 研究团队结论（数据库回放）`,
    "",
    `**综合结论**：${emoji[fusedSignal]} **${fusedSignal.toUpperCase()}**（置信度：${(fusedConfidence * 100).toFixed(0)}%）`,
    debateTriggered ? "⚠️ 曾触发低置信度辩论条件（详见下方 Agent Chat 回放）" : "✅ 融合置信度未触发辩论阈值",
    "",
    "### 各分析师分项",
  ];
  for (const s of breakdown) {
    lines.push(`- **${s.role}**：${emoji[s.signal]} ${s.signal.toUpperCase()}（${(s.confidence * 100).toFixed(0)}%）`);
    lines.push(`  > ${s.reasoning.slice(0, 220)}`);
  }
  return lines.join("\n");
}
