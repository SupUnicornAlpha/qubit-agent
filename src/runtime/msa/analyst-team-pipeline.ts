import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { BacktestConnector } from "../../connectors/backtest/backtest.connector";
import { connectorRegistry } from "../../connectors/registry";
import { runSmaCrossoverBacktestJob } from "../market/backtest-job-runner";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentGroupMember,
  agentInstance,
  agentStep,
  analystSignal,
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
import {
  HITL_HINT_DELIMITER,
  parsePlanWithHitlHint,
  type OrchestratorHitlHint,
  type OrchestratorPlanResult,
} from "../workflow/hitl-hint-parse";
import { partitionSlotsIntoWaves, parseTeamRelations, type TeamRelationEdge } from "./analyst-team-topology";

/**
 * 历史这里直接定义了 hitlHint 的协议（分隔符 + parse + 类型）；现在被对话 orchestrator
 * 也复用，所以挪到 `runtime/workflow/hitl-hint-parse.ts` 统一管理。这里只 re-export
 * 旧名字，避免破坏既有 import；后续逻辑（含单测）一切照旧。
 */
export type { OrchestratorHitlHint, OrchestratorPlanResult };
export { HITL_HINT_DELIMITER, parsePlanWithHitlHint };

export type AnalystTeamSlot = {
  role: AgentRole;
  definitionId: string;
  systemPrompt: string;
};

export const POST_FUSION_AUX_ROLES = new Set<AgentRole>(["research", "backtest", "risk"]);

const TOPOLOGY_ROLES_WITH_ORCHESTRATOR: readonly AgentRole[] = [
  "orchestrator",
  "market_data",
  "news_event",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
  "research",
  "backtest",
  "risk",
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
  /**
   * 编排器对"是否触发 Bull/Bear 辩论"的显式表态。
   *   - `true`  → 强制辩论（即使置信度高）
   *   - `false` → 强制跳过辩论（即使置信度低于阈值）
   *   - `null` / 未给出 → 沿用置信度阈值兜底
   *
   * 设计动机：辩论 SDP 本来是给「分析师之间观点显著分歧」准备的，但
   * 原先实现只看 fusedConfidence 阈值就触发，导致：
   *   1. 策略专岗编组（grp-strategy-pipeline）没有 MSA 分析师，breakdown 为空，
   *      却依然机械触发 bull/bear（无对手可辩 → 纯空跑）
   *   2. 用户明确不需要时也无法关闭
   * 把决策权交给 Orchestrator，让它根据当前 task 类型与 breakdown 是否真分歧
   * 来决定。
   */
  shouldDebate?: boolean | null;
  /** 辩论决策的人类可读理由（无论 true/false 都建议带上，便于日志/UI 解释） */
  debateReason?: string;
}

/**
 * 是否触发 Bull/Bear 辩论的最终判定逻辑（纯函数，便于单测）。
 *
 * 判定优先级（由高到低）：
 *   1. **硬守门**：`signalBreakdown.length < 2` → 强制不辩。
 *      bull/bear 需要至少 2 个不同来源的分析师意见，否则没有对手可辩论。
 *      策略专岗编组（无 MSA 分析师）走这条路径。
 *   2. **Orchestrator 显式表态**：`orchestratorDecision.shouldDebate` 为 boolean → 直接采用。
 *      把话语权交给 Orchestrator，避免阈值机械触发。
 *   3. **默认置信度阈值**：兜底 `fusedConfidence < confidenceThreshold`。
 */
export interface DecideDebateInput {
  fusedConfidence: number;
  signalBreakdownCount: number;
  orchestratorDecision: OrchestratorDecision | null;
  confidenceThreshold: number;
}

export interface DecideDebateResult {
  shouldDebate: boolean;
  reason: string;
  source: "hard_guard" | "orchestrator" | "confidence_threshold";
}

