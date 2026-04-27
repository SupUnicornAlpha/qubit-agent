import OpenAI from "openai";
import type { AgentGraphState, StepStreamEvent } from "../state";
import { loadModelConfig } from "../../config/model-config";

function splitForPseudoStreaming(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export async function reasonNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void
): Promise<Partial<AgentGraphState>> {
  const runtimeModel = await loadModelConfig();
  const apiKey = runtimeModel?.apiKey || process.env["OPENAI_API_KEY"];
  const modelName = runtimeModel?.model || "gpt-4o-mini";
  const baseUrl = runtimeModel?.baseUrl;
  let answer = "";

  if (apiKey) {
    const client = new OpenAI({ apiKey, baseURL: baseUrl });
    const stream = await client.chat.completions.create({
      model: modelName,
      messages: [
        { role: "system", content: state.agentDefinition.systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            workflowId: state.workflowId,
            messageType: state.inboundMessage.messageType,
            payload: state.inboundMessage.payload,
            contextMemory: state.contextMemory,
          }),
        },
      ],
      temperature: 0.1,
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (!token) continue;
      answer += token;
      emit({
        runId: state.runId,
        workflowId: state.workflowId,
        traceId: state.traceId,
        role: state.agentDefinition.role,
        type: "token",
        stepIndex: state.iteration,
        ts: Date.now(),
        payload: { token },
      });
    }
  } else {
    answer = `Mock reason result for role=${state.agentDefinition.role}`;
    const tokens = splitForPseudoStreaming(answer);
    for (const token of tokens) {
      emit({
        runId: state.runId,
        workflowId: state.workflowId,
        traceId: state.traceId,
        role: state.agentDefinition.role,
        type: "token",
        stepIndex: state.iteration,
        ts: Date.now(),
        payload: { token },
      });
    }
  }

  return {
    reasonText: answer,
    plannedAction: "tool_call",
  };
}

