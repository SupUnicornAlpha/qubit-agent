import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { agentProfile, chatMessage, workflowRun } from "../../../db/sqlite/schema";
import {
  type PromptMode,
  getDataDir,
  mergeSystemPrompt,
  readPackFiles,
} from "../../agent/agent-pack-service";
import { resolveLlmForAgent, invokeWithFallback } from "../../llm/llm-router";
import type { LlmTokenUsage } from "../../llm/gateway";
import { assembleAgentSystemPrompt, parseToolCallFromReason } from "../../tools/tool-call-format";
import { enrichSystemPromptWithFsi } from "../../fsi/fsi-prompt-enricher";
import { resolveEffectiveAgentTools } from "../../orchestration/resolve-effective-tools";
import { resolveEnabledMcpServerNames } from "../../mcp/resolve-enabled-mcp-servers";
import { skillService, renderSkillsBlockForPrompt } from "../../skills/skill-service";
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
}

export interface ReasonNodeOutput {
  /** State delta to merge into the LangGraph workflow state. */
  stateUpdate: Partial<AgentGraphState>;
  /** Observability metadata used by execute-agent-react to fill agent_step. */
  meta: ReasonStepMeta;
}

async function loadWorkflowMeta(
  workflowId: string
): Promise<{ projectId: string | null; sessionId: string | null }> {
  const db = await getDb();
  const wfRows = await db
    .select({ projectId: workflowRun.projectId, sessionId: workflowRun.sessionId })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  if (!wfRows[0]) return { projectId: null, sessionId: null };
  return { projectId: wfRows[0].projectId ?? null, sessionId: wfRows[0].sessionId ?? null };
}

async function loadSessionContext(workflowId: string, limit = 8): Promise<string[]> {
  const db = await getDb();
  const wfRows = await db
    .select({ sessionId: workflowRun.sessionId })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  const sessionId = wfRows[0]?.sessionId;
  if (!sessionId) return [];

  const rows = await db
    .select({
      role: chatMessage.role,
      content: chatMessage.content,
      status: chatMessage.status,
      createdAt: chatMessage.createdAt,
    })
    .from(chatMessage)
    .where(eq(chatMessage.sessionId, sessionId))
    .orderBy(desc(chatMessage.createdAt))
    .limit(limit);

  return rows
    .reverse()
    .map((m) => `[${m.role}/${m.status}] ${String(m.content ?? "").trim()}`)
    .filter((line) => line.length > 0);
}

async function resolveEffectiveSystemPrompt(definitionId: string, dbSystemPrompt: string): Promise<string> {
  const db = await getDb();
  const profRows = await db.select().from(agentProfile).where(eq(agentProfile.definitionId, definitionId)).limit(1);
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

  const payload = state.inboundMessage.payload as Record<string, unknown>;
  const payloadParams = (payload["params"] ?? {}) as Record<string, unknown>;
  const payloadGoal =
    payloadParams["goal"] ??
    payload["goal"] ??
    payload["message"] ??
    JSON.stringify(state.inboundMessage.payload);
  const slotContext =
    typeof payloadParams["context"] === "string" ? payloadParams["context"].trim() : "";
  const slotTicker =
    typeof payloadParams["ticker"] === "string" ? payloadParams["ticker"].trim() : "";
  const previousObservations = state.observations.slice(-3);
  const sessionContext = await loadSessionContext(state.workflowId);

  const effective = await resolveEffectiveAgentTools(state.agentDefinition, state.workflowId);
  const tools = effective.tools;
  const mcpServers = await resolveEnabledMcpServerNames(state.agentDefinition.mcpServers ?? []);
  const hasTools = tools.length > 0 || mcpServers.length > 0;

  // M11: 召回相关 skill。失败不阻塞推理（skill 表可能在新 workspace 还没建）。
  let recalledSkillsBlock = "";
  try {
    const meta = await loadWorkflowMeta(state.workflowId);
    if (meta.projectId) {
      const query = [
        typeof payloadGoal === "string" ? payloadGoal : String(payloadGoal ?? ""),
        slotTicker,
        slotContext.slice(0, 240),
      ]
        .filter((s) => typeof s === "string" && s.length > 0)
        .join(" ");
      const hits = await skillService.search({
        projectId: meta.projectId,
        query,
        definitionId: state.agentDefinition.id,
        topK: 3,
      });
      if (hits.length > 0) {
        recalledSkillsBlock = renderSkillsBlockForPrompt(hits);
        if (process.env.DEBUG_SKILLS) {
          console.log(
            `[reason] recalled skills for ${state.agentDefinition.role}: ${hits.map((s) => s.name).join(", ")}`
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

  const userPromptParts = [
    `你是 ${state.agentDefinition.role} Agent，请根据以下任务目标给出分析与回应。`,
    ``,
    `**任务目标**：${payloadGoal}`,
    slotTicker ? `**标的**：${slotTicker}` : "",
    slotContext ? `\n**任务上下文（数据快照 / 编排简报 / 前置结论）**：\n${slotContext.slice(0, 12000)}` : "",
    recalledSkillsBlock ? `\n${recalledSkillsBlock}` : "",
    sessionContext.length
      ? `\n**会话历史（最近 ${sessionContext.length} 条）**：\n${sessionContext.join("\n")}`
      : "",
    previousObservations.length
      ? `\n**历史观测（最近 ${previousObservations.length} 步）**：\n${JSON.stringify(previousObservations, null, 2)}`
      : "",
    state.iteration > 1 ? `\n**当前迭代**：第 ${state.iteration} 轮` : "",
  ];

  if (hasTools) {
    userPromptParts.push(
      "",
      "若本步需要调用工具，请在分析文字之后附上**唯一一个** JSON 工具调用块（见系统提示中的格式）；若仅需文字结论则使用 `{\"tool\":\"none\"}`。"
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
    const topologyOrCollab = effective.topologyPromptBlock || effective.collaborationHint;
    const systemWithTopology = topologyOrCollab
      ? `${fsiSystem}\n\n---\n${topologyOrCollab}`
      : fsiSystem;
    const { full: systemPrompt } = assembleAgentSystemPrompt(systemWithTopology, { tools, mcpServers });

    const llmResult = await invokeWithFallback(modelConfig, {
      systemPrompt,
      userPrompt,
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
            onToken: (token) => {
              emit({
                runId: state.runId,
                workflowId: state.workflowId,
                traceId: state.traceId,
                role: state.agentDefinition.role,
                type: "token",
                stepIndex: state.iteration,
                ts: Date.now(),
                payload: { token, provider: modelConfig.provider, model: modelConfig.model, retry: true },
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
              };
            } else if (retryResult.usage) {
              usage = retryResult.usage;
            }
            console.log(
              `[reason] agent ${state.agentDefinition.role} parse-retry succeeded ` +
                `(orig parse_error → retried OK)`
            );
          } else {
            console.warn(
              `[reason] agent ${state.agentDefinition.role} parse-retry also failed: ${retriedParsed.message}`
            );
          }
        } catch (retryErr) {
          console.warn(
            `[reason] agent ${state.agentDefinition.role} parse-retry threw: ` +
              (retryErr instanceof Error ? retryErr.message : String(retryErr))
          );
        }
      }
    }
  } catch (error) {
    const fallback = `LLM gateway error: ${(error as Error).message}`;
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
  }

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
    },
  };
}
