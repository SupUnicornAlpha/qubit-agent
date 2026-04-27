import { getDb } from "../db/sqlite/client";
import { agentDefinition, llmProviderConfig, sandboxPolicy } from "../db/sqlite/schema";
import type { RuntimeAgentDefinition } from "./types";

const DEFAULT_SANDBOX_POLICY = {
  id: "default-policy",
  name: "default-policy",
  description: "Default runtime policy for bootstrap phase.",
  allowedToolsJson: [],
  allowedMcpServersJson: [],
  allowedConnectorsJson: [],
  allowedHostsJson: [],
  allowedFsPathsJson: [],
  canWriteMemory: true,
  canReadLiveMarket: false,
  canSubmitOrder: false,
  maxToolCallMs: 30_000,
  maxIterationsPerRun: 20,
  maxOutputTokens: 4096,
  isolationLevel: "none" as const,
};

const DEFAULT_LLM_PROVIDER = {
  id: "llm-openai-gpt-4o",
  providerId: "openai:gpt-4o",
  providerType: "openai" as const,
  baseUrl: null,
  modelName: "gpt-4o",
  apiKeyRef: null,
  contextWindow: 128_000,
  supportsFunctionCalling: true,
  enabled: true,
};

const DEFAULT_DEFINITIONS: RuntimeAgentDefinition[] = [
  {
    id: "def-orchestrator",
    role: "orchestrator",
    name: "Orchestrator",
    version: "1.0.0",
    systemPrompt: "Task decomposition and workflow coordination.",
    tools: ["task_decompose", "assign_task"],
    mcpServers: [],
    skills: [],
    subscriptions: ["TASK_ASSIGN", "TASK_RESULT", "ALERT", "RISK_BLOCK"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 20,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-market-data",
    role: "market_data",
    name: "MarketData",
    version: "1.0.0",
    systemPrompt: "Collect market data and write snapshots.",
    tools: ["fetch_bars", "fetch_ticks", "write_snapshot"],
    mcpServers: ["qubit-data"],
    skills: [],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 20,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-news-event",
    role: "news_event",
    name: "NewsEvent",
    version: "1.0.0",
    systemPrompt: "Collect news and extract events.",
    tools: ["fetch_news", "extract_event", "score_sentiment"],
    mcpServers: ["qubit-news"],
    skills: [],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 20,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-research",
    role: "research",
    name: "Research",
    version: "1.0.0",
    systemPrompt: "Run factor research and strategy iteration.",
    tools: ["compute_factors", "run_experiment", "version_strategy"],
    mcpServers: ["qubit-research"],
    skills: ["momentum-factor"],
    subscriptions: ["TASK_ASSIGN", "MODEL_UPDATE"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 20,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-backtest",
    role: "backtest",
    name: "Backtest",
    version: "1.0.0",
    systemPrompt: "Run backtest with historical data only.",
    tools: ["run_backtest", "get_backtest_status"],
    mcpServers: ["qubit-backtest"],
    skills: [],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 20,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-simulation",
    role: "simulation",
    name: "Simulation",
    version: "1.0.0",
    systemPrompt: "Run paper trading simulation.",
    tools: ["submit_paper_order", "get_paper_position"],
    mcpServers: ["qubit-sim"],
    skills: [],
    subscriptions: ["TASK_ASSIGN", "ORDER_INTENT"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 20,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-risk",
    role: "risk",
    name: "Risk",
    version: "1.0.0",
    systemPrompt: "Evaluate and sign order intents.",
    tools: ["evaluate_risk", "sign_intent", "load_rules"],
    mcpServers: [],
    skills: [],
    subscriptions: ["TASK_ASSIGN", "ORDER_INTENT"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 20,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-execution",
    role: "execution",
    name: "Execution",
    version: "1.0.0",
    systemPrompt: "Route signed order intents to broker adapters.",
    tools: ["submit_order", "cancel_order", "get_fills"],
    mcpServers: ["qubit-broker"],
    skills: [],
    subscriptions: ["TASK_ASSIGN", "ORDER_INTENT"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 20,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-memory",
    role: "memory",
    name: "Memory",
    version: "1.0.0",
    systemPrompt: "Route memory read/write and manage TTL cleanup.",
    tools: ["write_memory", "search_memory", "cleanup_ttl"],
    mcpServers: [],
    skills: [],
    subscriptions: ["TASK_ASSIGN", "MEMORY_WRITE"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 20,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-audit",
    role: "audit",
    name: "Audit",
    version: "1.0.0",
    systemPrompt: "Archive and query full audit trails.",
    tools: ["write_audit_log", "generate_report"],
    mcpServers: [],
    skills: [],
    subscriptions: [
      "TASK_ASSIGN",
      "TASK_RESULT",
      "RISK_BLOCK",
      "ORDER_INTENT",
      "MODEL_UPDATE",
      "MEMORY_WRITE",
      "ALERT",
    ],
    llmProvider: "openai:gpt-4o",
    maxIterations: 20,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
];

export async function seedAgentDefinitions(): Promise<void> {
  const db = await getDb();

  await db
    .insert(sandboxPolicy)
    .values(DEFAULT_SANDBOX_POLICY)
    .onConflictDoUpdate({
      target: sandboxPolicy.id,
      set: {
        ...DEFAULT_SANDBOX_POLICY,
        updatedAt: new Date().toISOString(),
      },
    });

  await db
    .insert(llmProviderConfig)
    .values(DEFAULT_LLM_PROVIDER)
    .onConflictDoUpdate({
      target: llmProviderConfig.id,
      set: DEFAULT_LLM_PROVIDER,
    });

  for (const def of DEFAULT_DEFINITIONS) {
    await db
      .insert(agentDefinition)
      .values({
        id: def.id,
        role: def.role,
        name: def.name,
        version: def.version,
        systemPrompt: def.systemPrompt,
        toolsJson: def.tools,
        mcpServersJson: def.mcpServers,
        skillsJson: def.skills,
        subscriptionsJson: def.subscriptions,
        llmProvider: def.llmProvider,
        maxIterations: def.maxIterations,
        sandboxPolicyId: def.sandboxPolicyId,
        enabled: def.enabled,
      })
      .onConflictDoUpdate({
        target: agentDefinition.id,
        set: {
          role: def.role,
          name: def.name,
          version: def.version,
          systemPrompt: def.systemPrompt,
          toolsJson: def.tools,
          mcpServersJson: def.mcpServers,
          skillsJson: def.skills,
          subscriptionsJson: def.subscriptions,
          llmProvider: def.llmProvider,
          maxIterations: def.maxIterations,
          sandboxPolicyId: def.sandboxPolicyId,
          enabled: def.enabled,
          updatedAt: new Date().toISOString(),
        },
      });
  }

  console.log(`[Seed] Upserted ${DEFAULT_DEFINITIONS.length} agent definitions.`);
}

if (import.meta.main) {
  await seedAgentDefinitions();
}

