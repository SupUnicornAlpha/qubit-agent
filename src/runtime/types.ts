import type { A2AMessageEnvelope } from "../types/a2a";
import type { A2AMessageType, AgentRole } from "../types/entities";

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

