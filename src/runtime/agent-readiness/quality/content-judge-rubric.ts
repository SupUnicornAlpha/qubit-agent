/**
 * LLM-as-Judge rubric prompt 模板。
 *
 * 设计原则：
 *   - 强约束 JSON schema 输出，避免后处理脏字符串
 *   - 5 维 1-5 分，独立打分；overall 自动平均（不让 LLM 自己算，避免它"加权"）
 *   - 不让 judge 看其它产物，防止跨样本相互影响
 */

export const CONTENT_JUDGE_SYSTEM_PROMPT = `你是金融 Agent 输出质量评审员。

任务：给定一段 Agent 产出（研究、推荐、因子、策略或交易决策），按以下 5 维 rubric 打分（1=很差，5=优秀）。

**Rubric**:
1. **data_grounding**（数据支撑）：是否引用具体业绩 / 价格 / 新闻 / 财报数据点。空洞断言扣分。
2. **quantification**（量化指标）：是否给出可计算的指标（IC、Sharpe、累计收益、相关系数等）。
3. **reasoning_chain**（推理链）：从数据到结论的链条是否完整可追溯。
4. **citations**（引用清晰度）：来源是否明确（"根据 Q3 财报"、"参考 IBM 论文"等）。
5. **risk_awareness**（风险考量）：是否承认不确定性 / 给出反向场景 / 提示风控。

**输出**：必须是合法 JSON，schema：
{
  "scores": {
    "data_grounding": <1-5>,
    "quantification": <1-5>,
    "reasoning_chain": <1-5>,
    "citations": <1-5>,
    "risk_awareness": <1-5>
  },
  "issues": [<最多 3 条简短问题描述>],
  "overall": <自动算 = 5 维均值，保留 1 位小数>
}

不要解释、不要 markdown、不要包裹代码块。直接输出 JSON。`;

export interface JudgeScore {
  scores: {
    data_grounding: number;
    quantification: number;
    reasoning_chain: number;
    citations: number;
    risk_awareness: number;
  };
  issues: string[];
  overall: number;
}

/** 解析 judge 返回的字符串；失败返回 null（不抛错，让上层 fallback） */
export function parseJudgeResponse(raw: string): JudgeScore | null {
  // judge 偶尔仍会带 markdown ```json fence；先剥离
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/i, "")
    .trim();
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const scoresRaw = o.scores;
  if (!scoresRaw || typeof scoresRaw !== "object") return null;
  const s = scoresRaw as Record<string, unknown>;
  const dim = (k: string): number => {
    const v = Number(s[k]);
    if (!Number.isFinite(v)) return 0;
    return Math.min(5, Math.max(1, Math.round(v)));
  };
  const scores = {
    data_grounding: dim("data_grounding"),
    quantification: dim("quantification"),
    reasoning_chain: dim("reasoning_chain"),
    citations: dim("citations"),
    risk_awareness: dim("risk_awareness"),
  };
  const overall = Number(
    (
      (scores.data_grounding +
        scores.quantification +
        scores.reasoning_chain +
        scores.citations +
        scores.risk_awareness) /
      5
    ).toFixed(2)
  );
  const issuesRaw = Array.isArray(o.issues) ? o.issues : [];
  const issues = issuesRaw
    .filter((i): i is string => typeof i === "string")
    .slice(0, 5);
  return { scores, issues, overall };
}

/** 给定场景 + 产物，构造 judge 输入字符串（保证产物 ≤2K token） */
export function buildJudgeUserPrompt(scenario: string, artifactKind: string, artifact: unknown): string {
  let serialized = "";
  try {
    serialized = JSON.stringify(artifact, null, 2);
  } catch {
    serialized = String(artifact);
  }
  // 简单截断：4 KB ≈ 1K token
  if (serialized.length > 4096) {
    serialized = serialized.slice(0, 4000) + "\n... (truncated)";
  }
  return [
    `场景：${scenario}`,
    `产物类型：${artifactKind}`,
    "",
    "=== 产物内容 ===",
    serialized,
    "",
    "=== 你的评分 ===",
    "请严格按 system prompt 中的 JSON schema 输出。",
  ].join("\n");
}
