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
import type { AgentRole, AnalystSignalValue } from "../../types/entities";
import { executeAgentReact } from "../langgraph/execute-agent-react";
import { resolveEnabledMcpServerNames } from "../mcp/resolve-enabled-mcp-servers";
import type { RuntimeAgentDefinition } from "../types";
import type { RawAnalystSignal } from "./signal-fusion";
import { validateFsiRoleOutput } from "../fsi/fsi-output-validator";
import type { NormalizedResearchScope } from "../../types/research-scope";
import { formatResearchScopePreamble } from "./analyst-team-scope";

const TEAM_SLOT_MAX_ITERATIONS = 6;

async function loadRuntimeDefinition(definitionId: string): Promise<RuntimeAgentDefinition> {
  const db = await getDb();
  const row = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!row[0]) throw new Error(`Agent definition not found: ${definitionId}`);
  const d = row[0];
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
    maxIterations: Math.min(d.maxIterations ?? TEAM_SLOT_MAX_ITERATIONS, TEAM_SLOT_MAX_ITERATIONS),
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

    return {
      definitionId,
      analystRole: role,
      ticker,
      signal,
      confidence,
      reasoning,
      dataSnapshot: { rawResponse: text },
    };
  })();
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
}): Promise<
  | { kind: "analyst"; payload: RawAnalystSignal & { agentInstanceId?: string } }
  | { kind: "markdown"; body: string; agentInstanceId?: string }
> {
  const def = await loadRuntimeDefinition(params.definitionId);
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
  const userGoal = params.expectJsonSignal
    ? `分析${targetLabel}，先使用授权工具拉取数据/指标，再输出一段 JSON 信号（buy/sell/hold + confidence + reasoning）。${scopeHint}`
    : `分析${targetLabel}，使用授权工具完成本子任务，最后用 Markdown 小结（不要 JSON）。${scopeHint}`;

  const result = await executeAgentReact({
    runId,
    workflowId: params.workflowRunId,
    traceId,
    def,
    ...(params.agentInstanceId !== undefined ? { agentInstanceId: params.agentInstanceId } : {}),
    receiverAgent: `team-slot-${params.role}`,
    payload: {
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
    },
    streamLoopKind: "native",
    streamSource: "native",
    updateWorkflowStatus: false,
    /**
     * MSA fan-out 隔离：4 个 analyst slot 并发执行时必须用 per-slot 的 LangGraph
     * thread_id，避免共用 `workflowRunId` 导致 checkpoint 互相覆盖（reason/act
     * state 串台 → "Orchestrator 收到的不是自己分析师的回复"）。
     * suffix 用 `role:definitionId` 既保证人类可读，又避免同 role 多 instance 冲突。
     */
    threadSuffix: `${params.role}:${params.definitionId}`,
  });

  const text =
    String(result.finalState.reasonText ?? "").trim() ||
    JSON.stringify(result.finalResponse ?? {});

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
       * LLM 没产出合法 signal JSON：不让它塌缩成 `hold @ 0.4`（旧 bug），
       * 改为退化成 markdown 输出 —— fusion 会看到这个角色 missing，下游辩论
       * 触发器才能正确反映"信号缺失"，而不是"4 个角色都低置信"的假象。
       */
      return {
        kind: "markdown",
        body: `[signal_parse_failed for ${params.role}] ${text || "（模型未返回内容）"}`,
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

  return {
    kind: "markdown",
    body: text || "（模型未返回内容）",
    ...(agentInstanceId !== undefined ? { agentInstanceId } : {}),
  };
}
