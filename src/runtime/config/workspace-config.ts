import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeAgentDefinition } from "../types";

const AgentRoleSchema = z.enum([
  "orchestrator",
  "market_data",
  "news_event",
  "research",
  "backtest",
  "simulation",
  "risk",
  "execution",
  "memory",
  "audit",
]);

const A2ATypeSchema = z.enum([
  "TASK_ASSIGN",
  "TASK_RESULT",
  "RISK_BLOCK",
  "ORDER_INTENT",
  "MODEL_UPDATE",
  "MEMORY_WRITE",
  "ALERT",
]);

const AgentDefSchema = z.object({
  id: z.string().min(1),
  role: AgentRoleSchema,
  name: z.string().min(1),
  version: z.string().default("1.0.0"),
  systemPrompt: z.string().default(""),
  tools: z.array(z.string()).default([]),
  mcpServers: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  subscriptions: z.array(A2ATypeSchema).default(["TASK_ASSIGN"]),
  llmProvider: z.string().default("openai:gpt-4o-mini"),
  maxIterations: z.number().int().positive().default(20),
  sandboxPolicyId: z.string().default("default-policy"),
  enabled: z.boolean().default(true),
});

const AgentsFileSchema = z.object({
  definitions: z.array(AgentDefSchema).default([]),
});

const SandboxPolicySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  allowedTools: z.array(z.string()).default([]),
  allowedMcpServers: z.array(z.string()).default([]),
  allowedConnectors: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  allowedFsPaths: z.array(z.string()).default([]),
  maxToolCallMs: z.number().int().positive().default(30_000),
  maxIterationsPerRun: z.number().int().positive().default(20),
  maxOutputTokens: z.number().int().positive().default(4096),
  isolationLevel: z.enum(["none", "process", "vm"]).default("none"),
  canWriteMemory: z.boolean().default(true),
  canReadLiveMarket: z.boolean().default(false),
  canSubmitOrder: z.boolean().default(false),
});

const SandboxFileSchema = z.object({
  policies: z.array(SandboxPolicySchema).default([]),
});

export type WorkspaceSandboxPolicy = z.infer<typeof SandboxPolicySchema>;

export interface WorkspaceRuntimeConfig {
  definitions: RuntimeAgentDefinition[];
  policies: WorkspaceSandboxPolicy[];
}

export interface WorkspaceRuntimeFileBundle {
  exists: boolean;
  config: WorkspaceRuntimeConfig | null;
  configDir: string;
  agentsFile: string;
  sandboxFile: string;
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(raw));
}

export async function loadWorkspaceRuntimeConfig(
  rootDir = process.cwd()
): Promise<WorkspaceRuntimeFileBundle> {
  const configDir = join(rootDir, ".qubit");
  const agentsFile = join(configDir, "agents.json");
  const sandboxFile = join(configDir, "sandbox.json");
  const hasAgents = existsSync(agentsFile);
  const hasSandbox = existsSync(sandboxFile);
  if (!hasAgents || !hasSandbox) {
    return {
      exists: false,
      config: null,
      configDir,
      agentsFile,
      sandboxFile,
    };
  }

  const [agentsRaw, sandboxRaw] = await Promise.all([
    readFile(agentsFile, "utf-8"),
    readFile(sandboxFile, "utf-8"),
  ]);
  const agents = parseJson(agentsRaw, AgentsFileSchema);
  const sandbox = parseJson(sandboxRaw, SandboxFileSchema);
  return {
    exists: true,
    config: {
      definitions: agents.definitions as RuntimeAgentDefinition[],
      policies: sandbox.policies,
    },
    configDir,
    agentsFile,
    sandboxFile,
  };
}

export async function ensureWorkspaceRuntimeConfigFiles(params: {
  rootDir?: string;
  definitions: RuntimeAgentDefinition[];
  policies: WorkspaceSandboxPolicy[];
}): Promise<void> {
  const rootDir = params.rootDir ?? process.cwd();
  const configDir = join(rootDir, ".qubit");
  const agentsFile = join(configDir, "agents.json");
  const sandboxFile = join(configDir, "sandbox.json");
  await mkdir(configDir, { recursive: true });
  if (!existsSync(agentsFile)) {
    await writeFile(
      agentsFile,
      JSON.stringify({ definitions: params.definitions }, null, 2),
      "utf-8"
    );
  }
  if (!existsSync(sandboxFile)) {
    await writeFile(
      sandboxFile,
      JSON.stringify({ policies: params.policies }, null, 2),
      "utf-8"
    );
  }
}

