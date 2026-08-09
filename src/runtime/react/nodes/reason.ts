import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import {
  agentProfile,
  chatMessage,
  chatMessageWorkflowLink,
  workflowRun,
} from "../../../db/sqlite/schema";
import {
  type AgentControlMode,
  type WorkflowProcessConfig,
  parseLoopOptionsJson,
  resolveAgentControlMode,
  resolveWorkflowProcessConfig,
} from "../../../types/loop";
import { buildAgentControlModePrompt } from "../../agent-control-mode";
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
import { isFinanceSubKind } from "../../context/types";
import { allAxioms, isContextProtocolEnabled } from "../../context/axioms";
import { assembleContextEnvelope } from "../../context/assemble-context-prompt";
import { incContextMetric } from "../../context/context-metrics";
import { FinanceRecall, renderFinanceRecallBlockForPrompt } from "../../context/finance-recall";
import { renderSlotContextForPrompt } from "../../context/handoff";
import { getTurnBindingByWorkflow } from "../../conversation/turn-binding";
import {
  isWorkingMemoryEmpty,
  maybeFoldWorkingMemory,
  renderWorkingMemoryForPrompt,
} from "../../context/working-memory";
import { enrichSystemPromptWithFsi } from "../../fsi/fsi-prompt-enricher";
import { agentLlmConfigToSampling } from "../../llm/agent-llm-config";
import type { LlmTokenUsage } from "../../llm/gateway";
import { invokeWithFallback, resolveLlmForAgent } from "../../llm/llm-router";
import { LlmGatewayError, type LlmGatewayErrorJson } from "../../llm/llm-gateway-error";
import {
  compactObservations,
  computePromptBudget,
  estimateTokens,
  getContextWindow,
  resolveRolePromptBudget,
  truncatePromptText,
} from "../../llm/token-budget";
import {
  loadWorkflowTokenBudgetStatus,
  type WorkflowTokenBudgetStatus,
} from "../../llm/workflow-token-budget";
import {
  buildSuggestedCallChainBlock,
  buildTopologySpecialistExecutionContract,
  shouldForceTopologySpecialistSynthesis,
} from "../../orchestration/topology-dispatch";
import {
  intersectCapabilityWithEffectiveTools,
  resolveEffectiveAgentTools,
} from "../../orchestration/resolve-effective-tools";
import { resolveRegistryScenarioKey } from "../../research-scenario/scenario-key-aliases";
import { resolveScenarioRecipe } from "../../policy/scenario-recipe";
import { listAuthorizedCapabilities } from "../../tools/capability-gate";
import {
  buildRuntimeCapabilityManifestForRuntime,
  renderRuntimeCapabilityManifest,
} from "../../tools/data-capability-manifest";
import {
  listWorkflowArtifactsForContext,
  renderWorkflowArtifactContext,
} from "../../tools/workflow-artifact-ledger";
import { renderSkillsBlockForPrompt, skillService } from "../../skills/skill-service";
import {
  assembleAgentSystemPrompt,
  buildNativeQubitToolDefinition,
  nativeToolCallToSentinel,
  parseToolCallFromReason,
  selectRelevantToolsForPrompt,
} from "../../tools/tool-call-format";
import { buildChatHitlSelfCheckPromptBlock } from "../../workflow/hitl-hint-parse";
import { buildHitlResumePromptBlock } from "../../workflow/hitl-service";
import {
  getWorkflowCancellationSignal,
  isWorkflowCancellationRequested,
  WorkflowCancelledError,
} from "../../workflow/workflow-cancellation";
import {
  buildWorkflowProcessPrompt,
  resolveEffectiveWorkflowProcessConfig,
} from "../../workflow/process-config";
import type { AgentGraphState, IterationContext, StepStreamEvent } from "../state";

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
  /** Gateway transport/provider attempts across invokes in this reason turn. */
  transportAttempts?: number;
  /** Last structured gateway error code (even if later recovered). */
  gatewayErrorCode?: string;
  /** Compact structured error payload for request_meta_json.gatewayError. */
  gatewayError?: Record<string, unknown>;
  nativeToolCallingUsed?: boolean;
  tokenBudgetSoftLimitReached?: boolean;
  promptComponentChars?: Record<string, number>;
  promptEstimatedTokens?: number;
  promptCompacted?: boolean;
}

export interface ReasonNodeOutput {
  /** State delta to merge into the LangGraph workflow state. */
  stateUpdate: Partial<AgentGraphState>;
  /** Observability metadata used by execute-agent-react to fill agent_step. */
  meta: ReasonStepMeta;
}

/** Recipe is the single source of scenario prompt constraints (no FOCUSED_* dual-write). */
export function buildFocusedResearchScenarioPrompt(scenarioKey: string | null): string {
  if (!scenarioKey) return "";
  const recipe =
    resolveScenarioRecipe(scenarioKey) ??
    resolveScenarioRecipe(resolveRegistryScenarioKey(scenarioKey) ?? "");
  if (!recipe) return "";
  const checklist = recipe.checklistPrompt ?? [];
  const opsHint =
    recipe.key === "factor"
      ? "- 因子表达式默认 lang=qlib_expr；使用 Ref/Mean/Std 等，勿写未声明的 Python 名（shift/pd/np）。"
      : null;
  return [
    `## 专业研究场景硬约束：${scenarioKey} @${recipe.version}`,
    "本任务由 Orchestrator 统一裁决，但不得自动扩成通用研究团队或固定多 Agent 流程。",
    "答案须包含五段：goal / evidence / decision / risks / gaps。",
    "禁止把行情探活失败写成唯一结案；系统不会代执行业务写工具，须你自行调用。",
    ...checklist.map((rule) => `- ${rule}`),
    opsHint,
    "- 工具返回空数组、barCount=0、no_bars、no_data 或仅 transport success 时，视为数据失败，不得显示为研究证据。",
    "- 最终答复只包含场景合同要求的结构化结果、关键证据和阻塞项，不生成额外长报告。",
  ]
    .filter(Boolean)
    .join("\n");
}