export function decideShouldDebate(input: DecideDebateInput): DecideDebateResult {
  if (input.signalBreakdownCount < 2) {
    return {
      shouldDebate: false,
      reason: `signal_breakdown<2: 仅 ${input.signalBreakdownCount} 个分析师产出，无对立观点可辩论`,
      source: "hard_guard",
    };
  }
  const orch = input.orchestratorDecision;
  if (orch && typeof orch.shouldDebate === "boolean") {
    return {
      shouldDebate: orch.shouldDebate,
      reason: orch.debateReason
        ? `orchestrator_decision: ${orch.debateReason}`
        : `orchestrator_decision: ${orch.shouldDebate ? "强制辩论" : "强制跳过"}`,
      source: "orchestrator",
    };
  }
  const triggered = input.fusedConfidence < input.confidenceThreshold;
  return {
    shouldDebate: triggered,
    reason: triggered
      ? `confidence_threshold: fused=${(input.fusedConfidence * 100).toFixed(0)}% < threshold=${(input.confidenceThreshold * 100).toFixed(0)}%`
      : `confidence_threshold: fused=${(input.fusedConfidence * 100).toFixed(0)}% >= threshold=${(input.confidenceThreshold * 100).toFixed(0)}%`,
    source: "confidence_threshold",
  };
}

