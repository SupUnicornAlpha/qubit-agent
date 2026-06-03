import type { A2AMessageEnvelope } from "../types/a2a";
import type { A2AMessageType, AgentRole } from "../types/entities";

/**
 * 单个 Agent 的 LLM 采样偏好。形如：
 *   `{ "temperature": 0.2, "maxOutputTokens": 8192, "reasoningEffort": "high" }`。
 *
 * 字段全部可选；不写时网关回退到内置默认（temperature=0.1 / maxOutputTokens 与
 * provider 默认对齐 / reasoning effort=medium）。`reasoningEffort` 仅 OpenAI
 * Responses API（gpt-5 / o-series）会读取。
 *
 * 与 `LlmSamplingOverrides`（runtime/llm/gateway.ts）字段一一对应；这里独立定义是
 * 为了避免 db schema 反向依赖网关运行时模块。
 */
export interface AgentLlmConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface RuntimeAgentDefinition {
  id: string;
  role: AgentRole;
  name: string;
  version: string;
  systemPrompt: string;
  tools: string[];
  mcpServers: string[];
  skills: string[];
  subscriptions: A2AMessageType[];
  llmProvider: string;
  /**
   * Per-Agent 采样偏好；DB 列 `agent_definition.llm_config_json` 反序列化得到。
   * 老 agent 行 / seed 没写时为 `undefined` 或 `{}`，等价于全部走网关默认值。
   */
  llmConfig?: AgentLlmConfig;
  maxIterations: number;
  sandboxPolicyId: string;
  enabled: boolean;
}

export interface RuntimeAgentInstance {
  instanceId: string;
  definitionId: string;
  role: AgentRole;
  status: "idle" | "running" | "error" | "stopped";
}

export interface RuntimeHandlerContext {
  definition: RuntimeAgentDefinition;
  instance: RuntimeAgentInstance;
  send: (
    params: Omit<A2AMessageEnvelope, "messageId" | "createdAt" | "senderAgent">
  ) => Promise<void>;
  markIteration: (workflowId: string) => number;
}

export interface RuntimeRoleHandler {
  onInit?: (ctx: RuntimeHandlerContext) => Promise<void>;
  onMessage: (ctx: RuntimeHandlerContext, msg: A2AMessageEnvelope) => Promise<void>;
  onShutdown?: (ctx: RuntimeHandlerContext) => Promise<void>;
}