const OPTIONAL_CONTEXT_TIMEOUT_MS = Number(
  process.env["QUBIT_REASON_OPTIONAL_CONTEXT_TIMEOUT_MS"] ?? "2500"
);

async function withOptionalContextTimeout<T>(
  label: string,
  promise: Promise<T>,
  fallback: T
): Promise<T> {
  if (!Number.isFinite(OPTIONAL_CONTEXT_TIMEOUT_MS) || OPTIONAL_CONTEXT_TIMEOUT_MS <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            `[reason] optional context "${label}" timed out after ${OPTIONAL_CONTEXT_TIMEOUT_MS}ms; continuing without it`
          );
          resolve(fallback);
        }, OPTIONAL_CONTEXT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadWorkflowMeta(
  workflowId: string,
  iterationContext?: IterationContext | null
): Promise<{
  projectId: string | null;
  sessionId: string | null;
  source: string | null;
  mode: string | null;
  agentMode: AgentControlMode;
  processConfig: WorkflowProcessConfig | null;
  benchmarkNamespace: boolean;
  fsWorkspaceId: string | null;
}> {
  const db = await getDb();
  const wfRows = await db
    .select({
      projectId: workflowRun.projectId,
      sessionId: workflowRun.sessionId,
      source: workflowRun.source,
      mode: workflowRun.mode,
      loopOptionsJson: workflowRun.loopOptionsJson,
    })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  if (!wfRows[0])
    return {
      projectId: null,
      sessionId: null,
      source: null,
      mode: null,
      agentMode: "agent",
      processConfig: null,
      benchmarkNamespace: false,
      fsWorkspaceId: null,
    };
  const loop = parseLoopOptionsJson(wfRows[0].loopOptionsJson);
  const fsFromLoop =
    typeof loop.fsWorkspaceId === "string" &&
    loop.fsWorkspaceId.trim() &&
    !loop.fsWorkspaceId.startsWith("wf_")
      ? loop.fsWorkspaceId.trim()
      : null;
  const fsFromEnv = process.env.QUBIT_ACTIVE_FS_WORKSPACE_ID?.trim();
  const fsWorkspaceId =
    fsFromLoop ||
    (fsFromEnv && !fsFromEnv.startsWith("wf_") ? fsFromEnv : null);
  return {
    projectId: wfRows[0].projectId ?? null,
    sessionId: wfRows[0].sessionId ?? null,
    /**
     * v2 HITL：reason 节点会按 source==='chat' 判定是否注入"HITL 自评 prompt"。
     * 其它 source（manual/api/scheduler/trader/research-team 直接派的）不需要这段提示。
     */
    source: wfRows[0].source ?? null,
    mode: wfRows[0].mode ?? null,
    agentMode: iterationContext?.agentMode ?? resolveAgentControlMode(wfRows[0].loopOptionsJson),
    processConfig:
      iterationContext?.processConfig ?? resolveWorkflowProcessConfig(wfRows[0].loopOptionsJson),
    benchmarkNamespace: loop.benchmarkNamespace === true,
    fsWorkspaceId,
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
async function loadSessionContext(workflowId: string, limit = 6): Promise<string[]> {
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
    .map(
      (m) =>
        `[${m.role}/${m.status}] ${String(m.content ?? "")
          .trim()
          .slice(0, 1600)}`
    )
    .filter((line) => line.length > 0);
}

function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter((s): s is AbortSignal => Boolean(s));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(active);
  }
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      "abort",
      () => {
        if (!controller.signal.aborted) controller.abort(signal.reason);
      },
      { once: true }
    );
  }
  return controller.signal;
}