/** 从 Orchestrator 全量简报中截取 `## <role>` 段落；若无则回退通用段 + 角色提示 */
export function extractRoleBriefSection(fullBrief: string, role: AgentRole): string {
  const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(
    `(?:^|\\n)##\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    "i"
  );
  const m = fullBrief.match(sectionRe);
  if (m?.[1]?.trim()) {
    return `## 你的角色：${role}\n\n${m[1].trim()}`;
  }
  /**
   * 2026-05-26 复盘：旧 fallback 把整段 brief（≤2800 字）抄给每个角色 → 数据库
   * 里 4 个分析师收到的"任务说明"前 2800 字一字不差，前端 UI 看起来就像
   * "Orchestrator 给所有人发了同一条消息"。
   *
   * 新 fallback：只透传 brief 开头（通用前言，≤800 字）+ 一段**角色专属脚手架**，
   * 让每个角色拿到的 brief 即使没有 LLM 生成的小节也是差异化的。脚手架明确写明
   * 该角色的职责边界、可用工具方向、不要做什么，避免角色之间互相代劳。
   */
  const intro = fullBrief.split(/\n##\s/m)[0]?.trim() ?? "";
  const truncatedIntro = intro.slice(0, 800);
  const scaffold = buildRoleScaffold(role);
  return [
    truncatedIntro,
    truncatedIntro ? "---" : "",
    `## 你的角色：${role}`,
    `（注：Orchestrator 简报未单独列出本角色小节，以下为系统补全的角色任务脚手架）`,
    "",
    scaffold,
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

/**
 * 角色专属任务脚手架。Orchestrator 没产出 per-role 段落时由系统兜底注入。
 * 关键点：每个角色拿到的文本必须**显著不同**（否则 4 个分析师又会跑一样的路径）。
 */
function buildRoleScaffold(role: AgentRole | string): string {
  const r = role as string;
  if (r === "analyst_fundamental") {
    return [
      "**职责**：盈利质量 + 估值偏离 + 资产负债表健康度。",
      "**工具方向**：fetch_fundamentals → compute_valuation → fetch_financial_data。",
      "**不要做**：技术指标 / 情绪 / 宏观（其它角色负责）。",
      "**交付**：一段 JSON 信号 `{signal:'buy|sell|hold', confidence:0-1, reasoning:'...'}`。",
    ].join("\n");
  }
  if (r === "analyst_technical") {
    return [
      "**职责**：价格结构、动量、波动率、关键支撑/阻力位。",
      "**工具方向**：fetch_klines → compute_indicators（RSI/MACD/ATR）→ factor.list。",
      "**不要做**：基本面估值 / 新闻情绪 / 宏观（其它角色负责）。",
      "**交付**：一段 JSON 信号 `{signal:'buy|sell|hold', confidence:0-1, reasoning:'...'}`。",
    ].join("\n");
  }
  if (r === "analyst_sentiment") {
    return [
      "**职责**：新闻情绪、社媒热度、机构持仓变化、做空利息。",
      "**工具方向**：fetch_news_sentiment → analyze_social_media → score_sentiment。",
      "**不要做**：估值计算 / K 线技术分析（其它角色负责）。",
      "**交付**：一段 JSON 信号 `{signal:'buy|sell|hold', confidence:0-1, reasoning:'...'}`。",
    ].join("\n");
  }
  if (r === "analyst_macro") {
    return [
      "**职责**：宏观 regime（利率 / 通胀 / 风险偏好）、行业 beta、跨市场相关性。",
      "**工具方向**：fetch_macro_data → compute_macro_indicators → fetch_klines（指数对比）。",
      "**不要做**：单标的基本面 / 技术指标 / 公司层情绪（其它角色负责）。",
      "**交付**：一段 JSON 信号 `{signal:'buy|sell|hold', confidence:0-1, reasoning:'...'}`。",
    ].join("\n");
  }
  if (r === "research") {
    return [
      "**职责**：综合各分析师结论，输出量化研究假设 + 可回测的因子/规则草案。",
      "**工具方向**：search_memory → factor.register → factor.compute → factor.autoEvaluate。",
      "**调用顺序约束**：autoEvaluate 之前必须先 register + compute，否则会报 no_factor_values。",
      "**交付**：Markdown 研究纪要 + 至少 1 个 `active` 状态因子（或写明为何无法产出）。",
    ].join("\n");
  }
  if (r === "backtest") {
    return [
      "**职责**：将 research 给的策略草案转为可执行回测，产出指标与稳健性结论。",
      "**工具方向**：先 strategy.publish_version（拿到 strategy_version_id），再 backtest.run。",
      "**调用顺序约束**：backtest.run 必须显式带 strategy_version_id，否则会报 required 错误。",
      "**交付**：Markdown 回测纪要（含 Sharpe / MaxDD / 胜率）+ 至少 1 条 backtest_run。",
    ].join("\n");
  }
  if (r === "risk") {
    return [
      "**职责**：规则签核 + 组合层面风险审查（集中度、流动性、杠杆、合规）。",
      "**工具方向**：load_rules → check_concentration → assess_liquidity → evaluate_risk。",
      "**否决权**：发现硬约束违反时必须返回 `veto`，让 orchestrator 中断或调整。",
      "**交付**：Markdown 风险报告 + 明确的通过 / 否决结论。",
    ].join("\n");
  }
  return `请仅完成 **${role}** 职责范围内的工作，使用授权工具，最后给出 Markdown 小结。`;
}

/** 运行前：Orchestrator 阅读数据快照并生成对各角色的任务说明 + v2 HITL 自评。 */
export async function runOrchestratorPlanning(input: {
  workflowRunId: string;
  ticker: string;
  slotRoles: AgentRole[];
  dataAndUserContext: string;
  orchestrator: AnalystTeamSlot;
}): Promise<OrchestratorPlanResult> {
  const modelConfig = (await loadModelConfig()) ?? {
    provider: "mock" as const,
    model: "mock-orchestrator",
    apiKey: "",
  };
  const targets = input.slotRoles.filter((r) => r !== "orchestrator").join("、");
  const userPrompt = `你是研究团队 Orchestrator。标的：${input.ticker}
参与角色：${targets}

请阅读下方数据与用户背景，输出 **Markdown 任务简报**（不要 JSON），包含：
1. 开篇：本轮研究重点与待回答问题（通用，≤15 行）
2. **对每个参与角色单独一节**，标题必须为 \`## <role>\`（role 使用英文角色 id，如 analyst_fundamental、research、backtest、risk），节内只写该角色本回合要做什么、调用哪些工具、交付什么
3. 要求：在引用下方数据快照前提下再下结论，信息不足时明确写「需补充」

**【HITL 自评 — 必带】** 在 Markdown 简报结束后，**必须**追加分隔符 \`${HITL_HINT_DELIMITER}\` 与一段 JSON：
\`\`\`
${HITL_HINT_DELIMITER}
{"needed": false, "reason": "短句说明为什么（不）需要人工", "inputKind": "approve_only", "options": []}
\`\`\`

判定依据（needed 何时 = true）：
- 计划涉及做空、杠杆、衍生品或非常规策略组合
- 标的属于你不熟悉/数据匮乏的领域，置信度低
- 用户原始意图含糊，存在多种合理执行路径需要用户选
- 数据快照中出现风险信号（如近期大幅波动 / 财报临近 / 监管事件）

inputKind 选择：
- "approve_only"：你确信路径但希望用户确认 → 提供原因即可
- "single_choice"：有 2-4 条合理路径，让用户选一条 → 必带 options=[{label,value}]
- "free_form"：需要用户给一句话指引 → options 为空
- "multi_choice"：让用户勾选要包含/排除的角色或步骤 → 必带 options

如确信无需人工，输出 \`{"needed": false, "reason": "常规多头 + 4 个标准分析师", "inputKind": "approve_only"}\` 即可。

---
${input.dataAndUserContext}`;

  /**
   * 注入同 workflow 历史产出：让 Orchestrator 看到第一波 research/backtest/risk 已经
   * 做了什么，避免第二波重启时回到"标的池未知 → 死循环"。
   * 空字符串表示首次 planning，不会膨胀 prompt。
   */
  const priorOutputs = await buildWorkflowPriorOutputsContext(input.workflowRunId);
  const enrichedUserPrompt = priorOutputs
    ? `${userPrompt}\n\n---\n\n${priorOutputs}`
    : userPrompt;

  let answer = "";
  try {
    const result = await runLlmGateway({
      config: modelConfig,
      systemPrompt: input.orchestrator.systemPrompt,
      userPrompt: enrichedUserPrompt,
      onToken: () => {},
    });
    answer = result.answer;
  } catch (e) {
    answer = `（编排计划生成失败：${e instanceof Error ? e.message : String(e)}）`;
  }
  const parsed = parsePlanWithHitlHint(answer);
  for (const role of input.slotRoles) {
    if (role === "orchestrator") continue;
    const roleBrief = extractRoleBriefSection(parsed.brief, role).slice(0, 4000);
    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: "orchestrator",
      toRole: role,
      kind: "llm_message",
      contentText: roleBrief,
      payloadJson: {
        phase: "orchestrator_plan",
        ticker: input.ticker,
        targetRole: role,
        priorOutputsInjected: priorOutputs.length > 0,
      },
    });
  }
  return parsed;
}

/** MSA 之后：Orchestrator 汇总并给出买/卖/观望与是否进入策略阶段 */
export async function runOrchestratorDecision(input: {
  workflowRunId: string;
  ticker: string;
  orchestrator: AnalystTeamSlot;
  fusionSummary: string;
  msaSignal: AnalystSignalValue;
  msaConfidence: number;
  /**
   * 2026-05-27 P2 加固：实际产出**合法 signal** 的分析师角色清单（来自 fusion 的 signalBreakdown）。
   * 用于硬约束 LLM 的 reasoning —— 不允许编造未签到角色的观点。
   */
  attendedRoles?: AgentRole[];
  /**
   * 实际签到但**未给出 signal**（或 signal_parse_failed）的分析师角色清单。
   * 用于在 prompt 里明示哪些角色"缺席"，避免 LLM 把它们的"沉默"误读为"中性"或编造观点。
   */
  missingRoles?: AgentRole[];
}): Promise<OrchestratorDecision> {
  const modelConfig = (await loadModelConfig()) ?? {
    provider: "mock" as const,
    model: "mock-orchestrator",
    apiKey: "",
  };

  /**
   * 把"实际签到清单"作为 hard fact 拼进 prompt，是这次 P2 修复的核心 —— 否则
   * LLM 在零信号/部分签到场景会编造"四维信号"或"情绪/宏观维度认为..."等
   * 不存在的观点（WF a09e90c5 实测）。
   */
  const attended = input.attendedRoles ?? [];
  const missing = input.missingRoles ?? [];
  const attendanceBlock =
    attended.length === 0 && missing.length === 0
      ? ""
      : [
          "",
          "## 本轮签到事实（**严禁伪造**）",
          attended.length > 0
            ? `- ✅ 实际产出合法 signal 的分析师：${attended.join("、")}（仅这些维度有发言权）`
            : "- ⚠️ **没有任何分析师产出合法 signal**（signal_parse_failed 或未签到）",
          missing.length > 0
            ? `- ❌ 缺席 / signal_parse_failed：${missing.join("、")}（**不得在 reasoning 中引用这些角色的观点**）`
            : "",
          "",
          "硬约束：",
          "1. reasoning 只能引用上面 ✅ 角色的实际产出。**禁止**写「情绪面如何」「宏观面如何」等若这些角色未在签到列表。",
          "2. 若 ✅ 角色为 0，直接给 `signal=hold, confidence<=0.4, proceedToStrategy=false, shouldDebate=false`，",
          "   reasoning 说明「本轮无有效信号、建议补充至少 2 个分析师后重跑」，**不要**伪造任何分析叙事。",
          "3. 不得编造数字（如「+74% RSI 71」），所有数字必须能在下方 fusionSummary 中溯源。",
        ]
          .filter((s) => s.length > 0 || s === "")
          .join("\n");

  const userPrompt = `标的：${input.ticker}
MSA 融合信号：${input.msaSignal}（置信度 ${(input.msaConfidence * 100).toFixed(0)}%）
${attendanceBlock}

请阅读各分析师与融合报告，输出 **唯一一段 JSON**：
{"signal":"buy|sell|hold","confidence":0.0-1.0,"reasoning":"…","proceedToStrategy":true|false,"shouldDebate":true|false|null,"debateReason":"…"}

- proceedToStrategy：仅当信息充分且值得生成可回测策略时为 true
- shouldDebate：是否需要触发 Bull/Bear 辩论 SDP
    * true  → 分析师之间存在显著分歧（如 bull 与 bear 信号、置信度差>30%）或单边证据不足
    * false → 信号一致 / 数据充分 / 单边证据明显 / 仅做策略落地无需辩论
    * null  → 没明确意见，交由系统按置信度阈值默认判定
  注意：辩论本身耗时 1-3 分钟且会消耗大量 token，没有真分歧时**应明确给 false**。
- debateReason：辩论决策的简短说明（≤ 50 字），无论选 true/false/null 都建议带上。

---
${input.fusionSummary}`;

  let answer = "";
  try {
    const result = await runLlmGateway({
      config: modelConfig,
      systemPrompt: input.orchestrator.systemPrompt,
      userPrompt,
      onToken: () => {},
    });
    answer = result.answer;
  } catch (e) {
    return {
      signal: input.msaSignal,
      confidence: input.msaConfidence,
      reasoning: `Orchestrator 决策失败，沿用 MSA：${(e as Error).message}`,
      proceedToStrategy: input.msaConfidence >= 0.5,
      shouldDebate: null,
      debateReason: "orchestrator_llm_failed: 沿用默认阈值判定",
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

  /**
   * shouldDebate 容忍三种语义：
   *   - boolean → 直接采用
   *   - null    → 显式表示"没意见，走默认"
   *   - 字段缺失 → 同 null
   * 避免把"模型忘了写"和"模型明确说 false"混为一谈。
   */
  let shouldDebate: boolean | null = null;
  if (typeof parsed["shouldDebate"] === "boolean") {
    shouldDebate = parsed["shouldDebate"];
  } else if (parsed["shouldDebate"] === null) {
    shouldDebate = null;
  }
  const debateReason =
    typeof parsed["debateReason"] === "string" && parsed["debateReason"].trim().length > 0
      ? parsed["debateReason"].trim().slice(0, 200)
      : undefined;

  await logResearchTeamInteraction({
    workflowRunId: input.workflowRunId,
    fromRole: "orchestrator",
    toRole: "msa",
    kind: "llm_message",
    contentText: `[Orchestrator 决策] ${signal} ${(confidence * 100).toFixed(0)}% — ${reasoning.slice(0, 3500)}`,
    payloadJson: {
      phase: "orchestrator_decision",
      proceedToStrategy,
      shouldDebate,
      ...(debateReason ? { debateReason } : {}),
    },
  });

  return {
    signal,
    confidence,
    reasoning,
    proceedToStrategy,
    shouldDebate,
    ...(debateReason ? { debateReason } : {}),
  };
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
  const chain: AgentRole[] = ["research", "backtest", "risk"];
  let prev: AgentRole | null = null;
  for (const r of chain) {
    if (!roles.has(r)) continue;
    if (prev) edges.push({ from: prev, to: r });
    prev = r;
  }
  return edges;
}

/**
 * Orchestrator 开场广播。
 *
 * 2026-05-26 复盘：旧实现给每个目标角色都复制一份完全相同的 plan，仅追加"你的角色：X"
 * 一行 —— 数据库里每个 workflow 出现 6+ 条几乎雷同的 llm_message，UI 里"Orchestrator
 * 把同样的话又说了一遍"造成"消息串台"的错觉。
 *
 * 新实现只发**一条** kickoff 广播，from=orchestrator → to='__team__'，含一份明确的
 * targetRoles 列表；前端在拓扑画布里显示一条"全员广播"边即可。差异化的 brief
 * 由 `runOrchestratorPlanning` 真正按角色生成。
 */
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
  const filteredTargets = targets.filter((r) => r !== "orchestrator");
  if (filteredTargets.length === 0) return;

  const plan = [
    `【Orchestrator 编排】研究团队任务已启动`,
    `标的：${input.ticker}`,
    `参与槽位：${input.slotRoles.join("、")}`,
    `广播对象：${filteredTargets.join("、")}`,
    `流程：分析师并行 → MSA 融合 → 策略撰写 → 回测执行 → 风控复核`,
    `（详细按角色任务由后续 plan 简报下发，避免重复转发）`,
  ].join("\n");

  await logResearchTeamInteraction({
    workflowRunId: input.workflowRunId,
    fromRole: "orchestrator",
    toRole: "__team__",
    kind: "llm_message",
    contentText: plan,
    payloadJson: {
      phase: "kickoff",
      ticker: input.ticker,
      targetRoles: filteredTargets,
      fanout: filteredTargets.length,
    },
  });
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

  /**
   * 2026-05-27 P3：分析师全部缺席 / proceedToStrategy=false 时不再直接放弃。
   * 若 auxSlots 含 research，跑一次"explore fallback"产出**候选因子方向草稿**
   * （不写 strategy_script，不跑 backtest，不跑 risk）。这样即使分析师全 fail，
   * 研究 pipeline 也能给出可执行的下一步建议（如"建议研究反转因子 X+Y 组合"），
   * 而不是输出空报告让用户花了 5 分钟 250k token 还啥都没拿到（WF a09e90c5 实测）.
   */
  if (orch && !orch.proceedToStrategy) {
    const researchSlot = input.auxSlots.find((s) => s.role === "research");
    if (researchSlot) {
      const fallbackCtx = [
        input.fusionReport,
        "",
        `MSA 结论：${input.fusedSignal}（置信度 ${(input.fusedConfidence * 100).toFixed(0)}%）`,
        "",
        `Orchestrator 汇总决策：${orch.signal}（${(orch.confidence * 100).toFixed(0)}%）`,
        orch.reasoning,
        "→ Orchestrator 判断信息不足，**不要**输出可执行策略代码。",
        "",
        "## explore fallback 任务",
        "本轮分析师未产出合法信号 / 信息不足。请**改做候选研究方向草稿**：",
        "1. 基于现有数据快照（不要凭空臆造），列 3-5 个**值得下一轮深挖**的因子方向，",
        "   每条注明：因子名 + 数据依赖（要拉哪些 connector）+ 检验指标（IC / RankIC / 分组收益）+ 预计耗时。",
        "2. 列 1-2 个**值得追加**的分析师角色（如缺技术分析建议加 analyst_technical），并给出理由。",
        "3. **不要**写 Python 代码块、不要写策略实现，仅输出方向性建议。下游 backtest / risk 本轮跳过。",
      ].join("\n");
      const draftBody = await input.runAuxLlm(researchSlot, fallbackCtx);
      await logResearchTeamInteraction({
        workflowRunId: input.workflowRunId,
        fromRole: "research",
        toRole: "orchestrator",
        kind: "llm_message",
        contentText: `[explore fallback] ${draftBody.slice(0, 3000)}`,
        payloadJson: { phase: "research_explore_fallback", noStrategy: true },
      });
      return {
        auxSections: [
          {
            role: "research",
            body: [
              `Orchestrator 判断暂不进入策略/回测阶段，已切到 explore fallback 模式输出研究方向草稿。`,
              ``,
              orch.reasoning,
              ``,
              `### 候选研究方向草稿`,
              ``,
              draftBody,
            ].join("\n"),
          },
        ],
      };
    }
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
  /**
   * P0-2 handoff：累积已跑完的角色 body，作为下一个角色的额外 context。
   *
   * 之前实现把同一份 `fusionCtx` 喂给每个 aux slot，slot 之间无传递：
   *   - backtest 跑的时候完全看不到 research 实际写了什么策略草案
   *   - risk 跑的时候完全看不到 backtest 的指标
   * 结果在 DB 里看到的就是"每个角色独立从 fusion 报告再推一遍"，浪费 token
   * 且产出之间无依赖（research 推荐 NVDA 动量，backtest 自己又选了 LMT）。
   *
   * 现在把上游 body 截断后塞进下一个 slot 的 context，让链路真正串起来。
   */
  const handoffSections: Array<{ role: AgentRole; body: string }> = [];

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

    const handoffBlock = formatHandoffSections(handoffSections);
    let body = await input.runAuxLlm(slot, `${fusionCtx}${handoffBlock}${extra}`);

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
    handoffSections.push({ role: slot.role, body });

    /**
     * 这条 interaction 记录的是 **当前 slot 跑完后的输出 body**。
     * 历史 bug：fromRole 写成 prevRole，于是 DB 里出现 "research → backtest" 但
     * content 实际是 backtest 的输出，前端拓扑画布把 backtest 的论述错误归到 research，
     * 也导致 buildWorkflowPriorOutputsContext 用 from_role 过滤时拿不到正确的角色产出。
     * 正确语义：本轮 slot.role 把成果汇报给 msa（后续 fuseSignals / report 阶段）。
     */
    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: slot.role,
      toRole: "msa",
      kind: "llm_message",
      contentText: body.slice(0, 4000),
      payloadJson: { phase: "post_fusion", role: slot.role },
    });

    prevRole = slot.role;
  }

  return { auxSections, strategyScriptId, backtestSummary };
}

