import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import {
  agentProfile,
  chatMessage,
  chatMessageWorkflowLink,
  workflowRun,
} from "../../../db/sqlite/schema";
import { parseLoopOptionsJson } from "../../../types/loop";
import {
  type PromptMode,
  getDataDir,
  mergeSystemPrompt,
  readPackFiles,
} from "../../agent/agent-pack-service";
import {
  ExperienceRecall,
  getExperienceBus,
  getExperienceStore,
  renderRecallBlockForPrompt,
} from "../../experience";
import { enrichSystemPromptWithFsi } from "../../fsi/fsi-prompt-enricher";
import { agentLlmConfigToSampling } from "../../llm/agent-llm-config";
import type { LlmTokenUsage } from "../../llm/gateway";
import { invokeWithFallback, resolveLlmForAgent } from "../../llm/llm-router";
import {
  compactObservations,
  computePromptBudget,
  estimateTokens,
  getContextWindow,
} from "../../llm/token-budget";
import { resolveEnabledMcpServers } from "../../mcp/resolve-enabled-mcp-servers";
import { resolveEffectiveAgentTools } from "../../orchestration/resolve-effective-tools";
import { buildSuggestedCallChainBlock } from "../../orchestration/topology-dispatch";
import { sandboxExecutor } from "../../sandbox-executor";
import { renderSkillsBlockForPrompt, skillService } from "../../skills/skill-service";
import { assembleAgentSystemPrompt, parseToolCallFromReason } from "../../tools/tool-call-format";
import { buildChatHitlSelfCheckPromptBlock } from "../../workflow/hitl-hint-parse";
import type { AgentGraphState, StepStreamEvent } from "../state";

export interface ReasonStepMeta {
  /** Wall-clock latency of the LLM round-trip (including streaming and any retry). */
  latencyMs: number;
  /** Token usage reported by provider (or estimated for mock). */
  usage?: LlmTokenUsage;
  /** True when the primary model failed and the call was retried via default. */
  fallbackUsed: boolean;
  /**
   * True when the first LLM round produced an unparsable tool-call block and we
   * re-prompted once with a strict instruction to use `<TOOL_CALL>…</TOOL_CALL>`.
   * 由 QUBIT_REASON_RETRY_DISABLED=1 关闭。
   */
  parseRetryUsed?: boolean;
  /**
   * 监控 V2 P1：LLM 调用粒度（reason 实际请求的 provider/model；fallback 仍用 primary 口径）。
   * caller 用这些字段写 llm_call_log；缺失时表示 reason 还没真正调到 LLM（被 sandbox 拦截）。
   */
  provider?: string;
  model?: string;
  /** redacted：仅传长度，避免 prompt 原文落库 */
  systemPromptLen?: number;
  userPromptLen?: number;
  /** 若 LLM 抛错 / gateway throws，这里记错误消息（已被截断到 500 字） */
  errorMessage?: string;
  /** 'success' | 'error' | 'fallback'：success+fallbackUsed=true 即 'fallback' 路径 */
  llmStatus?: "success" | "error" | "fallback";
  /**
   * 网关 P0 透传字段：写入 llm_call_log 对应正式列。
   * 失败 / 不返回时缺失。
   */
  firstTokenLatencyMs?: number;
  finishReason?: string;
  responseId?: string;
  /**
   * 网关 P2：是否被 length-retry 自救过（截断时网关层自动加大 maxOutputTokens 重试）。
   * 落到 llm_call_log.requestMetaJson.lengthRetryUsed，让监控能挑出"被自动救过的调用"。
   */
  lengthRetryUsed?: boolean;
}

export interface ReasonNodeOutput {
  /** State delta to merge into the LangGraph workflow state. */
  stateUpdate: Partial<AgentGraphState>;
  /** Observability metadata used by execute-agent-react to fill agent_step. */
  meta: ReasonStepMeta;
}

const FOCUSED_RESEARCH_SCENARIO_GUIDANCE: Record<string, string[]> = {
  factor_research: [
    "目标仅是因子研究，不得扩展成个股基本面、宏观、情绪或多空会审。",
    "优先由你直接调用 factor.register、factor.compute、factor.autoEvaluate；确需专家时最多派给 research 或 analyst_technical。",
    "完成条件是产生可追溯的 factor_definition_batch 和 factor_evaluation_report；没有真实入库因子时必须明确失败或继续修复，禁止声称研究完成。",
  ],
  stock_screening: [
    "目标仅是股票筛选与可执行推荐，不得扩展成通用团队研究报告。",
    "只调用筛选、行情、推荐记录与必要风险工具；确需专家时最多派给 research、analyst_technical 或 risk。",
    "完成条件是产生结构化候选与 recommendation 记录，包含 asof、置信度、入场区间、止盈、止损和证据血缘；没有推荐产物时不得完成。",
  ],
  news_event_radar: [
    "目标仅是新闻事件雷达，不得扩展成四维分析或个股推荐报告。",
    "只调用新闻/事件工具；确需专家时最多派给 analyst_sentiment 或 research。",
    "完成条件是产生带来源、asof、新鲜度和影响方向的事件清单；stub、synthetic 或空数据不得当作有效证据。",
  ],
  strategy_authoring: [
    "目标仅是生成可回测策略及其验证结果，不得扩展成多角色会审。",
    "完成条件是产生策略版本和真实回测指标；没有 OOS/成本后结果时不得声称策略可信。",
  ],
};

