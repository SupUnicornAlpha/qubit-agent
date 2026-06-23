/**
 * MSA × ReAct 边界 ADR（P2-C 定型）：
 *
 * 选定方案：**B - Batch LLM Job**。
 *
 * 含义：MSA 团队协调（fan-out → wait → fuse）是一个"批调度协调层"，
 * 每个 analyst slot 是一个独立的 ReAct loop（本文件就是这个 ReAct loop
 * 的封装入口）。Slot 之间不共享 LangGraph state；并行执行由
 * `analyst-team.ts:Promise.allSettled` 做。
 *
 * 拒绝方案：A - LangGraph subgraph（即把 MSA fan-out 实现为 LangGraph
 * 的 subgraph 节点）。理由：
 *   1. LangGraph 的 subgraph 嵌套需要为每个 slot hash 子图、共享
 *      checkpointer，资源开销显著且会让 timeline / 监控复杂度爆炸；
 *   2. MSA 的核心价值是"独立观点 + 后置融合"，slot 之间本就不该共享
 *      state — subgraph 强行共享反而破坏独立性；
 *   3. 已经走通的 B 方案已支撑 P0/P1/P2 全部稳定性需求，没有抓痒不到的痛点
 *      需要靠 A 来解决。
 *
 * 不变量（违反请拒绝合并）：
 *   - 每个 slot 必须经 `executeAgentReact`（享受 schema / tool / mcp / sandbox 公共体系）
 *   - 不在 slot 内复用 orchestrator 的 LangGraph thread（thread id 不共享）
 *   - slot 之间只通过 `analyst-team.ts:outputByRole / auxDigestByRole`
 *     这两个内存 map 串接前置结论（不通过 LangGraph 状态）
 *   - Fan-out 顶层用 `Promise.allSettled`，单 slot 失败不阻塞整批（详见
 *     analyst-team.ts 525-720）
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentInstance } from "../../db/sqlite/schema";
import type { TaskAssignPayload } from "../../types/a2a";
import type { AgentRole, AnalystSignalValue } from "../../types/entities";
import { parseLlmConfigJson } from "../llm/agent-llm-config";
import { invokeWithFallback, resolveLlmForAgent } from "../llm/llm-router";
import { resolveRoleReasoner } from "./role-reasoner";
import { resolveEnabledMcpServerNames } from "../mcp/resolve-enabled-mcp-servers";
import type { RuntimeAgentDefinition } from "../types";
import type { RawAnalystSignal } from "./signal-fusion";
import { validateFsiRoleOutput } from "../fsi/fsi-output-validator";
import type { NormalizedResearchScope } from "../../types/research-scope";
import { stripToolCallSentinels } from "../tools/tool-call-format";
import { formatResearchScopePreamble } from "./analyst-team-scope";

/**
 * 单 slot 在 ReAct 内核里允许的最大轮数。提到 8（原 6）：
 *
 * Wave-3 / W5（2026-06-10 复盘）：旧 prompt 写"先用工具，再出 JSON"暗示线性 2 步；
 * LLM 经常 1 工具 + 1 JSON 就停，没真正进入 ReAct 的"假设→验证→修正"循环。
 * 把 cap 抬到 8 是给"自驱多轮交叉验证"留 token 预算；不会让单 slot 跑爆——
 * `def.maxIterations` 仍然是真实下限（min 取小）。
 */
const TEAM_SLOT_MAX_ITERATIONS = 8;

/**
 * "wave 分析师 ReAct 档位"默认值映射。caller（analyst-team.ts）传入 group.pipelineKind
 * 时按这张表挑迭代上限，否则走默认。
 *
 * - msa_fusion：典型的多分析师投票场景，鼓励单分析师做交叉验证 → 4 轮
 * - sequential_research：策略撰写/实盘下单 pipeline，工具链路本来就长 → 6 轮
 * - event_radar / factor_discovery：事件/因子聚焦 → 3 轮足够
 */
export type AnalystReactDepth = "minimal" | "standard" | "deep";

