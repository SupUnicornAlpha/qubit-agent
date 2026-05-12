import type { AgentGraphState, StepStreamEvent } from "../state";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { chatMessage, workflowRun } from "../../../db/sqlite/schema";
import { loadModelConfig } from "../../config/model-config";
import { runLlmGateway } from "../../llm/gateway";

async function loadSessionContext(workflowId: string, limit = 8): Promise<string[]> {
  const db = await getDb();
  const wfRows = await db
    .select({ sessionId: workflowRun.sessionId })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  const sessionId = wfRows[0]?.sessionId;
  if (!sessionId) return [];

  // Latest N messages in the same chat session as conversation context.
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

  // Build a natural-language user prompt so the LLM can respond conversationally.
  const payloadGoal =
    (state.inboundMessage.payload as Record<string, unknown>)?.goal ??
    (state.inboundMessage.payload as Record<string, unknown>)?.message ??
    JSON.stringify(state.inboundMessage.payload);
  const previousObservations = state.observations.slice(-3); // last 3 for context window
  const sessionContext = await loadSessionContext(state.workflowId);
  const userPrompt = [
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
  ]
    .filter(Boolean)
    .join("\n");

  try {
    answer = await runLlmGateway({
      config: modelConfig,
      systemPrompt: state.agentDefinition.systemPrompt,
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
    plannedAction: "tool_call",
  };
}