export function buildFocusedResearchScenarioPrompt(scenarioKey: string | null): string {
  if (!scenarioKey) return "";
  const rules = FOCUSED_RESEARCH_SCENARIO_GUIDANCE[scenarioKey];
  if (!rules) return "";
  return [
    `## 专业研究场景硬约束：${scenarioKey}`,
    "本任务由 Orchestrator 统一裁决，但不得自动扩成通用研究团队或固定多 Agent 流程。",
    ...rules.map((rule) => `- ${rule}`),
    "- 工具返回空数组、barCount=0、no_bars、no_data 或仅 transport success 时，视为数据失败，不得显示为研究证据。",
    "- 最终答复只包含场景合同要求的结构化结果、关键证据和阻塞项，不生成额外长报告。",
  ].join("\n");
}

async function loadWorkflowMeta(
  workflowId: string
): Promise<{
  projectId: string | null;
  sessionId: string | null;
  source: string | null;
  experience: "native" | "coding_agent";
}> {
  const db = await getDb();
  const wfRows = await db
    .select({
      projectId: workflowRun.projectId,
      sessionId: workflowRun.sessionId,
      source: workflowRun.source,
      loopOptionsJson: workflowRun.loopOptionsJson,
    })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  if (!wfRows[0]) return { projectId: null, sessionId: null, source: null, experience: "native" };
  return {
    projectId: wfRows[0].projectId ?? null,
    sessionId: wfRows[0].sessionId ?? null,
    /**
     * v2 HITL：reason 节点会按 source==='chat' 判定是否注入"HITL 自评 prompt"。
     * 其它 source（manual/api/scheduler/trader/research-team 直接派的）不需要这段提示。
     */
    source: wfRows[0].source ?? null,
    /** Coding-Agent 体验 P3：coding_agent 档给编排器加「可按需拉团队外专家」提示。 */
    experience:
      parseLoopOptionsJson(wfRows[0].loopOptionsJson).experience === "coding_agent"
        ? "coding_agent"
        : "native",
  };
}

/**
 * 严格隔离：只取**显式关联到当前 workflow** 的 chat_message，避免同一 chat_session
 * 下多个 workflow 互相窥见对方的对话历史（2026-05-26 复盘的"板块·AAPL 却被注入
 * NVDA+AMD+AVGO 期权篮子上下文"事故根因）。
 *
 * - 旧实现按 `chatMessage.sessionId = workflowRun.sessionId` 拉所有消息 ——
 *   一个 chat session 下挂 N 个 workflow 时，第 K 个 workflow 的 reason 会看到
 *   前 K-1 个 workflow 留下的全部对话，跨任务泄漏。
 * - 新实现 INNER JOIN `chat_message_workflow_link`，按 `workflow_run_id` 精确过滤：
 *   • chat workflow（loop driver = chat）：每条 user/assistant 消息都会被 chat
 *     routes / workflow-service 写入 link，能拉到本 workflow 的对话上下文；
 *   • research / scheduler / api 等独立 workflow：没有 link，直接返回空 —— 杜绝
 *     "Orchestrator 给分析师发的 brief 莫名其妙带上前一个任务的标的"。
 */
async function loadSessionContext(workflowId: string, limit = 8): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({
      role: chatMessage.role,
      content: chatMessage.content,
      status: chatMessage.status,
      createdAt: chatMessage.createdAt,
    })
    .from(chatMessage)
    .innerJoin(chatMessageWorkflowLink, eq(chatMessageWorkflowLink.chatMessageId, chatMessage.id))
    .where(eq(chatMessageWorkflowLink.workflowRunId, workflowId))
    .orderBy(desc(chatMessage.createdAt))
    .limit(limit);

  return rows
    .reverse()
    .map((m) => `[${m.role}/${m.status}] ${String(m.content ?? "").trim()}`)
    .filter((line) => line.length > 0);
}

async function resolveEffectiveSystemPrompt(
  definitionId: string,
  dbSystemPrompt: string
): Promise<string> {
  const db = await getDb();
  const profRows = await db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.definitionId, definitionId))
    .limit(1);
  const prof = profRows[0];
  const read = await readPackFiles({
    dataDir: getDataDir(),
    definitionId,
    configRootUri: prof?.configRootUri ?? "",
    soulFileRef: prof?.soulFileRef ?? "",
    promptTemplateRef: prof?.promptTemplateRef,
  });
  const mode = (prof?.promptMode as PromptMode | undefined) ?? "db_primary";
  return mergeSystemPrompt({
    mode,
    dbPrompt: dbSystemPrompt,
    agentText: read.agentText,
    soulText: read.soulText,
    userText: read.userText,
    memoryText: read.memoryText,
    promptText: read.promptText,
  });
}