export function pickAnalystReactDepth(input: {
  pipelineKind?: "msa_fusion" | "sequential_research" | "event_radar" | "factor_discovery" | null;
  expectJsonSignal: boolean;
}): AnalystReactDepth {
  /** Aux pipeline（expectJsonSignal=false）：策略撰写/回测/实盘等长链路 → deep */
  if (!input.expectJsonSignal) return "deep";
  switch (input.pipelineKind) {
    case "sequential_research":
      return "deep";
    case "event_radar":
    case "factor_discovery":
      return "minimal";
    case "msa_fusion":
    default:
      return "standard";
  }
}

export const ANALYST_REACT_ITERATIONS: Record<AnalystReactDepth, number> = {
  minimal: 3,
  standard: 4,
  deep: 6,
};

async function loadRuntimeDefinition(
  definitionId: string,
  reactCap: number = TEAM_SLOT_MAX_ITERATIONS
): Promise<RuntimeAgentDefinition> {
  const db = await getDb();
  const row = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!row[0]) throw new Error(`Agent definition not found: ${definitionId}`);
  const d = row[0];
  /**
   * W5：reactCap 决定该 slot 在本批 wave 内的上限：
   *   - 默认 reactCap = TEAM_SLOT_MAX_ITERATIONS（8）
   *   - caller 按 pipelineKind 传 ANALYST_REACT_ITERATIONS[depth] (3/4/6)
   *   - 与 def.maxIterations 取小值，避免 def 的低 cap 被覆盖（def 可能显式设 2）
   */
  const cap = Math.max(1, Math.min(reactCap, TEAM_SLOT_MAX_ITERATIONS));
  return {
    id: d.id,
    role: d.role as AgentRole,
    name: d.name,
    version: d.version,
    systemPrompt: d.systemPrompt,
    tools: (d.toolsJson as string[]) ?? [],
    mcpServers: (d.mcpServersJson as string[]) ?? [],
    skills: (d.skillsJson as string[]) ?? [],
    subscriptions: (d.subscriptionsJson as RuntimeAgentDefinition["subscriptions"]) ?? ["TASK_ASSIGN"],
    llmProvider: d.llmProvider,
    llmConfig: parseLlmConfigJson(d.llmConfigJson),
    maxIterations: Math.min(d.maxIterations ?? cap, cap),
    sandboxPolicyId: d.sandboxPolicyId,
    enabled: Boolean(d.enabled),
  };
}

/**
 * 从分析师 LLM 文本里抽取**含 `signal` 字段的 JSON 对象**。
 *
 * 2026-05-27 P0 修复：旧实现用 `/\{[\s\S]*\}/` 贪婪匹配，会从文本第一个 `{`
 * 一直吃到最后一个 `}`，跨越 ```json 围栏、markdown 解说、`<TOOL_CALL>` 块
 * 等多段非 JSON 内容 → `JSON.parse` 必然抛错 → 所有合法 signal 全被打成
 * `signal_parse_failed`（WF a09e90c5/9adf5d91 实测 100% 误失败）.
 *
 * 新策略（按优先级从可信到兜底）：
 *   1. 先抓所有 ```json ... ``` 围栏代码块
 *   2. 再抓所有 ``` ... ``` 围栏（无语言标记）
 *   3. fallback 抓所有"扁平"含 `"signal"` 字段的 `{...}` 候选
 *   4. 从尾部反向尝试 JSON.parse，挑第一个 parse 成功 + 含 `signal` 字段的
 *
 * 注意 `<TOOL_CALL>{...}</TOOL_CALL>` 一般在尾部，所以反向匹配先碰到它，
 * 我们需要 **跳过 tool 字段、挑 signal 字段** —— 用 "signal" in obj 守门.
 */
export function extractSignalJsonFromText(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const candidates: string[] = [];
  for (const m of text.matchAll(/```json\s*([\s\S]*?)\s*```/gi)) {
    if (m[1]) candidates.push(m[1]);
  }
  for (const m of text.matchAll(/```\s*([\s\S]*?)\s*```/g)) {
    if (m[1] && !candidates.includes(m[1])) candidates.push(m[1]);
  }
  const balancedScan = (src: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escape = false;
    for (let i = 0; i < src.length; i += 1) {
      const ch = src[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          out.push(src.slice(start, i + 1));
          start = -1;
        } else if (depth < 0) {
          depth = 0;
          start = -1;
        }
      }
    }
    return out;
  };
  for (const blob of balancedScan(text)) {
    if (blob.includes('"signal"') && !candidates.includes(blob)) candidates.push(blob);
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const raw = candidates[i]?.trim();
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj) && "signal" in (obj as Record<string, unknown>)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      // ignore, try next candidate
    }
  }
  return null;
}

