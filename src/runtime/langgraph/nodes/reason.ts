import type { AgentGraphState, StepStreamEvent } from "../state";
import { loadModelConfig } from "../../config/model-config";
import { runLlmGateway } from "../../llm/gateway";

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

  try {
    answer = await runLlmGateway({
      config: modelConfig,
      systemPrompt: state.agentDefinition.systemPrompt,
      userPrompt: JSON.stringify({
        workflowId: state.workflowId,
        messageType: state.inboundMessage.messageType,
        payload: state.inboundMessage.payload,
        contextMemory: state.contextMemory,
      }),
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

