import type { AgentRole } from "../../types/entities";

export type FsiSteeringExample = {
  event: string;
  description?: string;
  workflowSlug?: string;
};

export type FsiSkillEntry = {
  path: string;
  maxInjectChars?: number;
};

export type FsiBundle = {
  label: string;
  description?: string;
  skillIds: string[];
};

export type FsiAgentWorkflow = {
  label: string;
  playbookPath: string;
  playbookMaxChars?: number;
  fuseIntoRoles: AgentRole[];
  skillIds: string[];
  sandboxPreset?: string;
  steeringExamples?: FsiSteeringExample[];
};

export type FsiMcpCatalogEntry = {
  name: string;
  transport: "http" | "stdio" | "ws";
  url?: string;
  command?: string;
  envVar?: string;
  description: string;
  vertical?: string;
};

export type FsiSandboxPreset = {
  name: string;
  description: string;
  canWriteMemory: boolean;
  canReadLiveMarket: boolean;
  canSubmitOrder: boolean;
  isolationLevel: "none" | "process" | "vm";
  maxIterationsPerRun: number;
  maxOutputTokens: number;
  denyMcp?: boolean;
  denyWriteTools?: boolean;
};

export type FsiManifest = {
  id: string;
  version: string;
  description: string;
  defaultContentRootHint?: string;
  bundles: Record<string, FsiBundle>;
  skills: Record<string, FsiSkillEntry>;
  agentWorkflows: Record<string, FsiAgentWorkflow>;
  roleSkillDefaults: Partial<Record<AgentRole, string[]>>;
  mcpCatalog: FsiMcpCatalogEntry[];
  sandboxPresets: Record<string, FsiSandboxPreset>;
  outputSchemas: Record<string, Record<string, unknown>>;
  globalSteeringExamples: FsiSteeringExample[];
};

export type FsiResolvedSkill = {
  id: string;
  body: string;
  truncated: boolean;
  sourcePath: string;
};

export type FsiOutputValidationResult = {
  valid: boolean;
  errors: string[];
  sanitized: Record<string, unknown>;
};