/**
 * 解析分析师 LLM 输出里的 JSON 信号。
 *
 * 2026-05-26 数据复盘发现：21 条 analyst_signal 全部塌缩成 `hold @ 0.4`，原因是
 * 旧实现把"LLM 没输出 JSON / signal 字段缺失"都兜底成 `hold @ 0.4`，让上游 fusion
 * 误以为 4 个分析师都"低置信观望"，进而触发辩论 → 全链路无信号产物。
 *
 * 新合约：
 *   - **真正解析到合法 signal**（'buy'|'sell'|'hold' 且 confidence 是 number）→ 返回正常 RawAnalystSignal
 *   - **任何环节失败**（JSON 抽取不到 / signal 不在合法集合 / confidence 不是 number）
 *     → 返回 `null`，调用方应跳过这条 signal（不写 analyst_signal 表，
 *     不参与 fusion 加权），并把原始 text 落到 markdown body 供人工检视
 *
 * 这样真正"模型表达不出信号"的 case 会被 fusion 看见（signals 数变少）
 * 而不是被一堆假 hold 淹没。
 */
function parseJsonSignalFromText(
  role: AgentRole,
  definitionId: string,
  ticker: string,
  text: string
): Promise<RawAnalystSignal | null> {
  return (async () => {
    const parsed = extractSignalJsonFromText(text);
    if (!parsed) return null;

    const validated = await validateFsiRoleOutput(role, parsed);
    const p = validated.sanitized;

    const rawSignal = p["signal"];
    if (!["buy", "sell", "hold"].includes(rawSignal as string)) return null;
    const signal = rawSignal as AnalystSignalValue;

    const rawConfidence = p["confidence"];
    if (typeof rawConfidence !== "number" || !Number.isFinite(rawConfidence)) return null;
    const confidence = Math.max(0, Math.min(1, rawConfidence));

    const reasoning =
      typeof p["reasoning"] === "string" && p["reasoning"].trim().length > 0
        ? p["reasoning"]
        : text.slice(0, 500);

    /**
     * 保留 FSI outputSchema 校验后的结构化字段（key_drivers / key_risks / catalysts /
     * entry_zone / stop_loss / sentiment_score 等），去掉已单列的 signal/confidence/reasoning，
     * 其余作为 structured 贯通到融合/报告/辩论/下游——之前这些字段被解析后直接丢弃。
     */
    const { signal: _s, confidence: _c, reasoning: _r, ...rest } = p as Record<string, unknown>;
    const structured = Object.keys(rest).length > 0 ? rest : undefined;

    return {
      definitionId,
      analystRole: role,
      ticker,
      signal,
      confidence,
      reasoning,
      dataSnapshot: { rawResponse: text },
      ...(structured ? { structured } : {}),
    };
  })();
}

/**
 * #2 末轮强制信号守卫（测评复盘 2026-06-23）：分析师 ReAct 跑完但未以合法 signal JSON 收口
 * （常因数据/工具反复失败耗尽迭代，最后一条是「下一步调用理由」而非结论）。这里做一次极简
 * 「收口」LLM 调用，强制基于已有分析吐出严格 JSON 信号（证据不足则 hold + 低置信），把
 * 「无信号」抢救成「带诚实置信度的信号」，避免融合层凭空缺一角色。best-effort，失败返回 null。
 */
async function salvageSignalFromText(input: {
  def: RuntimeAgentDefinition;
  role: AgentRole;
  definitionId: string;
  ticker: string;
  failedText: string;
}): Promise<RawAnalystSignal | null> {
  try {
    const { config } = await resolveLlmForAgent({
      id: input.def.id,
      role: input.role,
      llmProvider: input.def.llmProvider,
    });
    const systemPrompt = `你是 ${input.role}。现在只做一件事：把下面的分析收口成一个严格 JSON 信号。只输出 JSON，不要任何解释、不要代码围栏。`;
    const userPrompt = [
      "你之前的分析（可能因数据/工具失败而未收口）：",
      "",
      stripToolCallSentinels(input.failedText).slice(0, 3500),
      "",
      '现在**只输出一个 JSON 对象**：{"signal":"buy|sell|hold","confidence":<0到1的数>,"reasoning":"<一句话依据>","thesis":"<一句话结论>"}。',
      '若证据不足以支撑明确方向，就给 signal="hold" 且 confidence ≤ 0.4，并在 reasoning 里点明数据缺口。不要编造数据。',
    ].join("\n");
    const res = await invokeWithFallback(config, {
      systemPrompt,
      userPrompt,
      onToken: () => {},
    });
    return await parseJsonSignalFromText(input.role, input.definitionId, input.ticker, res.answer);
  } catch {
    return null;
  }
}