/** Wall-clock context so models don't invent "today" when calling market tools. */
export function formatReasonClockContext(now: Date = new Date()): string {
  const utcIso = now.toISOString();
  const utcDate = utcIso.slice(0, 10);
  const shanghai = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  const shanghaiDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return [
    `**系统时钟（权威 as-of，禁止臆造）**：`,
    `- UTC now: ${utcIso}（UTC 日 ${utcDate}）`,
    `- Asia/Shanghai: ${shanghai}（交易日历日 ${shanghaiDate}）`,
    `- 拉行情前先确定时间窗：优先显式传 startDate+endDate；缺省用 endDate=${shanghaiDate}（或 UTC ${utcDate}）+ limit≈250 根日线。`,
    `- 用户说“现在/今天/近期”一律相对上述 as-of，不得用训练记忆里的旧日期。`,
  ].join("\n");
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
  emit: (event: StepStreamEvent) => void,
  options?: { signal?: AbortSignal }
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
  let transportAttempts = 0;
  let lastGatewayError: LlmGatewayErrorJson | undefined;
  // 监控 V2 P1：prompt 长度（不存原文，仅用于 llm_call_log.requestMetaJson）
  let systemPromptLen = 0;
  let userPromptLen = 0;
  let nativeToolCallingUsed = false;
  let promptCompacted = false;
  let promptEstimatedTokens = 0;
  let promptComponentChars: Record<string, number> = {};
  const workflowCancellationSignal = getWorkflowCancellationSignal(state.workflowId);
  const cancellationSignal = mergeAbortSignals(workflowCancellationSignal, options?.signal);

  const payload = state.inboundMessage.payload as Record<string, unknown>;
  const payloadParams = (payload.params ?? {}) as Record<string, unknown>;
  const payloadGoal =
    payloadParams.goal ??
    payload.goal ??
    payload.message ??
    JSON.stringify(state.inboundMessage.payload);
  const slotContextRaw = payloadParams.context;
  const slotContextRendered = renderSlotContextForPrompt(slotContextRaw);
  const slotContext =
    typeof slotContextRaw === "string" ? slotContextRaw.trim() : slotContextRendered;
  const slotTicker = typeof payloadParams.ticker === "string" ? payloadParams.ticker.trim() : "";
  const hitlResumeBlock = buildHitlResumePromptBlock({
    approval: payloadParams.hitlApproval,
    payload: payloadParams.hitlPayload,
    inputSchema: payloadParams.hitlInputSchema,
  });

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

  /**
   * Tool/MCP availability must use the same project context as dispatch. Loading
   * workflow metadata after resolving MCP servers made the prompt global-only,
   * while dispatcher supported project overrides.
   */
  let workflowMeta: {
    projectId: string | null;
    sessionId: string | null;
    source: string | null;
    mode: string | null;
    agentMode: AgentControlMode;
    processConfig: WorkflowProcessConfig | null;
    benchmarkNamespace: boolean;
    fsWorkspaceId: string | null;
  } = {
    projectId: null,
    sessionId: null,
    source: null,
    mode: null,
    agentMode: "agent",
    processConfig: null,
    benchmarkNamespace: false,
    fsWorkspaceId: null,
  };
  let workflowTokenBudget: WorkflowTokenBudgetStatus | null = null;
  try {
    workflowMeta = await loadWorkflowMeta(state.workflowId, state.iterationContext);
    workflowTokenBudget = await loadWorkflowTokenBudgetStatus(await getDb(), state.workflowId);
  } catch {
    // Missing workflow metadata must not block reasoning.
  }

  /**
   * CapabilityGate 投影（docs/agent-contracts/02）：工具面与 authorize 同源。
   * plan 模式裁剪、enabled MCP、sandbox 白名单均在 listAuthorizedCapabilities 内完成。
   * topology / collaboration 仍来自 resolveEffectiveAgentTools。
   */
  const effective =
    state.iterationContext?.effectiveTools ??
    (await resolveEffectiveAgentTools(state.agentDefinition, state.workflowId));
  const capabilitySurface = await listAuthorizedCapabilities({
    agentDefinition: state.agentDefinition,
    workflowId: state.workflowId,
    ...(workflowMeta.projectId ? { projectId: workflowMeta.projectId } : {}),
    ...(workflowMeta.agentMode ? { agentMode: workflowMeta.agentMode } : {}),
  });
  // Keep authorization and current scenario progress separate, then expose
  // only their intersection.  The previous implementation calculated
  // `effective` but discarded its tools here, so the LLM repeatedly selected
  // stale probe/read tools which Act could no longer execute.
  const authorizedEffectiveTools = intersectCapabilityWithEffectiveTools(
    capabilitySurface.tools,
    effective.tools
  );
  const capabilityManifest = await buildRuntimeCapabilityManifestForRuntime({
    tools: authorizedEffectiveTools,
    goal: typeof payloadGoal === "string" ? payloadGoal : null,
    ticker: slotTicker,
  });
  const capabilityManifestBlock = renderRuntimeCapabilityManifest(capabilityManifest);
  let workflowArtifactBlock = "";
  try {
    workflowArtifactBlock = renderWorkflowArtifactContext(
      await listWorkflowArtifactsForContext(state.workflowId)
    );
  } catch {
    // Artifact ledger is optional during rolling migration; reasoning must continue.
  }
  const topologySynthesisRequired = shouldForceTopologySpecialistSynthesis({
    taskType: String(payload.taskType ?? ""),
    role: state.agentDefinition.role,
    toolCalls: state.toolCalls,
  });
  // Reserve a final LLM turn for a user-facing conclusion instead of allowing
  // a delegated specialist to spend all iterations on equivalent data calls.
  const tools = topologySynthesisRequired ? [] : capabilityManifest.tools;
  const mcpServers = [...capabilitySurface.mcpServers];
  const hasTools = tools.length > 0 || mcpServers.length > 0;
  const taskQuery = [
    typeof payloadGoal === "string" ? payloadGoal : JSON.stringify(payloadGoal),
    slotTicker,
    slotContext.slice(0, 600),
    JSON.stringify(state.observations.slice(-1)).slice(0, 600),
  ]
    .filter(Boolean)
    .join(" ");
  const configuredMaxPromptTools = Number(process.env["QUBIT_MAX_PROMPT_TOOLS"] ?? "16");
  const promptTools = selectRelevantToolsForPrompt(
    tools,
    taskQuery,
    Number.isFinite(configuredMaxPromptTools)
      ? Math.max(4, Math.floor(configuredMaxPromptTools))
      : 16
  );
  const nativeToolCalling =
    hasTools && promptTools.length > 0 && process.env["QUBIT_NATIVE_TOOL_CALLING_DISABLED"] !== "1";

  // M11: 召回相关 skill。失败不阻塞推理（skill 表可能在新 workspace 还没建）。
  let recalledSkillsBlock = "";
  // Memory V2 / Context Protocol：finance 与 general 分槽
  let recalledFinanceBlock = "";
  let recalledGeneralBlock = "";
  // 兼容旧路径：合并块（协议关闭时只用这个）
  let recalledExperienceBlock = "";
  // Self-Evolving Agent P9：PnL-aware skill 引导块（"该 agent 最近 7d 最赚钱 top-3"）
  // 跟语义召回完全独立的失败域；总闸关 / 无 PnL 数据 → 空串自然跳过
  let pnlAwareSkillBlock = "";
  try {
    const meta = workflowMeta;
    if (meta.projectId && !meta.benchmarkNamespace) {
      const query = [
        typeof payloadGoal === "string" ? payloadGoal : String(payloadGoal ?? ""),
        slotTicker,
        slotContext.slice(0, 240),
      ]
        .filter((s) => typeof s === "string" && s.length > 0)
        .join(" ");
      const hitsMeta = await withOptionalContextTimeout(
        "skill.searchWithMeta",
        skillService.searchWithMeta({
          projectId: meta.projectId,
          query,
          definitionId: state.agentDefinition.id,
          topK: 3,
          mode: meta.mode,
        }),
        []
      );
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

      // ── Memory V2 + Context Protocol：FinanceRecall / general Experience ──
      try {
        const { getDefaultEmbeddingClient } = await import("../../llm/embedding-client");
        const { getExperienceVectorStore } = await import(
          "../../experience/experience-vector-store"
        );
        const embeddingClient = getDefaultEmbeddingClient();
        const recallOpts = {
          store: getExperienceStore(),
          bus: getExperienceBus(),
          ...(embeddingClient ? { embeddingClient, vectorStore: getExperienceVectorStore() } : {}),
        };
        const symbolsFromSlot = slotTicker ? [slotTicker] : [];
        const decisionCutoff =
          typeof payloadParams.decisionCutoff === "string"
            ? payloadParams.decisionCutoff
            : typeof payloadParams.asof === "string"
              ? payloadParams.asof
              : undefined;

        if (isContextProtocolEnabled()) {
          const financeRecall = new FinanceRecall(recallOpts);
          const financeHits = await withOptionalContextTimeout(
            "experience.finance_recall",
            financeRecall.recall({
              projectId: meta.projectId,
              definitionId: state.agentDefinition.id,
              role: state.agentDefinition.role,
              query,
              topK: 5,
              workflowRunId: state.workflowId,
              ...(symbolsFromSlot.length ? { symbols: symbolsFromSlot } : {}),
              ...(decisionCutoff ? { decisionCutoff } : {}),
              ...(meta.fsWorkspaceId ? { workspaceId: meta.fsWorkspaceId } : {}),
            }),
            []
          );
          if (financeHits.length > 0) {
            recalledFinanceBlock = renderFinanceRecallBlockForPrompt(financeHits);
          }

          const generalRecall = new ExperienceRecall(recallOpts);
          const generalHits = await withOptionalContextTimeout(
            "experience.recall",
            generalRecall.recall({
              projectId: meta.projectId,
              definitionId: state.agentDefinition.id,
              role: state.agentDefinition.role,
              query,
              topK: 5,
              workflowRunId: state.workflowId,
              ...(meta.fsWorkspaceId ? { workspaceId: meta.fsWorkspaceId } : {}),
            }),
            []
          );
          const nonFinance = generalHits.filter((h) => !isFinanceSubKind(h.experience.subKind));
          if (nonFinance.length > 0) {
            recalledGeneralBlock = renderRecallBlockForPrompt(nonFinance);
          }

          // Code-agent 式 FS 课题记忆（与 Experience 双路）
          if (meta.fsWorkspaceId) {
            try {
              const { recallLongTermMemory } = await import("../../memory/long-term-memory");
              const dual = await withOptionalContextTimeout(
                "ltm.fs_recall",
                recallLongTermMemory({
                  projectId: meta.projectId,
                  query,
                  topK: 4,
                  definitionId: state.agentDefinition.id,
                  workflowId: state.workflowId,
                  fsWorkspaceId: meta.fsWorkspaceId,
                  includeFs: true,
                  kinds: ["semantic", "procedural", "reflective"],
                }),
                []
              );
              const fsOnly = dual.filter((h) => h.source === "fs");
              if (fsOnly.length > 0) {
                const fsBlock = [
                  "## Memory · Workspace (FS)",
                  "> 课题目录 `memory/entries` 召回（用户笔记 / Agent 投影）。",
                  "",
                  ...fsOnly.map(
                    (h) =>
                      `### ${h.title}\n> score=${h.score.toFixed(3)}\n\n${h.summary.slice(0, 600)}`
                  ),
                ].join("\n");
                recalledGeneralBlock = [recalledGeneralBlock, fsBlock].filter(Boolean).join("\n\n");
              }
            } catch {
              // FS recall is optional
            }
          }

          recalledExperienceBlock = [recalledFinanceBlock, recalledGeneralBlock]
            .filter(Boolean)
            .join("\n\n");
        } else {
          const recall = new ExperienceRecall(recallOpts);
          const recallHits = await withOptionalContextTimeout(
            "experience.recall",
            recall.recall({
              projectId: meta.projectId,
              definitionId: state.agentDefinition.id,
              role: state.agentDefinition.role,
              query,
              topK: 5,
              workflowRunId: state.workflowId,
              ...(meta.fsWorkspaceId ? { workspaceId: meta.fsWorkspaceId } : {}),
            }),
            []
          );
          if (recallHits.length > 0) {
            recalledExperienceBlock = renderRecallBlockForPrompt(recallHits);
            recalledGeneralBlock = recalledExperienceBlock;
          }
        }

        if (process.env.DEBUG_MEMORY_V2 && recalledExperienceBlock) {
          console.log(
            `[reason] recalled experiences for ${state.agentDefinition.role} (ctxProtocol=${isContextProtocolEnabled()})`
          );
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
        pnlAwareSkillBlock = await withOptionalContextTimeout(
          "pnlAwareSkillBlock",
          buildPnlAwareSkillBlock(db, state.agentDefinition.id),
          ""
        );
        if (pnlAwareSkillBlock && process.env.DEBUG_SKILLS) {
          console.log(`[reason] injected PnL-aware skill block for ${state.agentDefinition.role}`);
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
   * fixedPromptTokens：估算 userPrompt 静态部分（goal + context + skill block + session）+
   * systemPrompt 预留。最终 system/user prompt 还会分别经过字符硬上限裁剪；这里重点
   * 先压缩 observations 这条最易爆炸的尾巴。
   */
  const fixedSnippet = [
    typeof payloadGoal === "string" ? payloadGoal : JSON.stringify(payloadGoal),
    slotTicker,
    slotContext.slice(0, 6000),
    hitlResumeBlock,
    recalledSkillsBlock,
    recalledFinanceBlock || recalledExperienceBlock,
    recalledGeneralBlock,
    pnlAwareSkillBlock,
    capabilityManifestBlock,
    workflowArtifactBlock,
    sessionContext.join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
  const configuredPerCallPromptLimit = Number(
    process.env["QUBIT_MAX_PROMPT_TOKENS_PER_CALL"] ?? "18000"
  );
  const llmCfg =
    state.agentDefinition.llmConfig &&
    typeof state.agentDefinition.llmConfig === "object" &&
    !Array.isArray(state.agentDefinition.llmConfig)
      ? (state.agentDefinition.llmConfig as Record<string, unknown>)
      : {};
  const roleBudget = resolveRolePromptBudget(state.agentDefinition.role, {
    ...(typeof llmCfg["maxPromptTokens"] === "number"
      ? { maxPromptTokens: llmCfg["maxPromptTokens"] as number }
      : {}),
    ...(typeof llmCfg["maxCharsPerObservation"] === "number"
      ? { maxCharsPerObservation: llmCfg["maxCharsPerObservation"] as number }
      : {}),
    ...(typeof llmCfg["keepRecentObservations"] === "number"
      ? { keepRecent: llmCfg["keepRecentObservations"] as number }
      : {}),
  });
  const perCallPromptLimit = Math.min(
    workflowTokenBudget?.policy.maxPromptTokensPerCall ??
      (Number.isFinite(configuredPerCallPromptLimit) && configuredPerCallPromptLimit > 0
        ? Math.floor(configuredPerCallPromptLimit)
        : 18_000),
    roleBudget.maxPromptTokens
  );
  const fixedPromptTokens =
    estimateTokens(fixedSnippet) + Math.min(12_000, Math.floor(perCallPromptLimit * 0.6));
  const agentContextWindow =
    typeof llmCfg["contextWindow"] === "number" &&
    Number.isFinite(llmCfg["contextWindow"]) &&
    (llmCfg["contextWindow"] as number) > 0
      ? (llmCfg["contextWindow"] as number)
      : null;
  const contextWindow = getContextWindow(
    modelConfig.model,
    agentContextWindow ?? modelConfig.contextWindow ?? null
  );
  /**
   * maxOutputTokens：尊重 agent 的 llmConfig（默认 4096）。compactor 用 8192 做保守估算
   * 防止 length-retry 自动翻倍后超 window。
   */
  const sampledMaxOut = (() => {
    const v = llmCfg["maxOutputTokens"];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.max(v, 8_192);
    return 8_192;
  })();
  const promptBudget = Math.min(
    computePromptBudget({
      contextWindow,
      maxOutputTokens: sampledMaxOut,
      safetyRatio: roleBudget.safetyRatio,
    }),
    perCallPromptLimit
  );

  const compactedResult = compactObservations(state.observations, {
    fixedPromptTokens,
    promptBudget,
    keepRecent: roleBudget.keepRecent,
    maxCharsPerObservation: roleBudget.maxCharsPerObservation,
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

  const clockContext = formatReasonClockContext();
  const userPromptParts = [
    `你是 ${state.agentDefinition.role} Agent，请根据以下任务目标给出分析与回应。`,
    "",
    clockContext,
    "",
    `**任务目标**：${payloadGoal}`,
    slotTicker ? `**标的**：${slotTicker}` : "",
    slotContext
      ? `\n${slotContextRendered || `**任务上下文**：\n${String(slotContext).slice(0, 6000)}`}`
      : "",
    hitlResumeBlock ? `\n${hitlResumeBlock}` : "",
    recalledSkillsBlock ? `\n${recalledSkillsBlock}` : "",
    recalledFinanceBlock ? `\n${recalledFinanceBlock}` : "",
    !recalledFinanceBlock && recalledExperienceBlock ? `\n${recalledExperienceBlock}` : "",
    recalledGeneralBlock && recalledFinanceBlock ? `\n${recalledGeneralBlock}` : "",
    pnlAwareSkillBlock ? `\n${pnlAwareSkillBlock}` : "",
    capabilityManifestBlock ? `\n${capabilityManifestBlock}` : "",
    workflowArtifactBlock ? `\n${workflowArtifactBlock}` : "",
    sessionContext.length
      ? `\n**会话历史（最近 ${sessionContext.length} 条）**：\n${sessionContext.join("\n")}`
      : "",
    previousObservations.length
      ? `\n**历史观测（共 ${state.observations.length} 步，按 token 预算压缩到最近 ${previousObservations.length} 条；早期已 stub 化）**：\n${JSON.stringify(previousObservations, null, 2)}`
      : "",
    topologySynthesisRequired
      ? "\n**专家取证上限已到**：已有证据足以先交付。现在禁止再调用工具；请输出完整结论、关键证据、风险与缺口，并使用 `tool=none` 结束。"
      : "",
    state.iteration > 1 ? `\n**当前迭代**：第 ${state.iteration} 轮` : "",
  ];

  /**
   * 运行中「随时插话」：用户在循环跑动时追加的指令（run-react-loop 在每轮 reason 前
   * drain 后累加到 contextMemory.injectedUserMessages）。作为高优先级实时指引拼进
   * userPrompt——只展示最近 3 条，避免无界增长污染上下文。
   */
  const injectedUserMessages = Array.isArray(state.contextMemory["injectedUserMessages"])
    ? (state.contextMemory["injectedUserMessages"] as string[])
    : [];
  if (injectedUserMessages.length > 0) {
    const recent = injectedUserMessages.slice(-3);
    userPromptParts.push(
      `\n**用户实时追加指令（${injectedUserMessages.length} 条，请优先采纳最新意图）**：`,
      ...recent.map((m, i) => `${injectedUserMessages.length - recent.length + i + 1}. ${m}`)
    );
  }

  if (hasTools && !nativeToolCalling) {
    userPromptParts.push(
      "",
      '若本步需要调用工具，请在分析文字之后附上**唯一一个** JSON 工具调用块（见系统提示中的格式）；若仅需文字结论则使用 `{"tool":"none"}`。'
    );
  }

  if (workflowTokenBudget?.softLimitReached) {
    userPromptParts.push(
      "\n**Token 预算提醒**：本工作流已达到软预算，请停止扩展新分支，只完成当前最小可验证结论。"
    );
  }

  let rawUserPrompt: string;
  if (isContextProtocolEnabled()) {
    const goalSlot = [
      `你是 ${state.agentDefinition.role} Agent，请根据以下任务目标给出分析与回应。`,
      "",
      `**任务目标**：${payloadGoal}`,
      slotTicker ? `**标的**：${slotTicker}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const slotBlock = slotContextRendered
      ? slotContextRendered.slice(0, 6000)
      : typeof slotContextRaw === "string" && slotContextRaw.trim()
        ? `**任务上下文（数据快照 / 编排简报 / 前置结论）**：\n${slotContextRaw.trim().slice(0, 6000)}`
        : "";
    const foldedWorking = maybeFoldWorkingMemory(state.workingMemory);
    const workingBlock = !isWorkingMemoryEmpty(foldedWorking)
      ? renderWorkingMemoryForPrompt(foldedWorking)
      : "";
    const sessionBlock = sessionContext.length
      ? `**会话历史（最近 ${sessionContext.length} 条）**：\n${sessionContext.join("\n")}`
      : "";
    const controlParts: string[] = [];
    if (hitlResumeBlock) controlParts.push(hitlResumeBlock);
    if (injectedUserMessages.length > 0) {
      const recent = injectedUserMessages.slice(-3);
      controlParts.push(
        `**用户实时追加指令（${injectedUserMessages.length} 条，请优先采纳最新意图）**：`,
        ...recent.map((m, i) => `${injectedUserMessages.length - recent.length + i + 1}. ${m}`)
      );
    }
    if (hasTools && !nativeToolCalling) {
      controlParts.push(
        '若本步需要调用工具，请在分析文字之后附上**唯一一个** JSON 工具调用块（见系统提示中的格式）；若仅需文字结论则使用 `{"tool":"none"}`。'
      );
    }
    if (workflowTokenBudget?.softLimitReached) {
      controlParts.push(
        "**Token 预算提醒**：本工作流已达到软预算，请停止扩展新分支，只完成当前最小可验证结论。"
      );
    }
    if (topologySynthesisRequired) {
      controlParts.push(
        "**专家取证上限已到**：已有证据足以先交付。现在禁止再调用工具；请输出完整结论、关键证据、风险与缺口，并使用 `tool=none` 结束。"
      );
    }
    if (state.iteration > 1) controlParts.push(`**当前迭代**：第 ${state.iteration} 轮`);
    if (pnlAwareSkillBlock) controlParts.push(pnlAwareSkillBlock);
    if (capabilityManifestBlock) controlParts.push(capabilityManifestBlock);
    if (workflowArtifactBlock) controlParts.push(workflowArtifactBlock);

    const turnBinding = getTurnBindingByWorkflow(state.workflowId);
    const turnId =
      typeof payloadParams.turnId === "string"
        ? payloadParams.turnId
        : typeof payloadParams.conversationTurnId === "string"
          ? payloadParams.conversationTurnId
          : turnBinding?.turnId;
    const sessionId =
      typeof payloadParams.sessionId === "string"
        ? payloadParams.sessionId
        : turnBinding?.sessionId;

    const envelope = assembleContextEnvelope({
      workflowRunId: state.workflowId,
      definitionId: state.agentDefinition.id,
      role: state.agentDefinition.role,
      ...(sessionId ? { sessionId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(typeof payloadParams.decisionCutoff === "string"
        ? { decisionCutoff: payloadParams.decisionCutoff }
        : typeof payloadParams.asof === "string"
          ? { decisionCutoff: payloadParams.asof }
          : {}),
      axiomsApplied: allAxioms(),
      softOmitLowPriority: Boolean(workflowTokenBudget?.softLimitReached),
      hardMaxUserChars: workflowTokenBudget?.policy.maxUserPromptChars ?? 24_000,
      slots: {
        goal: goalSlot,
        ...(slotBlock ? { slot: slotBlock } : {}),
        ...(recalledFinanceBlock ? { recall_finance: recalledFinanceBlock } : {}),
        ...(recalledSkillsBlock ? { recall_skill: recalledSkillsBlock } : {}),
        ...(recalledGeneralBlock ? { recall_general: recalledGeneralBlock } : {}),
        ...(sessionBlock ? { session: sessionBlock } : {}),
        ...(workingBlock ? { working: workingBlock } : {}),
        ...(controlParts.length ? { control: controlParts.join("\n") } : {}),
      },
    });
    incContextMetric("context.envelope_assemble", 1, {
      role: state.agentDefinition.role,
    });
    rawUserPrompt = envelope.rendered?.user ?? "";
  } else {
    rawUserPrompt = userPromptParts.filter(Boolean).join("\n");
  }
  const userPromptResult = truncatePromptText(
    rawUserPrompt,
    workflowTokenBudget?.policy.maxUserPromptChars ?? 24_000,
    "user prompt"
  );
  const userPrompt = userPromptResult.text;
  promptCompacted ||= userPromptResult.truncated;

  try {
    const baseSystem = await resolveEffectiveSystemPrompt(
      state.agentDefinition.id,
      state.agentDefinition.systemPrompt
    );
    const fsiSystem = await enrichSystemPromptWithFsi({
      role: state.agentDefinition.role,
      basePrompt: baseSystem,
      declaredSkillIds: state.agentDefinition.skills ?? [],
      queryText: taskQuery,
      maxSkills: 2,
      maxSkillChars: 6000,
      maxPlaybooks: 1,
      maxPlaybookChars: 2500,
    });
    /** Goal 模式把固定拓扑降级为建议调用链；Agent / Plan 仍遵守画布拓扑。 */
    const topologyBlock =
      state.agentDefinition.role === "orchestrator" &&
      workflowMeta.agentMode === "goal" &&
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
        ? `${systemWithHitl}\n\n---\n## 调度决策（重要）\n你是编排者，收到用户消息后**先判断该怎么处理，默认由你作为唯一大脑做决策**：\n- 能用「本次会话上下文 / 已有研究结论」直接回答的（总结、解释、澄清、对比、追问）→ 直接给出最终答复，**不调用任何团队工具、不广播**。\n- 只缺一块证据或一个专业判断 → 优先用拓扑中现成的 \`call_team_<role>\` 定向派给该专家；仅当没有对应拓扑工具时才用 \`assign_task\`。\n- 需要多视角时，也只按需分别派给 2-3 个专家，再由你自己比较与裁决；不要为了“完整流程”一次拉起整队。\n- 除非用户明确要求“完整团队报告 / 团队会审”，否则不要使用批量团队编排思路。\n面向用户的回答要清晰、可执行；不要在能直接回答时还去惊动整支团队。\n\n## 交付纪律（重要）\n- 你和专家都应围绕**当前技术目标**交付最小必要结果：结论、关键证据、下一步。\n- 除非用户明确要求，**不要生成长报告、模板化章节、完整 Executive Summary、冗长复盘**。\n- 若用户要的是某个技术判断、一个候选名单、一段回测结论或一个风险结论，就只交付那个，不要顺手扩写成整份报告。\n\n## 计划可见（重要）\n- 只有需要 **3 个以上不同业务动作** 的任务才调用一次 \`update_plan\` 建计划；单次专家派单、一次行情拉取或一句话能答的任务禁止建计划，直接执行。\n- 建计划后必须立即执行下一项业务工具；禁止连续调用 \`update_plan\`。\n- 只有阶段发生实质变化时才更新计划，整个任务通常不超过“开工一次 + 收口一次”两次计划写入；计划维护不能替代业务执行。${
            workflowMeta.agentMode === "goal"
              ? "\n\n## 按需召唤专家（Goal 模式）\n当前为 Goal 模式：若需要团队当前编组里没有的专长，可以直接 `assign_task` 派给对应专家角色，系统会按需拉入；但必须把结果和验证状态同步回计划。"
              : ""
          }`
        : systemWithHitl;
    const focusedScenarioBlock = buildFocusedResearchScenarioPrompt(effective.scenarioKey);
    const systemWithScenarioContract = focusedScenarioBlock
      ? `${systemWithDispatch}\n\n---\n${focusedScenarioBlock}`
      : systemWithDispatch;
    const topologyTaskContract =
      String(payload.taskType ?? "") === "topology_dispatch" &&
      state.agentDefinition.role !== "orchestrator"
        ? buildTopologySpecialistExecutionContract(
            state.agentDefinition.role,
            String((payload.params as Record<string, unknown> | undefined)?.goal ?? "")
          )
        : "";
    /** 通用运行时工作纪律：增量推进、失败自适应、先查后做；无需重新 seed Agent。 */
    const WORK_STYLE_BLOCK = [
      "## 工作方式（重要）",
      "- **增量推进**：把任务拆成小步，一步步来；每步只做一件事，拿到结果再决定下一步，不要一次性假设整条流程。",
      "- **先查后做**：动手前若有 `search_memory` / `skill.search` 等工具，先看有没有可复用的先例或既有结论；稳定的方法与产物可以复用。",
      focusedScenarioBlock
        ? "- **场景探活预算**：本场景默认不重复 `market.readiness`；探活失败记为 data-gap，不得当作唯一结案。"
        : "- **实时状态必须重验**：记忆里的“行情源不可用 / 网络失败 / 凭证缺失 / 熔断”是过期风险很高的历史状态，只能作提示，不能替代当前探测。只要当前工具面有 `market.readiness` / `market.data_sources` / `fetch_klines`，在本工作流尚无同类失败证据时，必须至少做一次当前健康检查或真实拉取后，才能宣告数据不可用。",
      "- **失败自适应**：工具失败时先读取最近 observation 的 `recovery`：`retry_once` 只允许原调用再试一次，`switch_tool` 必须从 alternatives 换源并按新工具参数重组调用，`continue_with_limits` 禁止继续空转。",
      "- **无数据交付**：没有可靠数据时仍完成不依赖该数据的部分；明确列出已知事实、缺失证据、采用的假设和置信度。核心结论依赖缺失事实时，只给‘若 A 则 B’的条件式结论，并说明拿到什么数据后如何验证。",
      "- **最小交付**：只返回完成当前目标所需的最小结果；除非明确要求，不要主动生成长报告、固定模板章节或泛泛总结。",
      "- **诚实**：没有数据支撑就说不确定；不要编造工具结果或假装已完成。",
    ].join("\n");
    const modeBlock = buildAgentControlModePrompt(
      workflowMeta.agentMode,
      state.agentDefinition.role === "orchestrator"
    );
    const processBlock =
      state.agentDefinition.role === "orchestrator"
        ? buildWorkflowProcessPrompt(
            resolveEffectiveWorkflowProcessConfig(
              workflowMeta.processConfig,
              workflowMeta.agentMode
            )
          )
        : "";
    const systemWithWorkStyle = `${systemWithScenarioContract}${
      topologyTaskContract ? `\n\n---\n${topologyTaskContract}` : ""
    }\n\n---\n${WORK_STYLE_BLOCK}${
      modeBlock ? `\n\n---\n${modeBlock}` : ""
    }${processBlock ? `\n\n---\n${processBlock}` : ""}`;
    const { full: rawSystemPrompt, toolsBlock } = assembleAgentSystemPrompt(systemWithWorkStyle, {
      tools: promptTools,
      mcpServers,
      nativeToolCalling,
    });
    const systemPromptResult = truncatePromptText(
      rawSystemPrompt,
      workflowTokenBudget?.policy.maxSystemPromptChars ?? 20_000,
      "system prompt"
    );
    const systemPrompt = systemPromptResult.text;
    promptCompacted ||= systemPromptResult.truncated;
    systemPromptLen = systemPrompt.length;
    userPromptLen = userPrompt.length;
    promptEstimatedTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
    promptComponentChars = {
      baseSystem: baseSystem.length,
      fsiAdded: Math.max(0, fsiSystem.length - baseSystem.length),
      topologyAndRuntime: Math.max(0, systemWithWorkStyle.length - fsiSystem.length),
      tools: toolsBlock.length,
      systemFinal: systemPrompt.length,
      userGoalAndContext: fixedSnippet.length,
      observations: JSON.stringify(previousObservations).length,
      userFinal: userPrompt.length,
      selectedTools: promptTools.length,
      authorizedTools: tools.length,
    };
    console.log(
      `[reason] invoking LLM role=${state.agentDefinition.role} provider=${modelConfig.provider}:${modelConfig.model} ` +
        `systemChars=${systemPromptLen} userChars=${userPromptLen}`
    );

    /**
     * P1：把 agent_definition.llm_config_json 反序列化结果转成 sampling，注入到
     * 网关。空配置 / 老 agent 行 → sampling = {} → 网关走默认值（与 P0 完全兼容）。
     */
    const samplingFromAgent = agentLlmConfigToSampling(state.agentDefinition.llmConfig);
    const samplingForReason = {
      maxOutputTokens: 2048,
      ...samplingFromAgent,
    };
    const nativeToolDefinition = nativeToolCalling
      ? buildNativeQubitToolDefinition(promptTools)
      : null;
    const llmResult = await invokeWithFallback(modelConfig, {
      systemPrompt,
      userPrompt,
      sampling: samplingForReason,
      ...(nativeToolDefinition ? { tools: [nativeToolDefinition] } : {}),
      signal: cancellationSignal,
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
      onReasoningToken: (token) => {
        emit({
          runId: state.runId,
          workflowId: state.workflowId,
          traceId: state.traceId,
          role: state.agentDefinition.role,
          type: "reasoning_token",
          stepIndex: state.iteration,
          ts: Date.now(),
          payload: { token, provider: modelConfig.provider, model: modelConfig.model },
        });
      },
    });
    answer = llmResult.answer;
    if (nativeToolDefinition) {
      const nativeSentinel = llmResult.toolCalls
        ?.map((call) => nativeToolCallToSentinel(call, promptTools))
        .find((value): value is string => Boolean(value));
      if (nativeSentinel) {
        answer = `${answer.trim()}\n\n${nativeSentinel}`.trim();
        nativeToolCallingUsed = true;
      }
    }
    modelFallbackUsed = llmResult.fallbackUsed;
    usage = llmResult.usage;
    measuredLatencyMs = llmResult.latencyMs;
    firstTokenLatencyMs = llmResult.firstTokenLatencyMs;
    finishReason = llmResult.finishReason;
    responseId = llmResult.responseId;
    if (llmResult.lengthRetryUsed) lengthRetryUsed = true;
    transportAttempts += llmResult.transportAttempts ?? 1;
    if (llmResult.lastError) lastGatewayError = llmResult.lastError;
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
      const parsed = parseToolCallFromReason(answer, promptTools);
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
            sampling: samplingForReason,
            signal: cancellationSignal,
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
            onReasoningToken: (token) => {
              emit({
                runId: state.runId,
                workflowId: state.workflowId,
                traceId: state.traceId,
                role: state.agentDefinition.role,
                type: "reasoning_token",
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
          const retriedParsed = parseToolCallFromReason(retryResult.answer, promptTools);
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
            transportAttempts += retryResult.transportAttempts ?? 1;
            if (retryResult.lastError) lastGatewayError = retryResult.lastError;
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
    if (
      workflowCancellationSignal.aborted ||
      isWorkflowCancellationRequested(state.workflowId)
    ) {
      throw new WorkflowCancelledError(state.workflowId);
    }
    const errMsg = LlmGatewayError.is(error)
      ? error.toLogLine()
      : ((error as Error).message ?? String(error));
    const fallback = LlmGatewayError.is(error)
      ? error.toLogLine()
      : `LLM gateway error: ${errMsg}`;
    if (LlmGatewayError.is(error)) {
      lastGatewayError = error.toJSON();
    }
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
      ...(transportAttempts > 0 ? { transportAttempts } : {}),
      ...(lastGatewayError
        ? {
            gatewayErrorCode: lastGatewayError.code,
            gatewayError: lastGatewayError as unknown as Record<string, unknown>,
          }
        : {}),
      ...(nativeToolCallingUsed ? { nativeToolCallingUsed: true } : {}),
      ...(workflowTokenBudget?.softLimitReached ? { tokenBudgetSoftLimitReached: true } : {}),
      promptComponentChars,
      promptEstimatedTokens,
      promptCompacted,
    },
  };
}