export async function reasonNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void
): Promise<ReasonNodeOutput> {
  /**
   * M10.B1: per-Agent 模型路由 + 默认模型降级。
   * - 先按 def.llmProvider 在 llm_provider_config 表/env 里找；
   * - 找不到/未配 apiKey → 走全局 .qubit/model.json 默认模型；
   * - 都不可用 → mock 兜底（不阻塞工作流）。
   */
  const resolved = await resolveLlmForAgent(state.agentDefinition);
  const modelConfig = resolved.config;
  let answer = "";
  let modelFallbackUsed = false;
  let parseRetryUsed = false;
  let usage: LlmTokenUsage | undefined;
  // 兜底：当 LLM 抛错时 gateway 返回不到 latency，这里以节点入口为起点。
  const nodeStartedAt = Date.now();
  let measuredLatencyMs = 0;
  // 监控 V2 P1：从 catch 兜底拿到的 LLM 错误信息（在 finally 时回填进 meta）
  let llmErrorMessage: string | undefined;
  let llmCallSucceeded = false;
  // 网关 P0：来自 gateway 的扩展打点字段（首次成功调用即填入；retry 路径会覆盖为 retry 的）
  let firstTokenLatencyMs: number | undefined;
  let finishReason: string | undefined;
  let responseId: string | undefined;
  /** 网关 P2：是否被 length-retry 自救过（任一次 invokeWithFallback 触发即 true） */
  let lengthRetryUsed = false;
  // 监控 V2 P1：prompt 长度（不存原文，仅用于 llm_call_log.requestMetaJson）
  let systemPromptLen = 0;
  let userPromptLen = 0;

  const payload = state.inboundMessage.payload as Record<string, unknown>;
  const payloadParams = (payload.params ?? {}) as Record<string, unknown>;
  const payloadGoal =
    payloadParams.goal ??
    payload.goal ??
    payload.message ??
    JSON.stringify(state.inboundMessage.payload);
  const slotContext = typeof payloadParams.context === "string" ? payloadParams.context.trim() : "";
  const slotTicker = typeof payloadParams.ticker === "string" ? payloadParams.ticker.trim() : "";

  /**
   * P1-6（Round 6 复盘 2026-06-08）：observations 旧逻辑 `slice(-3)` 简单粗暴：
   *   - 不读模型真实 contextWindow（128K / 200K / 400K / 1M 一刀切）
   *   - 不处理单条爆炸（fetch_klines 一次几 K token）
   *   - 不在超 budget 时给早期步骤留 stub，让 LLM 一进新轮就"失忆"
   *
   * 现在按模型 contextWindow 算 budget，把 observations 压缩到余量内，保留最近 6 步。
   * 实测 strategy / live_trading p95 74K → 应该能降到 40-50K 量级，给后续 thoughts 留 buffer。
   */
  const sessionContext = await loadSessionContext(state.workflowId);

  const effective = await resolveEffectiveAgentTools(state.agentDefinition, state.workflowId);
  /**
   * 拉取 enabled MCP server **+ 真实工具清单**（capabilities_json.tools），
   * 注入 prompt 让 LLM 看到 mcp-financex 真实可调的工具名（如 `get_financial_statements`），
   * 而不是凭训练记忆瞎喊 `get_financials` / `list_available_tools`。
   * 详见 resolve-enabled-mcp-servers.ts 与 tool-call-format.ts。
   */
  const enabledMcpServers = await resolveEnabledMcpServers(state.agentDefinition.mcpServers ?? []);

  /**
   * 授权前移（治理 #1）：把 effective tools + enabled MCP server 先按 sandbox policy
   * 裁剪到「真正可调用」的子集，再注入 prompt。被 policy 拒的工具根本不出现在
   * 「可用工具」块里，LLM 不会反复挑禁用工具浪费 reason 轮次。act 阶段 check*Call
   * 仍保留为 deny-by-default 兜底（见 sandbox-executor.filterAuthorizedTools 注释）。
   */
  const authorized = await sandboxExecutor.filterAuthorizedTools(
    state.agentDefinition,
    effective.tools,
    enabledMcpServers.map((s) => s.name)
  );
  const tools = authorized.tools;
  const allowedMcpNames = new Set(authorized.mcpServers);
  const mcpServers = enabledMcpServers.filter((s) => allowedMcpNames.has(s.name));
  const hasTools = tools.length > 0 || mcpServers.length > 0;

  /**
   * v2 HITL：source 用于决定是否注入"对话 HITL 自评 prompt"，所以从这里开始
   * 整个函数都需要 workflowMeta。skill 召回里也会用到 projectId，下面 try 块
   * 直接复用同一个 meta，避免对 workflow_run 表二次查询。
   *
   * 查询失败不阻塞（典型场景：异步 cleanup 后 workflow 被删），降级到没注入。
   */
  let workflowMeta: {
    projectId: string | null;
    sessionId: string | null;
    source: string | null;
    experience: "native" | "coding_agent";
  } = {
    projectId: null,
    sessionId: null,
    source: null,
    experience: "native",
  };
  try {
    workflowMeta = await loadWorkflowMeta(state.workflowId);
  } catch {
    // 静默：缺 meta 时直接走默认路径（不注入 HITL 自评 + skill 召回也会自动跳过）
  }

  // M11: 召回相关 skill。失败不阻塞推理（skill 表可能在新 workspace 还没建）。
  let recalledSkillsBlock = "";
  // Memory V2 P1：在 skill 召回旁拼一个 experience 召回块；与 skill 完全独立的失败域
  let recalledExperienceBlock = "";
  // Self-Evolving Agent P9：PnL-aware skill 引导块（"该 agent 最近 7d 最赚钱 top-3"）
  // 跟语义召回完全独立的失败域；总闸关 / 无 PnL 数据 → 空串自然跳过
  let pnlAwareSkillBlock = "";
  try {
    const meta = workflowMeta;
    if (meta.projectId) {
      const query = [
        typeof payloadGoal === "string" ? payloadGoal : String(payloadGoal ?? ""),
        slotTicker,
        slotContext.slice(0, 240),
      ]
        .filter((s) => typeof s === "string" && s.length > 0)
        .join(" ");
      const hitsMeta = await skillService.searchWithMeta({
        projectId: meta.projectId,
        query,
        definitionId: state.agentDefinition.id,
        topK: 3,
      });
      const hits = hitsMeta.map((h) => h.skill);
      if (hits.length > 0) {
        recalledSkillsBlock = renderSkillsBlockForPrompt(hits);
        /**
         * 监控 V2 P2：召回日志（fire-and-forget；不 await 阻塞主链路，但 recordSkillRecall
         * 内部已 try/catch + warn，不会 unhandled promise）。
         * recordUsage 时通过 (workflowRunId, skillId) 翻 executed=true。
         */
        const recallLogger = await import("../../monitor/skill-recall-logger");
        void recallLogger.recordSkillRecall({
          workflowRunId: state.workflowId,
          definitionId: state.agentDefinition.id,
          hits: hitsMeta.map((h) => ({
            skillId: h.skill.id,
            rank: h.rank,
            score: h.score,
          })),
        });
        if (process.env.DEBUG_SKILLS) {
          console.log(
            `[reason] recalled skills for ${state.agentDefinition.role}: ${hits.map((s) => s.name).join(", ")}`
          );
        }
      }

      // ── Memory V2 P1/P2：ExperienceRecall（与 skill 召回并存，独立失败域）──
      //   P2 升级：当 OPENAI_API_KEY 存在 → 自动启用 hybrid（embedding+keyword）；
      //   缺 key 时 getDefaultEmbeddingClient() 返 null，Recall 降级到 keyword-only
      //   （getDefaultEmbeddingClient 在 src/runtime/llm/embedding-client.ts）
      try {
        const { getDefaultEmbeddingClient } = await import("../../llm/embedding-client");
        const { getExperienceVectorStore } = await import(
          "../../experience/experience-vector-store"
        );
        const embeddingClient = getDefaultEmbeddingClient();
        const recall = new ExperienceRecall({
          store: getExperienceStore(),
          bus: getExperienceBus(),
          ...(embeddingClient ? { embeddingClient, vectorStore: getExperienceVectorStore() } : {}),
        });
        const recallHits = await recall.recall({
          projectId: meta.projectId,
          definitionId: state.agentDefinition.id,
          role: state.agentDefinition.role,
          query,
          topK: 5,
          workflowRunId: state.workflowId,
        });
        if (recallHits.length > 0) {
          recalledExperienceBlock = renderRecallBlockForPrompt(recallHits);
          if (process.env.DEBUG_MEMORY_V2) {
            console.log(
              `[reason] recalled ${recallHits.length} experiences for ${state.agentDefinition.role}`
            );
          }
        }
      } catch (err) {
        if (process.env.DEBUG_MEMORY_V2) {
          console.warn(
            "[reason] experience recall failed:",
            err instanceof Error ? err.message : err
          );
        }
      }

      // ── Self-Evolving Agent P9：PnL-aware top-K skill 引导块 ──
      //   独立失败域：失败/无数据返回空串，不阻塞主链路
      //   gate：SELF_EVOLVE_ENABLED + PNL_AWARE_REASON_ENABLED；都关时 fetch 返 []
      try {
        const { getDb } = await import("../../../db/sqlite/client");
        const { buildPnlAwareSkillBlock } = await import("./pnl-aware-skill-block");
        const db = await getDb();
        pnlAwareSkillBlock = await buildPnlAwareSkillBlock(db, state.agentDefinition.id);
        if (pnlAwareSkillBlock && process.env.DEBUG_SKILLS) {
          console.log(
            `[reason] injected PnL-aware skill block for ${state.agentDefinition.role}`
          );
        }
      } catch (err) {
        if (process.env.DEBUG_SKILLS) {
          console.warn(
            "[reason] pnl-aware skill block failed:",
            err instanceof Error ? err.message : err
          );
        }
      }
    }
  } catch (err) {
    // 表不存在 / 项目无 skill 都属于正常分支，仅 debug 日志
    if (process.env.DEBUG_SKILLS) {
      console.warn("[reason] skill recall failed:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * P1-6：在拼接 userPrompt 之前算 prompt budget，把 observations 压缩到余量内。
   *
   * fixedPromptTokens：粗略估算 userPrompt 静态部分（goal + context + skill block + session）+
   * 留出 systemPrompt 大头（保守 8K，实际 6K-12K 浮动）。我们不解 systemPrompt 字符串
   * （那段比较稳定，按经验值预留），重点压缩 observations 这条最易爆炸的尾巴。
   */
  const fixedSnippet = [
    typeof payloadGoal === "string" ? payloadGoal : JSON.stringify(payloadGoal),
    slotTicker,
    slotContext.slice(0, 12000),
    recalledSkillsBlock,
    recalledExperienceBlock,
    pnlAwareSkillBlock,
    sessionContext.join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
  const fixedPromptTokens = estimateTokens(fixedSnippet) + 8_000; // 8K 给 systemPrompt
  const contextWindow = getContextWindow(modelConfig.model);
  /**
   * maxOutputTokens：尊重 agent 的 llmConfig（默认 4096）。compactor 用 8192 做保守估算
   * 防止 length-retry 自动翻倍后超 window。
   */
  const sampledMaxOut = (() => {
    const cfg = state.agentDefinition.llmConfig;
    if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
      const v = (cfg as Record<string, unknown>)["maxOutputTokens"];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.max(v, 8_192);
    }
    return 8_192;
  })();
  const promptBudget = computePromptBudget({
    contextWindow,
    maxOutputTokens: sampledMaxOut,
  });

  const compactedResult = compactObservations(state.observations, {
    fixedPromptTokens,
    promptBudget,
    keepRecent: 6,
    maxCharsPerObservation: 4_000,
  });
  const previousObservations = compactedResult.observations;
  if (
    process.env["DEBUG_TOKEN_BUDGET"] ||
    compactedResult.actions.droppedEarly > 0 ||
    compactedResult.actions.truncatedPerItem > 0
  ) {
    /** 命中压缩动作时打 info 日志，便于监控 */
    console.log(
      `[reason] token-budget compact: role=${state.agentDefinition.role} ` +
        `model=${modelConfig.model} window=${contextWindow} budget=${promptBudget} ` +
        `fixed=${fixedPromptTokens} obsTokens=${compactedResult.estimatedTokens} ` +
        `truncated=${compactedResult.actions.truncatedPerItem} ` +
        `dropped=${compactedResult.actions.droppedEarly} ` +
        `kept=${compactedResult.actions.keptRecent}/${state.observations.length}`
    );
  }

  const userPromptParts = [
    `你是 ${state.agentDefinition.role} Agent，请根据以下任务目标给出分析与回应。`,
    "",
    `**任务目标**：${payloadGoal}`,
    slotTicker ? `**标的**：${slotTicker}` : "",
    slotContext
      ? `\n**任务上下文（数据快照 / 编排简报 / 前置结论）**：\n${slotContext.slice(0, 12000)}`
      : "",
    recalledSkillsBlock ? `\n${recalledSkillsBlock}` : "",
    recalledExperienceBlock ? `\n${recalledExperienceBlock}` : "",
    pnlAwareSkillBlock ? `\n${pnlAwareSkillBlock}` : "",
    sessionContext.length
      ? `\n**会话历史（最近 ${sessionContext.length} 条）**：\n${sessionContext.join("\n")}`
      : "",
    previousObservations.length
      ? `\n**历史观测（共 ${state.observations.length} 步，按 token 预算压缩到最近 ${previousObservations.length} 条；早期已 stub 化）**：\n${JSON.stringify(previousObservations, null, 2)}`
      : "",
    state.iteration > 1 ? `\n**当前迭代**：第 ${state.iteration} 轮` : "",
  ];

  /**
   * 运行中「随时插话」：用户在循环跑动时追加的指令（run-react-loop 在每轮 reason 前
   * drain 后累加到 contextMemory.injectedUserMessages）。作为高优先级实时指引拼进
   * userPrompt——只展示最近 5 条，避免无界增长污染上下文。
   */
  const injectedUserMessages = Array.isArray(state.contextMemory["injectedUserMessages"])
    ? (state.contextMemory["injectedUserMessages"] as string[])
    : [];
  if (injectedUserMessages.length > 0) {
    const recent = injectedUserMessages.slice(-5);
    userPromptParts.push(
      `\n**用户实时追加指令（${injectedUserMessages.length} 条，请优先采纳最新意图）**：`,
      ...recent.map((m, i) => `${injectedUserMessages.length - recent.length + i + 1}. ${m}`)
    );
  }

  if (hasTools) {
    userPromptParts.push(
      "",
      '若本步需要调用工具，请在分析文字之后附上**唯一一个** JSON 工具调用块（见系统提示中的格式）；若仅需文字结论则使用 `{"tool":"none"}`。'
    );
  }

  const userPrompt = userPromptParts.filter(Boolean).join("\n");

  try {
    const baseSystem = await resolveEffectiveSystemPrompt(
      state.agentDefinition.id,
      state.agentDefinition.systemPrompt
    );
    const fsiSystem = await enrichSystemPromptWithFsi({
      role: state.agentDefinition.role,
      basePrompt: baseSystem,
      declaredSkillIds: state.agentDefinition.skills ?? [],
    });
    /**
     * Coding-Agent 体验 P3：coding_agent 档把「编组拓扑」从硬性执行图降级为给 Orchestrator
     * 的**建议调用链**（可照做/调整/跳过/补人）。其余档位沿用原拓扑调度块（与画布一致、严格）。
     */
    const topologyBlock =
      state.agentDefinition.role === "orchestrator" &&
      workflowMeta.experience === "coding_agent" &&
      effective.topologyContext
        ? buildSuggestedCallChainBlock(effective.topologyContext)
        : effective.topologyPromptBlock;
    const topologyOrCollab = topologyBlock || effective.collaborationHint;
    const systemWithTopology = topologyOrCollab
      ? `${fsiSystem}\n\n---\n${topologyOrCollab}`
      : fsiSystem;
    /**
     * v2 HITL：仅对话 orchestrator + chat 工作流注入 HITL 自评指令。
     *
     * - role 过滤：只 orchestrator 写出来的 hitlHint 才会被 hitl-gate 用到；
     *   分析师 / research 等次级 agent 注入只会噪声化输出，也无人接住。
     * - source 过滤：研究团队 plan 走的是 `runOrchestratorPlanning`（不经 reasonNode），
     *   这里读 workflow_run.loop_options_json 拿到的源头是 'chat'；非 chat 工作流
     *   （manual/api/scheduler/trader）不需要这段指令。
     */
    const isChatOrchestrator =
      state.agentDefinition.role === "orchestrator" && workflowMeta.source === "chat";
    const systemWithHitl = isChatOrchestrator
      ? `${systemWithTopology}\n\n---\n${buildChatHitlSelfCheckPromptBlock()}`
      : systemWithTopology;
    /**
     * 调度决策指引：orchestrator 走 reasonNode 的入口=对话/A2A ReAct（团队规划走
     * runOrchestratorPlanning 不经此处），所以对 role==='orchestrator' 注入"如何调度"。
     * 目标：别对每条消息都跑全队——能用已有上下文答的直接答，要某一维才派单，确需重研才跑全队。
     */
    const systemWithDispatch =
      state.agentDefinition.role === "orchestrator"
        ? `${systemWithHitl}\n\n---\n## 调度决策（重要）\n你是编排者，收到用户消息后**先判断该怎么处理，默认由你作为唯一大脑做决策**：\n- 能用「本次会话上下文 / 已有研究结论」直接回答的（总结、解释、澄清、对比、追问）→ 直接给出最终答复，**不调用任何团队工具、不广播**。\n- 只缺一块证据或一个专业判断 → 用 \`assign_task\` 把子任务派给对应专家（如 analyst_technical / analyst_macro / research / risk），等回包后由你整合。\n- 需要多视角时，也优先**分别**派给 2-3 个专家，再由你自己比较与裁决；不要为了“完整流程”一次拉起整队。\n- 除非用户明确要求“完整团队报告 / 团队会审”，否则不要使用批量团队编排思路。\n面向用户的回答要清晰、可执行；不要在能直接回答时还去惊动整支团队。\n\n## 交付纪律（重要）\n- 你和专家都应围绕**当前技术目标**交付最小必要结果：结论、关键证据、下一步。\n- 除非用户明确要求，**不要生成长报告、模板化章节、完整 Executive Summary、冗长复盘**。\n- 若用户要的是某个技术判断、一个候选名单、一段回测结论或一个风险结论，就只交付那个，不要顺手扩写成整份报告。\n\n## 计划可见（重要）\n当任务需要**多步**（派单、连续工具调用）时：**动手前先调 \`update_plan\` 列出 3-5 步**（每步一句话，status=pending），让用户看到你打算怎么做；**每完成一步就再调一次 \`update_plan\`**把该步 status 改为 done、下一步改为 in_progress。一句话能答的简单问题**不必**建计划。${
            workflowMeta.experience === "coding_agent"
              ? "\n\n## 按需召唤专家（Coding-Agent 档）\n当前为 coding_agent 编排档：若需要团队当前编组里没有的专长，**可以直接 \`assign_task\` 把任务派给那个专家角色**（如临时需要 `analyst_macro` / `risk` 等），系统会按需拉它进来——像随手叫一个子 agent。不必拘泥于既定编组。"
              : ""
          }`
        : systemWithHitl;
    const focusedScenarioBlock = buildFocusedResearchScenarioPrompt(effective.scenarioKey);
    const systemWithScenarioContract = focusedScenarioBlock
      ? `${systemWithDispatch}\n\n---\n${focusedScenarioBlock}`
      : systemWithDispatch;
    /**
     * Coding-Agent 体验 P2（docs/CODING_AGENT_EXPERIENCE_DESIGN.md）：运行时注入「工作方式」块。
     * 放在 reason 装配层（而非 seed prompt）→ 对所有角色即时生效、无需 re-seed DB。
     * 目标：把「按配方硬跑」变成「像 coding agent 一样增量推进、失败自适应、先查后做」。
     */
    const WORK_STYLE_BLOCK = [
      "## 工作方式（重要）",
      "- **增量推进**：把任务拆成小步，一步步来；每步只做一件事，拿到结果再决定下一步，不要一次性假设整条流程。",
      "- **先查后做**：动手前若有 `search_memory` / `skill.search` 等工具，先看有没有可复用的先例或既有结论；有就复用，别重复劳动。",
      "- **失败自适应**：工具失败时先读取最近 observation 的 `recovery`：`retry_once` 只允许原调用再试一次，`switch_tool` 必须从 alternatives 换源并按新工具参数重组调用，`continue_with_limits` 禁止继续空转。",
      "- **无数据交付**：没有可靠数据时仍完成不依赖该数据的部分；明确列出已知事实、缺失证据、采用的假设和置信度。核心结论依赖缺失事实时，只给‘若 A 则 B’的条件式结论，并说明拿到什么数据后如何验证。",
      "- **最小交付**：只返回完成当前目标所需的最小结果；除非明确要求，不要主动生成长报告、固定模板章节或泛泛总结。",
      "- **诚实**：没有数据支撑就说不确定；不要编造工具结果或假装已完成。",
    ].join("\n");
    const systemWithWorkStyle = `${systemWithScenarioContract}\n\n---\n${WORK_STYLE_BLOCK}`;
    const { full: systemPrompt } = assembleAgentSystemPrompt(systemWithWorkStyle, {
      tools,
      mcpServers,
    });
    systemPromptLen = systemPrompt.length;
    userPromptLen = userPrompt.length;

    /**
     * P1：把 agent_definition.llm_config_json 反序列化结果转成 sampling，注入到
     * 网关。空配置 / 老 agent 行 → sampling = {} → 网关走默认值（与 P0 完全兼容）。
     */
    const samplingFromAgent = agentLlmConfigToSampling(state.agentDefinition.llmConfig);
    const llmResult = await invokeWithFallback(modelConfig, {
      systemPrompt,
      userPrompt,
      ...(Object.keys(samplingFromAgent).length ? { sampling: samplingFromAgent } : {}),
      onToken: (token) => {
        emit({
          runId: state.runId,
          workflowId: state.workflowId,
          traceId: state.traceId,
          role: state.agentDefinition.role,
          type: "token",
          stepIndex: state.iteration,
          ts: Date.now(),
          payload: { token, provider: modelConfig.provider, model: modelConfig.model },
        });
      },
    });
    answer = llmResult.answer;
    modelFallbackUsed = llmResult.fallbackUsed;
    usage = llmResult.usage;
    measuredLatencyMs = llmResult.latencyMs;
    firstTokenLatencyMs = llmResult.firstTokenLatencyMs;
    finishReason = llmResult.finishReason;
    responseId = llmResult.responseId;
    if (llmResult.lengthRetryUsed) lengthRetryUsed = true;
    llmCallSucceeded = true;
    if (modelFallbackUsed) {
      console.warn(
        `[reason] agent ${state.agentDefinition.id} fell back from ` +
          `${modelConfig.provider}:${modelConfig.model} → ` +
          `${llmResult.modelUsed.provider}:${llmResult.modelUsed.model}`
      );
    }

    // P0-5: 解析失败时单次重试。仅当本轮真有可调用工具，且解析器认为
    // 输出"既不是合法工具调用、也不是合法 none"时才触发，避免无意义的重调。
    if (hasTools && process.env.QUBIT_REASON_RETRY_DISABLED !== "1") {
      const parsed = parseToolCallFromReason(answer, tools);
      if (parsed.kind === "parse_error") {
        const retryStartedAt = Date.now();
        const retryUserPrompt = [
          userPrompt,
          "",
          "---",
          "**上一轮你的输出无法被解析为合法工具调用**：",
          `> ${parsed.message}`,
          "",
          "请**严格**按以下格式重写整段回复（分析文字 + 末尾**唯一一个** <TOOL_CALL> 块）：",
          "",
          "<TOOL_CALL>",
          '{"tool":"<工具名 或 none>","params":{...}}',
          "</TOOL_CALL>",
          "",
          "不要再使用任何其他格式（包括 ```json``` fenced 代码块），不要附带多个 JSON。",
        ].join("\n");

        try {
          const retryResult = await invokeWithFallback(modelConfig, {
            systemPrompt,
            userPrompt: retryUserPrompt,
            ...(Object.keys(samplingFromAgent).length ? { sampling: samplingFromAgent } : {}),
            onToken: (token) => {
              emit({
                runId: state.runId,
                workflowId: state.workflowId,
                traceId: state.traceId,
                role: state.agentDefinition.role,
                type: "token",
                stepIndex: state.iteration,
                ts: Date.now(),
                payload: {
                  token,
                  provider: modelConfig.provider,
                  model: modelConfig.model,
                  retry: true,
                },
              });
            },
          });
          // 仅当重试解析得动才接受；否则保留原 answer，把决定权交给 act 节点报 parse_error
          const retriedParsed = parseToolCallFromReason(retryResult.answer, tools);
          if (retriedParsed.kind !== "parse_error") {
            answer = retryResult.answer;
            parseRetryUsed = true;
            // 累加 latency / usage（保持观测口径与单次调用一致）
            measuredLatencyMs += Date.now() - retryStartedAt;
            if (retryResult.usage && usage) {
              usage = {
                promptTokens: (usage.promptTokens ?? 0) + (retryResult.usage.promptTokens ?? 0),
                completionTokens:
                  (usage.completionTokens ?? 0) + (retryResult.usage.completionTokens ?? 0),
                totalTokens: (usage.totalTokens ?? 0) + (retryResult.usage.totalTokens ?? 0),
                ...(usage.cachedPromptTokens !== undefined ||
                retryResult.usage.cachedPromptTokens !== undefined
                  ? {
                      cachedPromptTokens:
                        (usage.cachedPromptTokens ?? 0) +
                        (retryResult.usage.cachedPromptTokens ?? 0),
                    }
                  : {}),
                ...(usage.cacheCreationInputTokens !== undefined ||
                retryResult.usage.cacheCreationInputTokens !== undefined
                  ? {
                      cacheCreationInputTokens:
                        (usage.cacheCreationInputTokens ?? 0) +
                        (retryResult.usage.cacheCreationInputTokens ?? 0),
                    }
                  : {}),
                ...(usage.reasoningTokens !== undefined ||
                retryResult.usage.reasoningTokens !== undefined
                  ? {
                      reasoningTokens:
                        (usage.reasoningTokens ?? 0) + (retryResult.usage.reasoningTokens ?? 0),
                    }
                  : {}),
              };
            } else if (retryResult.usage) {
              usage = retryResult.usage;
            }
            /**
             * Retry 成功 → 用 retry 的 finish/response id 覆盖（更能反映"实际被采纳的回答"）;
             * firstTokenLatencyMs 维持首次调用值（首次推理仍发生过，TTFT 还是首次的语义）。
             */
            if (retryResult.finishReason) finishReason = retryResult.finishReason;
            if (retryResult.responseId) responseId = retryResult.responseId;
            if (retryResult.lengthRetryUsed) lengthRetryUsed = true;
            console.log(
              `[reason] agent ${state.agentDefinition.role} parse-retry succeeded (orig parse_error → retried OK)`
            );
          } else {
            console.warn(
              `[reason] agent ${state.agentDefinition.role} parse-retry also failed: ${retriedParsed.message}`
            );
          }
        } catch (retryErr) {
          console.warn(
            `[reason] agent ${state.agentDefinition.role} parse-retry threw: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
        }
      }
    }
  } catch (error) {
    const errMsg = (error as Error).message ?? String(error);
    const fallback = `LLM gateway error: ${errMsg}`;
    for (const token of fallback.split(/\s+/).filter(Boolean)) {
      if (!token) continue;
      emit({
        runId: state.runId,
        workflowId: state.workflowId,
        traceId: state.traceId,
        role: state.agentDefinition.role,
        type: "token",
        stepIndex: state.iteration,
        ts: Date.now(),
        payload: { token, provider: modelConfig.provider, error: true },
      });
    }
    answer = fallback;
    measuredLatencyMs = Date.now() - nodeStartedAt;
    // 留给 execute-agent-react.ts 写 llm_call_log（status='error'）使用
    llmErrorMessage = errMsg.slice(0, 500);
  }

  const llmStatus: "success" | "error" | "fallback" = !llmCallSucceeded
    ? "error"
    : modelFallbackUsed
      ? "fallback"
      : "success";

  return {
    stateUpdate: {
      reasonText: answer,
      plannedAction: hasTools ? "tool_call" : "respond_only",
    },
    meta: {
      latencyMs: measuredLatencyMs,
      ...(usage ? { usage } : {}),
      fallbackUsed: modelFallbackUsed,
      ...(parseRetryUsed ? { parseRetryUsed } : {}),
      provider: modelConfig.provider,
      model: modelConfig.model,
      systemPromptLen,
      userPromptLen,
      llmStatus,
      ...(llmErrorMessage ? { errorMessage: llmErrorMessage } : {}),
      ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(responseId ? { responseId } : {}),
      ...(lengthRetryUsed ? { lengthRetryUsed: true } : {}),
    },
  };
}
