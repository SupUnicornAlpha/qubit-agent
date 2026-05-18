import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { agentProfile, chatMessage, workflowRun } from "../../../db/sqlite/schema";
import {
  type PromptMode,
  getDataDir,
  mergeSystemPrompt,
  readPackFiles,
} from "../../agent/agent-pack-service";
import { loadModelConfig } from "../../config/model-config";
import { runLlmGateway } from "../../llm/gateway";
import { assembleAgentSystemPrompt } from "../../tools/tool-call-format";
import type { AgentGraphState, StepStreamEvent } from "../state";

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
): Promise<Partial<AgentGraphState>> {
  const runtimeModel = await loadModelConfig();
  const modelConfig = runtimeModel ?? {
    provider: "mock" as const,
    model: "mock-reasoner",
    apiKey: "",
  };
  let answer = "";

  const payloadGoal =
    (state.inboundMessage.payload as Record<string, unknown>)?.goal ??
    (state.inboundMessage.payload as Record<string, unknown>)?.message ??
    JSON.stringify(state.inboundMessage.payload);
  const previousObservations = state.observations.slice(-3);
  const sessionContext = await loadSessionContext(state.workflowId);

  const tools = state.agentDefinition.tools ?? [];
  const mcpServers = state.agentDefinition.mcpServers ?? [];
  const hasTools = tools.length > 0 || mcpServers.length > 0;

  const userPromptParts = [
    `你是 ${state.agentDefinition.role} Agent，请根据以下任务目标给出分析与回应。`,
    ``,
    `**任务目标**：${payloadGoal}`,
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
    const { full: systemPrompt } = assembleAgentSystemPrompt(baseSystem, { tools, mcpServers });

    answer = await runLlmGateway({
      config: modelConfig,
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
  }

  return {
    reasonText: answer,
    plannedAction: hasTools ? "tool_call" : "respond_only",
  };
}