/**
 * 研究团队槽位：走 LangGraph ReAct（reason→act→工具），写入 tool_call_log / research_team_interaction。
 */
export async function runResearchTeamSlotReact(params: {
  workflowRunId: string;
  definitionId: string;
  role: AgentRole;
  systemPrompt: string;
  ticker: string;
  scope?: NormalizedResearchScope;
  context: string;
  /** 与 analyst-team 预创建的 instance 对齐，便于 tool_call_log 关联 */
  agentInstanceId?: string;
  /** analyst_* 需解析 JSON 信号 */
  expectJsonSignal?: boolean;
  /**
   * W5（2026-06-10）：wave 分析师 ReAct 迭代档位。
   *
   * caller（analyst-team.ts）按 `group.pipelineKind` 传入 minimal/standard/deep；
   * 不传时默认 standard（4 轮），与历史行为相比从"事实上 1-2 轮"提升到"鼓励 4 轮"。
   * 真实上限仍然受 def.maxIterations 与 TEAM_SLOT_MAX_ITERATIONS 双重约束。
   */
  reactDepth?: AnalystReactDepth;
  /**
   * 编组级硬约束 hint（Round 7 复盘 2026-06-08 新增）。
   *
   * 由 caller 通过 `buildGroupRoleConstraintHint({ groupId, role, groupDescription })` 算好后透传。
   * 这里只负责"如果非空就拼到 userGoal 末尾"——不读 group 信息，避免 slot 层耦合 group schema。
   *
   * 典型场景：grp-strategy-pipeline / grp-live-trading 强制要求 research 调
   * strategy.create_version / order.create_intent 落库。
   */
  groupConstraintHint?: string;
}): Promise<
  | { kind: "analyst"; payload: RawAnalystSignal & { agentInstanceId?: string } }
  | { kind: "markdown"; body: string; agentInstanceId?: string }