/**
 * 把上游角色的 body 累积成一段标准 handoff 段落注入下一个 slot 的 context。
 *
 * 截断策略：单角色 body 最多 4000 字（防止整体 prompt 爆掉 token 上限），
 * 同时保留最后产出（research 的策略代码 / backtest 的指标）这些"决策依据"。
 *
 * 导出以便单测覆盖 handoff 拼接格式 / 截断逻辑。
 */
export function formatHandoffSections(
  sections: Array<{ role: AgentRole; body: string }>
): string {
  if (sections.length === 0) return "";
  const blocks = sections.map((s) => {
    const trimmed = s.body.trim();
    const max = 4000;
    const clipped =
      trimmed.length > max
        ? `${trimmed.slice(0, max)}\n\n（...为节省 token 已截断，完整 body 见数据库 research_team_interaction 表）`
        : trimmed;
    return `### 来自 ${s.role}\n\n${clipped}`;
  });
  return [
    "",
    "",
    "## 上游角色已产出（请基于此推进，不要重复造）",
    "",
    blocks.join("\n\n"),
    "",
    "**重要**：以上是本工作流内、当前 fusion 之后已运行完的角色产出。请你直接消费这些信息（如 research 已推荐的标的 / 因子 / 策略草案），不要重新选标的、不要重新构造因子。",
  ].join("\n");
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

/**
 * 同一 workflow_run 内的"已跑产出摘要"。
 *
 * 解决用户反馈"workflow d0a41743 第二波 orchestrator 重启时丢失第一波 context"：
 *   - 第一波 research 已经 fetch_klines(NVDA) 拿了 80 个交易日 + factor.compute(momentum_20)
 *   - 但第二波 orchestrator 派的简报却说"标的池未知，无行情数据 → 死循环"
 *
 * 这是因为 orchestrator planning 阶段 prompt 只看 `dataAndUserContext`（系统自动快照
 * + 用户原始 prompt），没看本 workflow 已有的 step / signal / strategy。
 *
 * 这个 helper 从 DB 拉同 workflow 已落库的产出（agent_step reason 末态 / analyst_signal /
 * strategy_script），拼成一段 Markdown 注入到 planning 上下文里。
 *
 * 返回空字符串表示"无历史产出"——首次 planning 不会额外膨胀 prompt。
 */
export async function buildWorkflowPriorOutputsContext(
  workflowRunId: string
): Promise<string> {
  const db = await getDb();

  const [signals, scripts, lastSteps] = await Promise.all([
    db
      .select()
      .from(analystSignal)
      .where(eq(analystSignal.workflowRunId, workflowRunId))
      .orderBy(desc(analystSignal.createdAt))
      .limit(20),
    db
      .select()
      .from(indicatorStrategyScript)
      .where(eq(indicatorStrategyScript.workflowRunId, workflowRunId))
      .orderBy(desc(indicatorStrategyScript.createdAt))
      .limit(5),
    /**
     * 取每个 agent_instance 最后一条 reason 阶段 thought。"最后一条 reason" 通常
     * 是该实例的总结性思考，比 act/observe 阶段更有信息量。
     * 限制 16 条避免 prompt 膨胀。
     */
    db
      .select({
        thought: agentStep.thought,
        createdAt: agentStep.createdAt,
        definitionId: agentInstance.definitionId,
        instanceId: agentInstance.id,
      })
      .from(agentStep)
      .innerJoin(agentInstance, eq(agentInstance.id, agentStep.agentInstanceId))
      .where(
        and(
          eq(agentStep.workflowRunId, workflowRunId),
          eq(agentStep.phase, "reason")
        )
      )
      .orderBy(desc(agentStep.createdAt))
      .limit(64),
  ]);

  if (signals.length === 0 && scripts.length === 0 && lastSteps.length === 0) {
    return "";
  }

  /** 把 step 按 instanceId 去重，每个 instance 仅取最新一条 reason thought */
  const seenInstances = new Set<string>();
  const lastReasonPerInstance: Array<{
    instanceId: string;
    definitionId: string;
    thought: string;
    createdAt: string;
  }> = [];
  for (const step of lastSteps) {
    if (seenInstances.has(step.instanceId)) continue;
    seenInstances.add(step.instanceId);
    if (step.thought && step.thought.trim().length > 0) {
      lastReasonPerInstance.push({
        instanceId: step.instanceId,
        definitionId: step.definitionId,
        thought: step.thought.trim(),
        createdAt: step.createdAt,
      });
    }
    if (lastReasonPerInstance.length >= 6) break;
  }

  /** definitionId → role 映射，避免一次 N+1 查询 */
  const defIds = [...new Set(lastReasonPerInstance.map((r) => r.definitionId))];
  const defs =
    defIds.length > 0
      ? await db
          .select({ id: agentDefinition.id, role: agentDefinition.role, name: agentDefinition.name })
          .from(agentDefinition)
          .where(
            defIds.length === 1
              ? eq(agentDefinition.id, defIds[0]!)
              : inArray(agentDefinition.id, defIds)
          )
      : [];
  const defMap = new Map(defs.map((d) => [d.id, { role: d.role, name: d.name }]));

  const lines: string[] = [
    "## 本工作流已跑历史产出（请直接消费，不要重复劳动）",
    "",
  ];

  if (signals.length > 0) {
    lines.push("### 已落库分析师信号");
    for (const s of signals.slice(0, 8)) {
      const reasoning = (s.reasoning ?? "").trim().slice(0, 160);
      lines.push(
        `- [${s.analystRole}] ticker=${s.ticker} signal=${s.signal} confidence=${(s.confidence * 100).toFixed(0)}% — ${reasoning}`
      );
    }
    lines.push("");
  }

  if (scripts.length > 0) {
    lines.push("### 已发布策略脚本");
    for (const sc of scripts) {
      const codeHead = (sc.signalCode ?? "").trim().slice(0, 200).replace(/\n/g, " ");
      lines.push(
        `- id=${sc.id} name=${sc.name} purpose=${sc.purpose} code≈"${codeHead}..."`
      );
    }
    lines.push("");
  }

  if (lastReasonPerInstance.length > 0) {
    lines.push("### 各角色最后一次思考摘要（按时间倒序）");
    for (const r of lastReasonPerInstance) {
      const meta = defMap.get(r.definitionId);
      const role = meta?.role ?? "unknown";
      const head = r.thought.slice(0, 600);
      lines.push(`#### ${role} @ ${r.createdAt}`, "", head, "");
    }
  }

  lines.push(
    "**关键约束**：",
    "1. 如果上面信号 / 策略 / 思考里已经选定标的池，请**直接采用**，不要再说'标的池未知 → 无法执行'。",
    "2. 如果上一波 research 已经 register / compute 过某些因子，下一波 research 不要重新造同名因子，**复用即可**。",
    "3. 如果某个 role 的最后思考是'数据不足'但其他 role 已经拉到数据，请把数据传递路径明确写到本轮简报里。"
  );

  return lines.join("\n");
}
