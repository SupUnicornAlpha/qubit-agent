export type WorkflowMode = "research" | "backtest" | "simulation" | "live";

export interface WorkflowCreateInput {
  projectId: string;
  goal: string;
  mode: WorkflowMode;
}

export interface AgentSummary {
  id: string;
  definitionId: string;
  role: string;
  version: string;
  running: boolean;
}

export interface StepStreamEvent {
  runId: string;
  workflowId: string;
  traceId: string;
  role: string;
  type:
    | "token"
    | "tool_call_start"
    | "tool_call_end"
    | "observe"
    | "step_persisted"
    | "final"
    | "error";
  stepIndex: number;
  ts: number;
  payload: Record<string, unknown>;
}

export interface AgentsConfigResponse {
  sourceOfTruth: string;
  diffSummary: {
    isSynced: boolean;
    counts: {
      fileDefinitions: number;
      dbDefinitions: number;
      filePolicies: number;
      dbPolicies: number;
    };
    missingDefinitionsInDb: string[];
    extraDefinitionsInDb: string[];
    missingPoliciesInDb: string[];
    extraPoliciesInDb: string[];
  };
  workspace: {
    exists: boolean;
    configDir: string;
    agentsFile: string;
    sandboxFile: string;
    config: unknown;
  };
  dbEffective: {
    definitions: unknown[];
    policies: unknown[];
  };
  runtime: {
    activeAgents: AgentSummary[];
  };
}

export interface ModelConfig {
  provider: "openai";
  model: string;
  apiKey: string;
  baseUrl?: string;
}