> {
  const reactDepth: AnalystReactDepth = params.reactDepth ?? "standard";
  const reactCap = ANALYST_REACT_ITERATIONS[reactDepth];
  const def = await loadRuntimeDefinition(params.definitionId, reactCap);
  def.systemPrompt = params.systemPrompt;
  def.mcpServers = await resolveEnabledMcpServerNames(def.mcpServers ?? []);

  const runId = randomUUID();
  const traceId = randomUUID();

  const scopeHint = params.scope ? `\n\n${formatResearchScopePreamble(params.scope)}` : "";
  /**
   * targetLabel 拼接策略：
   *   - explore 且无 ticker  → "就主题 X 自主选标"（不再出现 AUTO_EXPLORE 字面）
   *   - explore 且有候选     → "围绕候选 [A, B] 自主收敛"
   *   - 单标的               → "标的 X"
   *   - 多标的               → "标的组合 A, B, C（主标的 X）"
   * 关键：explore 分支决不能出现 `params.ticker = "AUTO_EXPLORE"` 这种字面值
   * 被拼到 user goal 里 —— 那会让 agent 把它当真 ticker 试图调 fetch_klines。
   */
  const trimmedTicker = (params.ticker ?? "").trim();
  const isExplore = params.scope?.kind === "explore";
  const exploreTheme = params.scope?.theme?.trim();
  let targetLabel: string;
  if (isExplore) {
    if (params.scope && params.scope.symbols.length > 0) {
      targetLabel = `围绕主题「${exploreTheme || "自由探索"}」（候选 ${params.scope.symbols.slice(0, 6).join(", ")}）自主收敛标的`;
    } else {
      targetLabel = `就主题「${exploreTheme || "自由探索"}」自主选定 1-3 个真实标的`;
    }
  } else if (params.scope && params.scope.symbols.length > 1) {
    targetLabel = `标的组合 ${params.scope.symbols.join(", ")}（主标的 ${trimmedTicker || params.scope.primarySymbol}）`;
  } else if (trimmedTicker) {
    targetLabel = `标的 ${trimmedTicker}`;
  } else {
    targetLabel = `标的 ${params.scope?.primarySymbol || "（待确认）"}`;
  }
  /**
   * P1 优先级（Round 7 复盘 2026-06-08）：把编组级硬约束拼到 userGoal 末尾。
   * 当 caller 未传或 buildGroupRoleConstraintHint 未命中白名单时为空串，对原流不影响。
   */
  const groupHint = params.groupConstraintHint?.trim()
    ? `\n\n${params.groupConstraintHint.trim()}`
    : "";
  /**
   * W5（2026-06-10）：把"先用工具，再出 JSON"的线性 2 步暗示改成"多轮交叉验证 + 自我修正"
   * 的 ReAct loop 描述，让 LLM 自己驱动多个工具调用做证据互证，而不是 1 工具 + 1 JSON 就停。
   * 配合 reactDepth=standard (4) / deep (6) 的 maxIterations 提升才有效。
   */
  const reactPolicyHint = (() => {
    if (!params.expectJsonSignal) return "";
    const minTools = reactDepth === "deep" ? 3 : reactDepth === "minimal" ? 1 : 2;
    return [
      "",
      `**多轮 ReAct 策略（本子任务建议至少 ${minTools} 次工具调用 + 1 次 self-critique）**：`,
      "1. **第 1 步**：先调一个核心工具（如 fetch_klines / fetch_news_sentiment）拿到数据",
      "2. **第 2 步**：基于第 1 步结果做交叉验证 —— 选一个**不同维度**的工具（技术面 + 消息面 / 估值 + 同行对比）",
      "3. **第 3 步**：自我审视：`第 1/2 步证据是否互相支撑？是否有反向信号被忽略？` —— 如有冲突，再调 1 个工具核实",
      "4. **最终回合**：综合所有观测输出 JSON 信号。除 `signal`(buy/sell/hold) + `confidence` + `reasoning` 外，**务必按你角色的输出 schema 补全结构化字段**（如 key_drivers / key_risks / catalysts / entry_zone / stop_loss / sentiment_score —— 带上具体数字/证据），这些会原样传给融合、辩论与下游成员。",
      "**禁止**：第 1 个工具调用之后立刻给 JSON 就停 —— 单数据源信号 confidence 上限 0.6。",
      "**量化锚点要与场景匹配**：单标的分析用**单名可行**的锚点（指标读数 / 历史波动分位 / 单名 `backtest.run` Sharpe）；`RankIC`/`IC` 是**横截面**指标、需要 ≥3 只标的，**单标的别强行 `factor.autoEvaluate`**（会因横截面样本不足报 `no_factor_values` / `cross_section_too_few_symbols`，白白耗轮次）。锚点拿不到就**如实说明并下调 confidence**，不要在失败工具上空转。",
      "**最后一轮务必收口**：无论数据是否齐全，最终都要给出 JSON 信号——数据不足就 `hold` + 低 confidence + 在 reasoning 标注缺口，**绝不要**因为还想再调工具而不输出结论。",
    ].join("\n");
  })();
  const userGoal = params.expectJsonSignal
    ? `分析${targetLabel}，使用授权工具做多轮交叉验证，最终输出一段 JSON 信号（buy/sell/hold + confidence + reasoning，并按你角色 schema 补全 key_drivers/key_risks/catalysts 等结构化字段）。${scopeHint}${reactPolicyHint}${groupHint}`
    : `分析${targetLabel}，使用授权工具完成本子任务，最后用 Markdown 小结（不要 JSON）。${scopeHint}${groupHint}`;

  /**
   * 模型 B（docs/CLI_AGENT_PROJECTION_DESIGN.md）：单角色推理引擎可选
   * native / claude_cli / codex_cli。默认 native 时行为与重构前逐字一致——
   * 同 runId、同 payload、同 text 取值（`finalState.reasonText` 优先，空则回退
   * `finalResponse` JSON 串）。CLI 引擎返回同样的最终文本，下面的 JSON 信号解析
   * 与 markdown 兜底完全复用，无需感知引擎差异。
   *
   * MSA fan-out 隔离：4 个 analyst slot 并发执行各自独立 `runId`，自研 snapshot
   * 天然按 runId 隔离，无需额外 thread 后缀（原 LangGraph thread_id 隔离已下线）。
   */
  const payload: TaskAssignPayload = {
    taskId: runId,
    taskType: "analyst_team_slot",
    assignedRole: params.role,
    params: {
      goal: userGoal,
      ticker: params.ticker,
      scope: params.scope,
      context: params.context,
      forceLoop: true,
      teamSlot: true,
    },
  };
  const reasoner = await resolveRoleReasoner(params.workflowRunId);
  const outcome = await reasoner.reason({
    def,
    role: params.role,
    workflowRunId: params.workflowRunId,
    runId,
    traceId,
    payload,
    userGoal,
    ticker: params.ticker,
    context: params.context,
    ...(params.agentInstanceId !== undefined ? { agentInstanceId: params.agentInstanceId } : {}),
    expectJsonSignal: Boolean(params.expectJsonSignal),
  });
  const text = outcome.text;

  const db = await getDb();
  const inst = await db
    .select({ id: agentInstance.id })
    .from(agentInstance)
    .where(
      and(
        eq(agentInstance.workflowRunId, params.workflowRunId),
        eq(agentInstance.definitionId, params.definitionId)
      )
    )
    .orderBy(desc(agentInstance.startedAt))
    .limit(1);
  const agentInstanceId = inst[0]?.id;

  if (params.expectJsonSignal) {
    const signal = await parseJsonSignalFromText(
      params.role,
      params.definitionId,
      params.ticker,
      text
    );
    if (signal === null) {
      /**
       * #2 末轮强制信号守卫：先尝试「收口」抢救成合法信号（数据不足 → hold + 低置信），
       * 避免分析师因数据/工具反复失败耗尽迭代而完全缺席融合（测评复盘 2026-06-23）。
       */
      const salvaged = await salvageSignalFromText({
        def,
        role: params.role,
        definitionId: params.definitionId,
        ticker: params.ticker,
        failedText: text,
      });
      if (salvaged) {
        return {
          kind: "analyst",
          payload: {
            ...salvaged,
            ...(agentInstanceId !== undefined ? { agentInstanceId } : {}),
          },
        };
      }
      /**
       * 抢救仍失败：退化成 markdown 输出 —— fusion 会看到这个角色 missing，下游辩论
       * 触发器才能正确反映"信号缺失"，而不是"4 个角色都低置信"的假象。
       *
       * F-P0-04 修复：剥 `<TOOL_CALL>...</TOOL_CALL>` sentinel——displayable
       * body 不该把工具调用语法泄漏给用户。原始 `text` 仅供工具解析使用。
       */
      const cleanText = stripToolCallSentinels(text);
      return {
        kind: "markdown",
        body: `[signal_parse_failed for ${params.role}] ${cleanText || "（模型未返回内容）"}`,
        ...(agentInstanceId !== undefined ? { agentInstanceId } : {}),
      };
    }
    return {
      kind: "analyst",
      payload: {
        ...signal,
        ...(agentInstanceId !== undefined ? { agentInstanceId } : {}),
      },
    };
  }

  /**
   * F-P0-04 修复（2026-06 评估批次）：aux slot 的 markdown body 会被直接拼进
   * 最终报告（analyst-team.ts → auxSections → report）。reasonText 包含 LLM
   * 在最后一轮 emit 的 `<TOOL_CALL>` sentinel 块（如 `{"tool":"none","summary"}`
   * 或 LLM 因 max_iterations 仍想继续调工具而留下的 sentinel）。tool 解析路径
   * 已经在 act/observe 节点单独走，display 路径必须剥干净，否则报告里会出现
   * `{"tool":"...","params":{...}}` 这种用户看不懂的原始 JSON。
   *
   * 这是 `stripToolCallSentinels` 的 design intent（见该 helper JSDoc："仅用于
   * 展示给用户路径；工具解析必须使用原始文本"）。此处补回 aux 路径漏掉的
   * 一次调用，与 act/observe 节点对 reasonText 的处理保持一致。
   */
  const cleanText = stripToolCallSentinels(text);
  return {
    kind: "markdown",
    body: cleanText || "（模型未返回内容）",
    ...(agentInstanceId !== undefined ? { agentInstanceId } : {}),
  };
}
