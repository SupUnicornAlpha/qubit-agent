import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─── Helper: default nanoid-style text PK ────────────────────────────────────

const id = () => text("id").primaryKey();
const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
const updatedAt = () =>
  text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

// ─── 2.1 组织与任务域 ────────────────────────────────────────────────────────

export const workspace = sqliteTable("workspace", {
  id: id(),
  name: text("name").notNull(),
  owner: text("owner").notNull(),
  createdAt: createdAt(),
});

export const project = sqliteTable("project", {
  id: id(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id),
  name: text("name").notNull(),
  marketScope: text("market_scope").notNull(),
  status: text("status", { enum: ["active", "archived", "paused"] })
    .notNull()
    .default("active"),
  createdAt: createdAt(),
});

export const chatSession = sqliteTable("chat_session", {
  id: id(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id),
  projectId: text("project_id").references(() => project.id),
  title: text("title").notNull(),
  status: text("status", { enum: ["active", "archived"] })
    .notNull()
    .default("active"),
  lastActivityAt: createdAt(),
  createdBy: text("created_by").notNull().default("user"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workflowRun = sqliteTable("workflow_run", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  sessionId: text("session_id").references(() => chatSession.id),
  goal: text("goal").notNull(),
  mode: text("mode", { enum: ["research", "backtest", "simulation", "live"] }).notNull(),
  source: text("source", { enum: ["chat", "manual", "api"] })
    .notNull()
    .default("manual"),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("pending"),
  signalFusionId: text("signal_fusion_id"),
  startedAt: createdAt(),
  endedAt: text("ended_at"),
});

export const workflowCompensationTask = sqliteTable("workflow_compensation_task", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("pending"),
  actionType: text("action_type", { enum: ["retry_from_start", "resume", "manual_intervention"] }).notNull(),
  reason: text("reason").notNull().default(""),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  payloadJson: text("payload_json", { mode: "json" }).notNull().default("{}"),
  lastError: text("last_error"),
  nextRunAt: text("next_run_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const scheduledJob = sqliteTable("scheduled_job", {
  id: id(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  sessionId: text("session_id").references(() => chatSession.id),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  cronExpr: text("cron_expr").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  payloadJson: text("payload_json", { mode: "json" }).notNull().default("{}"),
  executionMode: text("execution_mode", {
    enum: ["paper", "live_with_confirm", "live_direct"],
  })
    .notNull()
    .default("paper"),
  nextRunAt: text("next_run_at"),
  lastRunAt: text("last_run_at"),
  createdBy: text("created_by").notNull().default("user"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const scheduledJobRun = sqliteTable(
  "scheduled_job_run",
  {
    id: id(),
    jobId: text("job_id")
      .notNull()
      .references(() => scheduledJob.id),
    triggerAt: text("trigger_at").notNull(),
    status: text("status", { enum: ["pending", "running", "success", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    workflowRunId: text("workflow_run_id").references(() => workflowRun.id),
    intentOrderId: text("intent_order_id"),
    executionReportId: text("execution_report_id"),
    errorMessage: text("error_message"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    jobTriggerUnique: uniqueIndex("idx_scheduled_job_run_job_trigger_unique").on(
      table.jobId,
      table.triggerAt
    ),
  })
);

export const chatMessage = sqliteTable("chat_message", {
  id: id(),
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSession.id),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  sender: text("sender", { enum: ["user", "orchestrator", "agent", "system"] })
    .notNull()
    .default("user"),
  content: text("content").notNull(),
  status: text("status", { enum: ["queued", "running", "completed", "failed"] })
    .notNull()
    .default("queued"),
  errorMessage: text("error_message"),
  tokenCount: integer("token_count"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const chatMessageWorkflowLink = sqliteTable(
  "chat_message_workflow_link",
  {
    id: id(),
    chatMessageId: text("chat_message_id")
      .notNull()
      .references(() => chatMessage.id),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRun.id),
    traceId: text("trace_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    messageWorkflowUnique: uniqueIndex("idx_chat_msg_workflow_unique").on(
      table.chatMessageId,
      table.workflowRunId
    ),
  })
);

// ─── 2.2 Agent 运行时域（V1.2） ───────────────────────────────────────────────

export const sandboxPolicy = sqliteTable("sandbox_policy", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  allowedToolsJson: text("allowed_tools_json", { mode: "json" }).notNull().default("[]"),
  allowedMcpServersJson: text("allowed_mcp_servers_json", { mode: "json" })
    .notNull()
    .default("[]"),
  allowedConnectorsJson: text("allowed_connectors_json", { mode: "json" })
    .notNull()
    .default("[]"),
  allowedHostsJson: text("allowed_hosts_json", { mode: "json" }).notNull().default("[]"),
  allowedFsPathsJson: text("allowed_fs_paths_json", { mode: "json" }).notNull().default("[]"),
  canWriteMemory: integer("can_write_memory", { mode: "boolean" }).notNull().default(true),
  canReadLiveMarket: integer("can_read_live_market", { mode: "boolean" })
    .notNull()
    .default(false),
  canSubmitOrder: integer("can_submit_order", { mode: "boolean" }).notNull().default(false),
  maxToolCallMs: integer("max_tool_call_ms").notNull().default(30_000),
  maxIterationsPerRun: integer("max_iterations_per_run").notNull().default(20),
  maxOutputTokens: integer("max_output_tokens").notNull().default(4096),
  isolationLevel: text("isolation_level", { enum: ["none", "process", "vm"] })
    .notNull()
    .default("none"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const llmProviderConfig = sqliteTable("llm_provider_config", {
  id: id(),
  providerId: text("provider_id").notNull(),
  providerType: text("provider_type", {
    enum: ["openai", "anthropic", "ollama", "custom"],
  }).notNull(),
  baseUrl: text("base_url"),
  modelName: text("model_name").notNull(),
  apiKeyRef: text("api_key_ref"),
  contextWindow: integer("context_window").notNull().default(128_000),
  supportsFunctionCalling: integer("supports_function_calling", { mode: "boolean" })
    .notNull()
    .default(true),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
});

export const mcpServerConfig = sqliteTable("mcp_server_config", {
  id: id(),
  name: text("name").notNull(),
  projectId: text("project_id").references(() => project.id),
  transport: text("transport", { enum: ["stdio", "http", "ws"] }).notNull(),
  command: text("command"),
  url: text("url"),
  capabilitiesJson: text("capabilities_json", { mode: "json" }).notNull().default("[]"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
});

export const mcpToolBinding = sqliteTable("mcp_tool_binding", {
  id: id(),
  projectId: text("project_id").references(() => project.id),
  serverName: text("server_name").notNull(),
  toolName: text("tool_name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  timeoutMs: integer("timeout_ms"),
  retryPolicyJson: text("retry_policy_json", { mode: "json" }).notNull().default("{}"),
  rateLimitJson: text("rate_limit_json", { mode: "json" }).notNull().default("{}"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const mcpRegistrySource = sqliteTable(
  "mcp_registry_source",
  {
    id: id(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    authType: text("auth_type", { enum: ["none", "bearer", "api_key"] })
      .notNull()
      .default("none"),
    authRef: text("auth_ref"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    syncIntervalSec: integer("sync_interval_sec").notNull().default(300),
    lastSyncedAt: text("last_synced_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    sourceNameUnique: uniqueIndex("idx_mcp_registry_source_name_unique").on(table.name),
  })
);

export const mcpCatalogItem = sqliteTable(
  "mcp_catalog_item",
  {
    id: id(),
    sourceId: text("source_id")
      .notNull()
      .references(() => mcpRegistrySource.id),
    externalId: text("external_id").notNull().default(""),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull().default("latest"),
    description: text("description").notNull().default(""),
    provider: text("provider").notNull().default("community"),
    transport: text("transport", { enum: ["stdio", "http", "ws"] }).notNull(),
    riskLevel: text("risk_level", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    specJson: text("spec_json", { mode: "json" }).notNull().default("{}"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    itemSourceSlugUnique: uniqueIndex("idx_mcp_catalog_item_source_slug_unique").on(
      table.sourceId,
      table.slug
    ),
  })
);

export const mcpCatalog = sqliteTable(
  "mcp_catalog",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    provider: text("provider").notNull().default("community"),
    source: text("source").notNull().default("builtin"),
    riskLevel: text("risk_level", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    transport: text("transport", { enum: ["stdio", "http", "ws"] }).notNull(),
    command: text("command"),
    url: text("url"),
    defaultToolName: text("default_tool_name").notNull().default(""),
    defaultTimeoutMs: integer("default_timeout_ms").notNull().default(20_000),
    defaultRetryPolicyJson: text("default_retry_policy_json", { mode: "json" })
      .notNull()
      .default("{}"),
    defaultRateLimitJson: text("default_rate_limit_json", { mode: "json" })
      .notNull()
      .default("{}"),
    defaultCapabilitiesJson: text("default_capabilities_json", { mode: "json" })
      .notNull()
      .default("[]"),
    setupSchemaJson: text("setup_schema_json", { mode: "json" }).notNull().default("{}"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    slugUnique: uniqueIndex("idx_mcp_catalog_slug_unique").on(table.slug),
  })
);

export const mcpCatalogInstall = sqliteTable("mcp_catalog_install", {
  id: id(),
  projectId: text("project_id").references(() => project.id),
  workspaceId: text("workspace_id").references(() => workspace.id),
  sourceId: text("source_id").references(() => mcpRegistrySource.id),
  catalogItemId: text("catalog_item_id").references(() => mcpCatalogItem.id),
  catalogId: text("catalog_id")
    .notNull()
    .references(() => mcpCatalog.id),
  serverName: text("server_name").notNull(),
  status: text("status", { enum: ["installed", "failed"] })
    .notNull()
    .default("installed"),
  installStatus: text("install_status", { enum: ["installed", "failed", "pending", "removed"] })
    .notNull()
    .default("installed"),
  errorMessage: text("error_message"),
  installedBy: text("installed_by").notNull().default("user"),
  createdAt: createdAt(),
});

export const agentDefinition = sqliteTable("agent_definition", {
  id: id(),
  role: text("role", {
    enum: [
      // V1 roles
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
      // V2 analyst team roles
      "analyst_fundamental",
      "analyst_technical",
      "analyst_sentiment",
      "analyst_macro",
      "researcher_bull",
      "researcher_bear",
      "risk_manager",
      "portfolio_manager",
      "stock_screener",
      "backtest_engineer",
      "execution_trader",
      "memory_curator",
    ],
  }).notNull(),
  name: text("name").notNull(),
  version: text("version").notNull().default("1.0.0"),
  systemPrompt: text("system_prompt").notNull(),
  toolsJson: text("tools_json", { mode: "json" }).notNull().default("[]"),
  mcpServersJson: text("mcp_servers_json", { mode: "json" }).notNull().default("[]"),
  skillsJson: text("skills_json", { mode: "json" }).notNull().default("[]"),
  subscriptionsJson: text("subscriptions_json", { mode: "json" }).notNull().default("[]"),
  llmProvider: text("llm_provider").notNull(),
  maxIterations: integer("max_iterations").notNull().default(20),
  sandboxPolicyId: text("sandbox_policy_id")
    .notNull()
    .references(() => sandboxPolicy.id),
  signalWeight: real("signal_weight").notNull().default(1.0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const agentProfile = sqliteTable("agent_profile", {
  id: id(),
  definitionId: text("definition_id")
    .notNull()
    .references(() => agentDefinition.id),
  displayName: text("display_name").notNull(),
  soulFileRef: text("soul_file_ref").notNull().default(""),
  promptTemplateRef: text("prompt_template_ref"),
  description: text("description").notNull().default(""),
  tagsJson: text("tags_json", { mode: "json" }).notNull().default("[]"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const agentDefinitionDraft = sqliteTable("agent_definition_draft", {
  id: id(),
  definitionId: text("definition_id")
    .notNull()
    .references(() => agentDefinition.id),
  versionTag: text("version_tag").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  toolsJson: text("tools_json", { mode: "json" }).notNull().default("[]"),
  mcpServersJson: text("mcp_servers_json", { mode: "json" }).notNull().default("[]"),
  skillsJson: text("skills_json", { mode: "json" }).notNull().default("[]"),
  subscriptionsJson: text("subscriptions_json", { mode: "json" }).notNull().default("[]"),
  llmProvider: text("llm_provider").notNull(),
  maxIterations: integer("max_iterations").notNull().default(20),
  sandboxPolicyId: text("sandbox_policy_id")
    .notNull()
    .references(() => sandboxPolicy.id),
  changeNote: text("change_note").notNull().default(""),
  createdBy: text("created_by").notNull().default("user"),
  createdAt: createdAt(),
});

export const agentDefinitionRelease = sqliteTable("agent_definition_release", {
  id: id(),
  definitionId: text("definition_id")
    .notNull()
    .references(() => agentDefinition.id),
  draftId: text("draft_id")
    .notNull()
    .references(() => agentDefinitionDraft.id),
  releasedVersion: text("released_version").notNull(),
  releaseNote: text("release_note").notNull().default(""),
  releasedBy: text("released_by").notNull().default("user"),
  releasedAt: createdAt(),
});

export const agentInstance = sqliteTable("agent_instance", {
  id: id(),
  definitionId: text("definition_id")
    .notNull()
    .references(() => agentDefinition.id),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  status: text("status", { enum: ["idle", "running", "error", "stopped"] })
    .notNull()
    .default("idle"),
  currentIteration: integer("current_iteration").notNull().default(0),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  errorMessage: text("error_message"),
});

export const a2aMessage = sqliteTable("a2a_message", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  traceId: text("trace_id").notNull(),
  senderInstanceId: text("sender_instance_id")
    .notNull()
    .references(() => agentInstance.id),
  receiverInstanceId: text("receiver_instance_id").references(() => agentInstance.id),
  messageType: text("message_type", {
    enum: [
      "TASK_ASSIGN",
      "TASK_RESULT",
      "RISK_BLOCK",
      "ORDER_INTENT",
      "MODEL_UPDATE",
      "MEMORY_WRITE",
      "ALERT",
    ],
  }).notNull(),
  payloadJson: text("payload_json", { mode: "json" }).notNull(),
  priority: integer("priority").notNull().default(50),
  createdAt: createdAt(),
});

export const acpCall = sqliteTable("acp_call", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  traceId: text("trace_id").notNull(),
  agentStepId: text("agent_step_id"),
  callerInstanceId: text("caller_instance_id")
    .notNull()
    .references(() => agentInstance.id),
  targetKind: text("target_kind", {
    enum: ["skill", "mcp", "tool", "connector"],
  }).notNull(),
  targetName: text("target_name").notNull(),
  intent: text("intent").notNull(),
  inputSchemaVersion: text("input_schema_version").notNull().default("1.0"),
  outputSchemaVersion: text("output_schema_version"),
  latencyMs: integer("latency_ms"),
  status: text("status", {
    enum: ["success", "error", "timeout", "blocked_by_sandbox"],
  }).notNull(),
  errorCode: text("error_code"),
  createdAt: createdAt(),
});

export const agentStep = sqliteTable("agent_step", {
  id: id(),
  agentInstanceId: text("agent_instance_id")
    .notNull()
    .references(() => agentInstance.id),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  stepIndex: integer("step_index").notNull(),
  phase: text("phase", { enum: ["perceive", "reason", "act", "observe"] }).notNull(),
  thought: text("thought"),
  actionType: text("action_type", {
    enum: ["tool_call", "final_answer", "memory_read", "memory_write", "a2a_send"],
  }).notNull(),
  actionJson: text("action_json", { mode: "json" }).notNull(),
  observationJson: text("observation_json", { mode: "json" }),
  tokenCount: integer("token_count"),
  latencyMs: integer("latency_ms"),
  createdAt: createdAt(),
});

export const toolCallLog = sqliteTable("tool_call_log", {
  id: id(),
  agentStepId: text("agent_step_id")
    .notNull()
    .references(() => agentStep.id),
  toolName: text("tool_name").notNull(),
  toolKind: text("tool_kind", { enum: ["acp_connector", "mcp", "skill", "builtin"] }).notNull(),
  requestJson: text("request_json", { mode: "json" }).notNull(),
  responseJson: text("response_json", { mode: "json" }),
  status: text("status", {
    enum: ["success", "error", "timeout", "sandbox_blocked"],
  }).notNull(),
  latencyMs: integer("latency_ms"),
  errorMessage: text("error_message"),
  createdAt: createdAt(),
});

export const mcpCallLog = sqliteTable("mcp_call_log", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  agentStepId: text("agent_step_id")
    .notNull()
    .references(() => agentStep.id),
  serverName: text("server_name").notNull(),
  toolName: text("tool_name").notNull(),
  requestJson: text("request_json", { mode: "json" }).notNull(),
  responseJson: text("response_json", { mode: "json" }),
  status: text("status", { enum: ["success", "timeout", "failed", "sandbox_blocked"] }).notNull(),
  errorCode: text("error_code"),
  latencyMs: integer("latency_ms"),
  createdAt: createdAt(),
});

export const sandboxViolationLog = sqliteTable("sandbox_violation_log", {
  id: id(),
  agentInstanceId: text("agent_instance_id")
    .notNull()
    .references(() => agentInstance.id),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  violationType: text("violation_type", {
    enum: [
      "tool_not_allowed",
      "mcp_not_allowed",
      "network_blocked",
      "fs_blocked",
      "timeout",
      "iteration_exceeded",
    ],
  }).notNull(),
  attemptedAction: text("attempted_action", { mode: "json" }).notNull(),
  sandboxPolicyId: text("sandbox_policy_id")
    .notNull()
    .references(() => sandboxPolicy.id),
  createdAt: createdAt(),
});

// ─── 2.3 策略研究与回测域 ────────────────────────────────────────────────────

export const strategy = sqliteTable("strategy", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  name: text("name").notNull(),
  style: text("style", {
    enum: ["low_freq", "mid_freq", "high_freq", "options", "futures"],
  }).notNull(),
  description: text("description").notNull().default(""),
  ownerInstanceId: text("owner_instance_id").references(() => agentInstance.id),
  createdAt: createdAt(),
});

export const strategyVersion = sqliteTable("strategy_version", {
  id: id(),
  strategyId: text("strategy_id")
    .notNull()
    .references(() => strategy.id),
  versionTag: text("version_tag").notNull(),
  logicHash: text("logic_hash").notNull(),
  paramSchemaJson: text("param_schema_json", { mode: "json" }).notNull(),
  createdAt: createdAt(),
});

export const factorDefinition = sqliteTable("factor_definition", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  name: text("name").notNull(),
  category: text("category", {
    enum: ["value", "momentum", "volatility", "news", "quality", "macro"],
  }).notNull(),
  definitionJson: text("definition_json", { mode: "json" }).notNull(),
  createdAt: createdAt(),
});

export const researchExperiment = sqliteTable("research_experiment", {
  id: id(),
  strategyVersionId: text("strategy_version_id")
    .notNull()
    .references(() => strategyVersion.id),
  agentInstanceId: text("agent_instance_id").references(() => agentInstance.id),
  datasetSnapshotId: text("dataset_snapshot_id").notNull(),
  metricJson: text("metric_json", { mode: "json" }).notNull(),
  resultSummary: text("result_summary").notNull().default(""),
  createdAt: createdAt(),
});

export const backtestRun = sqliteTable("backtest_run", {
  id: id(),
  strategyVersionId: text("strategy_version_id")
    .notNull()
    .references(() => strategyVersion.id),
  agentInstanceId: text("agent_instance_id").references(() => agentInstance.id),
  connectorInstanceId: text("connector_instance_id").notNull(),
  datasetSnapshotId: text("dataset_snapshot_id").notNull(),
  configJson: text("config_json", { mode: "json" }).notNull(),
  performanceJson: text("performance_json", { mode: "json" }),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed"],
  })
    .notNull()
    .default("pending"),
  startedAt: createdAt(),
  endedAt: text("ended_at"),
});

export const simulationRun = sqliteTable("simulation_run", {
  id: id(),
  strategyVersionId: text("strategy_version_id")
    .notNull()
    .references(() => strategyVersion.id),
  agentInstanceId: text("agent_instance_id").references(() => agentInstance.id),
  connectorInstanceId: text("connector_instance_id").notNull(),
  paperAccountId: text("paper_account_id").notNull(),
  performanceJson: text("performance_json", { mode: "json" }),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed"],
  })
    .notNull()
    .default("pending"),
  startedAt: createdAt(),
  endedAt: text("ended_at"),
});

// ─── V2 策略基因池域（SGP） ───────────────────────────────────────────────────

export const geneGeneration = sqliteTable("gene_generation", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  generationNumber: integer("generation_number").notNull(),
  populationSize: integer("population_size").notNull(),
  mutationRate: real("mutation_rate").notNull().default(0.1),
  bestSharpe: real("best_sharpe"),
  createdAt: createdAt(),
});

export const strategyGene = sqliteTable("strategy_gene", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  geneType: text("gene_type").notNull(),
  key: text("key").notNull(),
  valueJson: text("value_json", { mode: "json" }).notNull(),
  description: text("description").notNull().default(""),
});

export const strategyGenome = sqliteTable("strategy_genome", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  generationId: text("generation_id")
    .notNull()
    .references(() => geneGeneration.id),
  name: text("name").notNull(),
  genesSnapshotJson: text("genes_snapshot_json", { mode: "json" }).notNull().default("{}"),
  sharpeRatio: real("sharpe_ratio"),
  maxDrawdown: real("max_drawdown"),
  totalReturn: real("total_return"),
  backtestRunId: text("backtest_run_id").references(() => backtestRun.id),
  parentAId: text("parent_a_id"),
  parentBId: text("parent_b_id"),
  mutationLog: text("mutation_log"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

// ─── 2.4 市场数据与快照域 ────────────────────────────────────────────────────

export const instrument = sqliteTable("instrument", {
  id: id(),
  symbol: text("symbol").notNull(),
  assetClass: text("asset_class", {
    enum: ["stock", "future", "option", "crypto", "fx"],
  }).notNull(),
  exchange: text("exchange").notNull(),
  metaJson: text("meta_json", { mode: "json" }).notNull().default("{}"),
});

export const marketDataSource = sqliteTable("market_data_source", {
  id: id(),
  name: text("name").notNull(),
  sourceType: text("source_type", {
    enum: ["market", "news", "fundamental", "event"],
  }).notNull(),
  vendor: text("vendor").notNull(),
  status: text("status", { enum: ["active", "inactive", "error"] })
    .notNull()
    .default("active"),
});

export const datasetSnapshot = sqliteTable("dataset_snapshot", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  sourceId: text("source_id")
    .notNull()
    .references(() => marketDataSource.id),
  asofTime: text("asof_time").notNull(),
  rangeStart: text("range_start").notNull(),
  rangeEnd: text("range_end").notNull(),
  schemaVersion: text("schema_version").notNull().default("1.0"),
  locationUri: text("location_uri").notNull(),
  qualityScore: real("quality_score"),
});

export const newsEvent = sqliteTable("news_event", {
  id: id(),
  sourceId: text("source_id")
    .notNull()
    .references(() => marketDataSource.id),
  instrumentId: text("instrument_id").references(() => instrument.id),
  publishedAt: text("published_at").notNull(),
  eventType: text("event_type").notNull(),
  sentimentScore: real("sentiment_score"),
  contentRef: text("content_ref").notNull(),
});

// ─── V2 选股域（Stock Screener） ───────────────────────────────────────────────

export const screenerRun = sqliteTable("screener_run", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  criteriaJson: text("criteria_json", { mode: "json" }).notNull().default("{}"),
  universe: text("universe").notNull().default("CN-A"),
  candidateCount: integer("candidate_count").notNull().default(0),
  createdAt: createdAt(),
});

export const screenerCandidate = sqliteTable("screener_candidate", {
  id: id(),
  screenerRunId: text("screener_run_id")
    .notNull()
    .references(() => screenerRun.id),
  ticker: text("ticker").notNull(),
  companyName: text("company_name").notNull(),
  score: real("score").notNull(),
  scoreBreakdownJson: text("score_breakdown_json", { mode: "json" }).notNull().default("{}"),
  passedToAnalyst: integer("passed_to_analyst", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

// ─── 2.5 交易执行与风控域 ────────────────────────────────────────────────────

export const tradingAccount = sqliteTable("trading_account", {
  id: id(),
  broker: text("broker").notNull(),
  marketScope: text("market_scope").notNull(),
  mode: text("mode", { enum: ["paper", "live"] }).notNull(),
  status: text("status", { enum: ["active", "inactive", "suspended"] })
    .notNull()
    .default("active"),
});

export const orderIntent = sqliteTable("order_intent", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  strategyVersionId: text("strategy_version_id")
    .notNull()
    .references(() => strategyVersion.id),
  instrumentId: text("instrument_id")
    .notNull()
    .references(() => instrument.id),
  side: text("side", { enum: ["buy", "sell"] }).notNull(),
  qty: real("qty").notNull(),
  orderType: text("order_type", {
    enum: ["market", "limit", "stop", "stop_limit"],
  }).notNull(),
  price: real("price"),
  timeInForce: text("time_in_force", {
    enum: ["day", "gtc", "ioc", "fok"],
  }).notNull(),
  intentTime: createdAt(),
});

export const riskRule = sqliteTable("risk_rule", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  name: text("name").notNull(),
  scope: text("scope", {
    enum: ["pre_trade", "intra_trade", "post_trade"],
  }).notNull(),
  ruleExpr: text("rule_expr").notNull(),
  severity: text("severity", { enum: ["block", "warn", "info"] }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
});

export const riskDecision = sqliteTable("risk_decision", {
  id: id(),
  orderIntentId: text("order_intent_id")
    .notNull()
    .references(() => orderIntent.id),
  riskRuleId: text("risk_rule_id")
    .notNull()
    .references(() => riskRule.id),
  agentInstanceId: text("agent_instance_id").references(() => agentInstance.id),
  decision: text("decision", { enum: ["allow", "block", "review"] }).notNull(),
  reason: text("reason").notNull(),
  evaluatedAt: createdAt(),
  signature: text("signature").notNull(),
});

export const brokerOrder = sqliteTable("broker_order", {
  id: id(),
  orderIntentId: text("order_intent_id")
    .notNull()
    .references(() => orderIntent.id),
  accountId: text("account_id")
    .notNull()
    .references(() => tradingAccount.id),
  connectorInstanceId: text("connector_instance_id").notNull(),
  brokerOrderId: text("broker_order_id").notNull(),
  status: text("status", {
    enum: [
      "submitted",
      "partially_filled",
      "filled",
      "cancelled",
      "rejected",
      "expired",
    ],
  }).notNull(),
  submittedAt: createdAt(),
  updatedAt: updatedAt(),
});

export const fill = sqliteTable("fill", {
  id: id(),
  brokerOrderId: text("broker_order_id")
    .notNull()
    .references(() => brokerOrder.id),
  fillQty: real("fill_qty").notNull(),
  fillPrice: real("fill_price").notNull(),
  fee: real("fee").notNull().default(0),
  filledAt: createdAt(),
});

/** Built-in paper trading account seeded in migration `0019_execution_task_and_risk_logs`. */
export const BUILTIN_PAPER_TRADING_ACCOUNT_ID = "ta_builtin_paper" as const;
/** Built-in mock execution connector instance for paper fills. */
export const BUILTIN_PAPER_CONNECTOR_INSTANCE_ID = "ci_builtin_paper_execution" as const;

export const executionTask = sqliteTable(
  "execution_task",
  {
    id: id(),
    orderIntentId: text("order_intent_id")
      .notNull()
      .references(() => orderIntent.id),
    accountId: text("account_id")
      .notNull()
      .references(() => tradingAccount.id),
    status: text("status", {
      enum: [
        "pending",
        "awaiting_review",
        "dispatching",
        "waiting_ack",
        "partially_filled",
        "filled",
        "cancelled",
        "rejected",
        "failed",
      ],
    }).notNull(),
    retryCount: integer("retry_count").notNull().default(0),
    maxRetries: integer("max_retries").notNull().default(3),
    nextRetryAt: text("next_retry_at"),
    lastError: text("last_error"),
    traceId: text("trace_id").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    orderIntentUnique: uniqueIndex("idx_execution_task_order_intent_unique").on(table.orderIntentId),
  })
);

export const executionTaskEvent = sqliteTable("execution_task_event", {
  id: id(),
  executionTaskId: text("execution_task_id")
    .notNull()
    .references(() => executionTask.id, { onDelete: "cascade" }),
  eventType: text("event_type", {
    enum: ["dispatch", "ack", "partial_fill", "fill", "cancel", "reject", "timeout", "retry"],
  }).notNull(),
  eventPayloadJson: text("event_payload_json", { mode: "json" }).notNull().default("{}"),
  eventAt: text("event_at").notNull(),
  createdAt: createdAt(),
});

export const riskHitLog = sqliteTable("risk_hit_log", {
  id: id(),
  orderIntentId: text("order_intent_id")
    .notNull()
    .references(() => orderIntent.id),
  riskRuleId: text("risk_rule_id")
    .notNull()
    .references(() => riskRule.id),
  hit: integer("hit", { mode: "boolean" }).notNull(),
  hitValue: real("hit_value"),
  thresholdValue: real("threshold_value"),
  severity: text("severity", {
    enum: ["info", "warn", "block", "critical"],
  }).notNull(),
  message: text("message").notNull().default(""),
  evaluatedAt: text("evaluated_at").notNull(),
});

export const riskReviewTicket = sqliteTable("risk_review_ticket", {
  id: id(),
  orderIntentId: text("order_intent_id")
    .notNull()
    .references(() => orderIntent.id),
  status: text("status", {
    enum: ["open", "approved", "rejected", "expired"],
  }).notNull(),
  reviewer: text("reviewer"),
  reviewNote: text("review_note"),
  expiresAt: text("expires_at").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── V2 执行意图对齐域（REIA） ────────────────────────────────────────────────

export const intentOrder = sqliteTable("intent_order", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  createdByInstanceId: text("created_by_instance_id").references(() => agentInstance.id),
  ticker: text("ticker").notNull(),
  direction: text("direction", { enum: ["long", "short", "close"] }).notNull(),
  quantity: real("quantity").notNull(),
  targetPrice: real("target_price").notNull(),
  rationale: text("rationale").notNull().default(""),
  expectedReturn: real("expected_return"),
  expectedRisk: real("expected_risk"),
  status: text("status", {
    enum: ["pending", "approved", "rejected", "executed", "deviated"],
  })
    .notNull()
    .default("pending"),
  riskApprovedAt: text("risk_approved_at"),
  createdAt: createdAt(),
});

export const executionReport = sqliteTable("execution_report", {
  id: id(),
  intentOrderId: text("intent_order_id")
    .notNull()
    .references(() => intentOrder.id),
  executorInstanceId: text("executor_instance_id").references(() => agentInstance.id),
  actualPrice: real("actual_price").notNull(),
  actualQuantity: real("actual_quantity").notNull(),
  slippage: real("slippage").notNull(),
  executionTimeMs: integer("execution_time_ms").notNull(),
  brokerOrderId: text("broker_order_id"),
  status: text("status", { enum: ["filled", "partial", "rejected", "cancelled"] })
    .notNull()
    .default("filled"),
  createdAt: createdAt(),
});

export const brokerAccount = sqliteTable("broker_account", {
  id: id(),
  provider: text("provider", { enum: ["futu", "ib"] }).notNull(),
  accountRef: text("account_ref").notNull(),
  mode: text("mode", { enum: ["mock", "sandbox", "live"] }).notNull().default("mock"),
  baseUrl: text("base_url"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  healthStatus: text("health_status", { enum: ["unknown", "healthy", "degraded", "down"] })
    .notNull()
    .default("unknown"),
  healthMessage: text("health_message"),
  lastHealthAt: text("last_health_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const brokerOrderEvent = sqliteTable("broker_order_event", {
  id: id(),
  intentOrderId: text("intent_order_id").references(() => intentOrder.id),
  executionReportId: text("execution_report_id").references(() => executionReport.id),
  provider: text("provider", { enum: ["futu", "ib"] }).notNull(),
  eventType: text("event_type", {
    enum: ["submit", "ack", "partial_fill", "fill", "cancel", "reject", "health_check"],
  }).notNull(),
  brokerOrderId: text("broker_order_id"),
  status: text("status").notNull().default("ok"),
  detailJson: text("detail_json", { mode: "json" }).notNull().default("{}"),
  eventAt: text("event_at").notNull(),
  createdAt: createdAt(),
});

export const intentDeviation = sqliteTable("intent_deviation", {
  id: id(),
  intentOrderId: text("intent_order_id")
    .notNull()
    .references(() => intentOrder.id),
  executionReportId: text("execution_report_id")
    .notNull()
    .references(() => executionReport.id),
  priceDeviationPct: real("price_deviation_pct").notNull(),
  quantityDeviationPct: real("quantity_deviation_pct").notNull(),
  exceededThreshold: integer("exceeded_threshold", { mode: "boolean" }).notNull().default(false),
  callbackTriggered: integer("callback_triggered", { mode: "boolean" }).notNull().default(false),
  callbackWorkflowId: text("callback_workflow_id"),
  createdAt: createdAt(),
});

export const executionConfirmTicket = sqliteTable("execution_confirm_ticket", {
  id: id(),
  intentOrderId: text("intent_order_id")
    .notNull()
    .references(() => intentOrder.id),
  confirmTokenHash: text("confirm_token_hash").notNull(),
  issuedBy: text("issued_by").notNull().default("system"),
  issuedAt: text("issued_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  status: text("status", { enum: ["active", "expired", "consumed", "revoked"] })
    .notNull()
    .default("active"),
  riskScoreSnapshot: real("risk_score_snapshot").notNull(),
  blockersJson: text("blockers_json", { mode: "json" }).notNull().default("[]"),
  createdAt: createdAt(),
});

// ─── 2.6 插件接入域 ──────────────────────────────────────────────────────────

export const connectorSpec = sqliteTable("connector_spec", {
  id: id(),
  name: text("name").notNull(),
  connectorType: text("connector_type", {
    enum: ["data", "research", "backtest", "execution", "risk", "memory"],
  }).notNull(),
  version: text("version").notNull(),
  capabilitiesJson: text("capabilities_json", { mode: "json" }).notNull(),
  assetClassesJson: text("asset_classes_json", { mode: "json" }).notNull(),
  latencyProfile: text("latency_profile", {
    enum: ["realtime", "neartime", "batch"],
  }).notNull(),
  schemaContractJson: text("schema_contract_json", { mode: "json" }).notNull(),
});

export const connectorInstance = sqliteTable("connector_instance", {
  id: id(),
  specId: text("spec_id")
    .notNull()
    .references(() => connectorSpec.id),
  env: text("env", { enum: ["dev", "staging", "prod"] })
    .notNull()
    .default("dev"),
  configRef: text("config_ref").notNull(),
  status: text("status", { enum: ["active", "inactive", "error"] })
    .notNull()
    .default("inactive"),
  lastHealthcheckAt: text("last_healthcheck_at"),
});

export const connectorCallLog = sqliteTable("connector_call_log", {
  id: id(),
  connectorInstanceId: text("connector_instance_id")
    .notNull()
    .references(() => connectorInstance.id),
  acpCallId: text("acp_call_id").references(() => acpCall.id),
  traceId: text("trace_id").notNull(),
  operation: text("operation", {
    enum: ["init", "healthcheck", "execute", "shutdown"],
  }).notNull(),
  requestJson: text("request_json", { mode: "json" }).notNull(),
  responseJson: text("response_json", { mode: "json" }),
  latencyMs: integer("latency_ms").notNull(),
  status: text("status", { enum: ["success", "error", "timeout"] }).notNull(),
  createdAt: createdAt(),
});

// ─── 2.7 记忆域 ──────────────────────────────────────────────────────────────

export const sessionMemory = sqliteTable(
  "session_memory",
  {
    id: id(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRun.id),
    summary: text("summary").notNull().default(""),
    stateJson: text("state_json", { mode: "json" }).notNull(),
    asofTime: text("asof_time").notNull(),
    ttlAt: text("ttl_at").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("session_memory_workflow_idx").on(t.workflowRunId)]
);

export const midtermMemory = sqliteTable("midterm_memory", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  memoryType: text("memory_type", {
    enum: ["strategy_iteration", "risk_review", "simulation_note", "param_scan"],
  }).notNull(),
  contentJson: text("content_json", { mode: "json" }).notNull(),
  timeWindowStart: text("time_window_start").notNull(),
  timeWindowEnd: text("time_window_end").notNull(),
  asofTime: text("asof_time").notNull(),
  score: real("score"),
  updatedAt: updatedAt(),
});

export const longtermMemory = sqliteTable("longterm_memory", {
  id: id(),
  scope: text("scope", { enum: ["org", "project", "strategy"] }).notNull(),
  scopeId: text("scope_id").notNull(),
  memoryType: text("memory_type", {
    enum: [
      "factor_archive",
      "regime",
      "playbook",
      "postmortem",
      "execution_profile",
    ],
  }).notNull(),
  contentJson: text("content_json", { mode: "json" }).notNull(),
  embeddingRef: text("embedding_ref"),
  artifactUri: text("artifact_uri"),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  asofTime: text("asof_time").notNull(),
  confidenceScore: real("confidence_score"),
  updatedAt: updatedAt(),
});

export const memoryLink = sqliteTable("memory_link", {
  id: id(),
  fromType: text("from_type", {
    enum: ["session", "midterm", "longterm"],
  }).notNull(),
  fromId: text("from_id").notNull(),
  toType: text("to_type", {
    enum: ["session", "midterm", "longterm"],
  }).notNull(),
  toId: text("to_id").notNull(),
  relation: text("relation", {
    enum: ["derive_from", "summarize_to", "evidence_of", "conflicts_with"],
  }).notNull(),
  weight: real("weight").notNull().default(1.0),
  createdAt: createdAt(),
});

export const memoryBackendConfig = sqliteTable("memory_backend_config", {
  id: id(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id),
  connectorType: text("connector_type", {
    enum: ["mem0", "graphrag", "custom"],
  }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  writeMode: text("write_mode", {
    enum: ["dual_write", "external_only", "native_only"],
  })
    .notNull()
    .default("native_only"),
  connectorInstanceId: text("connector_instance_id").references(
    () => connectorInstance.id
  ),
  configRef: text("config_ref").notNull().default(""),
  fallbackToNative: integer("fallback_to_native", { mode: "boolean" })
    .notNull()
    .default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memorySyncLog = sqliteTable("memory_sync_log", {
  id: id(),
  memoryBackendConfigId: text("memory_backend_config_id")
    .notNull()
    .references(() => memoryBackendConfig.id),
  sourceType: text("source_type", {
    enum: ["session", "midterm", "longterm"],
  }).notNull(),
  sourceId: text("source_id").notNull(),
  operation: text("operation", {
    enum: ["add", "update", "delete", "search"],
  }).notNull(),
  status: text("status", {
    enum: ["success", "failed", "degraded"],
  }).notNull(),
  latencyMs: integer("latency_ms"),
  errorDetail: text("error_detail"),
  createdAt: createdAt(),
});

/** Single-row JSON: init payloads for `qubit-data` / `qubit-news` (configured in the desktop/web UI). */
export const builtinConnectorSettings = sqliteTable("builtin_connector_settings", {
  id: text("id").primaryKey(),
  configJson: text("config_json", { mode: "json" }).notNull(),
  updatedAt: updatedAt(),
});

export const communicationChannel = sqliteTable("communication_channel", {
  id: id(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id),
  projectId: text("project_id").references(() => project.id),
  kind: text("kind", { enum: ["telegram", "webhook"] }).notNull(),
  name: text("name").notNull(),
  externalChatId: text("external_chat_id").notNull(),
  secretRef: text("secret_ref").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const communicationMessageLog = sqliteTable("communication_message_log", {
  id: id(),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  channelKind: text("channel_kind", { enum: ["telegram", "webhook"] }).notNull(),
  externalChatId: text("external_chat_id").notNull(),
  externalMessageId: text("external_message_id"),
  payloadJson: text("payload_json", { mode: "json" }).notNull(),
  status: text("status", { enum: ["success", "failed"] }).notNull(),
  errorMessage: text("error_message"),
  createdAt: createdAt(),
});

// ─── 2.8 审计与可观测域 ──────────────────────────────────────────────────────

// ─── V2 角色字典 ──────────────────────────────────────────────────────────────

export const agentRoleCatalog = sqliteTable("agent_role_catalog", {
  role: text("role").primaryKey(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull().default(""),
  defaultPromptTemplate: text("default_prompt_template").notNull().default(""),
  team: text("team").notNull().default("ops"),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(true),
});

// ─── V2 多信号融合域（MSA） ───────────────────────────────────────────────────

export const analystSignal = sqliteTable("analyst_signal", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  agentInstanceId: text("agent_instance_id").references(() => agentInstance.id),
  analystRole: text("analyst_role").notNull(),
  ticker: text("ticker").notNull(),
  signal: text("signal", { enum: ["buy", "sell", "hold"] }).notNull(),
  confidence: real("confidence").notNull().default(0.5),
  reasoning: text("reasoning").notNull().default(""),
  dataSnapshotJson: text("data_snapshot_json", { mode: "json" }).notNull().default("{}"),
  createdAt: createdAt(),
});

export const signalFusionResult = sqliteTable("signal_fusion_result", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  ticker: text("ticker").notNull(),
  fusedSignal: text("fused_signal", { enum: ["buy", "sell", "hold"] }).notNull(),
  fusedConfidence: real("fused_confidence").notNull().default(0.5),
  weightsJson: text("weights_json", { mode: "json" }).notNull().default("{}"),
  debateTriggered: integer("debate_triggered", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

export const analystAccuracyLog = sqliteTable("analyst_accuracy_log", {
  id: id(),
  definitionId: text("definition_id")
    .notNull()
    .references(() => agentDefinition.id),
  ticker: text("ticker").notNull(),
  signalDate: integer("signal_date").notNull(),
  predictedSignal: text("predicted_signal", { enum: ["buy", "sell", "hold"] }).notNull(),
  actualOutcome: text("actual_outcome", { enum: ["up", "down", "flat"] }),
  isCorrect: integer("is_correct"),
  evaluatedAt: integer("evaluated_at"),
});

// ─── V2 结构化辩论域（SDP） ───────────────────────────────────────────────────

export const debateSession = sqliteTable("debate_session", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  topic: text("topic").notNull(),
  triggerReason: text("trigger_reason").notNull().default("low_confidence"),
  maxRounds: integer("max_rounds").notNull().default(3),
  status: text("status", { enum: ["pending", "in_progress", "completed", "skipped"] })
    .notNull()
    .default("pending"),
  consensusScore: real("consensus_score"),
  verdict: text("verdict", { enum: ["agree_bull", "agree_bear", "no_consensus"] }),
  createdAt: createdAt(),
  endedAt: text("ended_at"),
});

export const debateTurn = sqliteTable("debate_turn", {
  id: id(),
  debateSessionId: text("debate_session_id")
    .notNull()
    .references(() => debateSession.id),
  roundNumber: integer("round_number").notNull(),
  speakerRole: text("speaker_role").notNull(),
  stance: text("stance", { enum: ["bull", "bear", "neutral"] }).notNull(),
  statement: text("statement").notNull(),
  evidenceJson: text("evidence_json", { mode: "json" }).notNull().default("[]"),
  confidence: real("confidence").notNull().default(0.5),
  createdAt: createdAt(),
});

export const debateVerdict = sqliteTable("debate_verdict", {
  id: id(),
  debateSessionId: text("debate_session_id")
    .notNull()
    .references(() => debateSession.id),
  orchestratorRole: text("orchestrator_role").notNull().default("orchestrator"),
  reasoning: text("reasoning").notNull(),
  consensusScore: real("consensus_score").notNull(),
  finalStance: text("final_stance", { enum: ["bull", "bear", "hold", "abort"] }).notNull(),
  vetoByRisk: integer("veto_by_risk", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

// ─── V2 风险前置一票否决域（RFV） ────────────────────────────────────────────

export const riskVetoLog = sqliteTable("risk_veto_log", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  riskInstanceId: text("risk_instance_id").references(() => agentInstance.id),
  vetoTarget: text("veto_target").notNull(),
  vetoReason: text("veto_reason").notNull(),
  riskScore: real("risk_score").notNull(),
  riskRulesTriggeredJson: text("risk_rules_triggered_json", { mode: "json" }).notNull().default("[]"),
  severity: text("severity", { enum: ["warning", "block", "critical"] }).notNull().default("block"),
  createdAt: createdAt(),
});

// ─── 2.8 审计与可观测域 ──────────────────────────────────────────────────────

export const agentRuntimeMetric = sqliteTable("agent_runtime_metric", {
  id: id(),
  definitionId: text("definition_id")
    .notNull()
    .references(() => agentDefinition.id),
  windowStart: text("window_start").notNull(),
  windowEnd: text("window_end").notNull(),
  runCount: integer("run_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  timeoutCount: integer("timeout_count").notNull().default(0),
  p50LatencyMs: real("p50_latency_ms"),
  p95LatencyMs: real("p95_latency_ms"),
  avgTokenCount: real("avg_token_count"),
  createdAt: createdAt(),
});

export const workflowQualitySnapshot = sqliteTable("workflow_quality_snapshot", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  totalDurationMs: integer("total_duration_ms"),
  totalToolCalls: integer("total_tool_calls").notNull().default(0),
  sandboxBlockCount: integer("sandbox_block_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  qualityScore: real("quality_score").notNull().default(0),
  createdAt: createdAt(),
});

export const alertEvent = sqliteTable("alert_event", {
  id: id(),
  scopeType: text("scope_type", { enum: ["workflow", "agent", "system"] }).notNull(),
  scopeId: text("scope_id").notNull(),
  alertType: text("alert_type").notNull(),
  severity: text("severity", { enum: ["info", "warn", "error", "critical"] }).notNull(),
  title: text("title").notNull(),
  detailsJson: text("details_json", { mode: "json" }).notNull().default("{}"),
  status: text("status", { enum: ["open", "ack", "resolved"] }).notNull().default("open"),
  createdAt: createdAt(),
  resolvedAt: text("resolved_at"),
});

export const evalDataset = sqliteTable("eval_dataset", {
  id: id(),
  name: text("name").notNull(),
  version: text("version").notNull().default("v1"),
  scenario: text("scenario").notNull().default("mixed"),
  sourceDesc: text("source_desc").notNull().default(""),
  metaJson: text("meta_json", { mode: "json" }).notNull().default("{}"),
  createdAt: createdAt(),
});

export const evalRun = sqliteTable("eval_run", {
  id: id(),
  datasetId: text("dataset_id")
    .notNull()
    .references(() => evalDataset.id),
  configSnapshotJson: text("config_snapshot_json", { mode: "json" }).notNull().default("{}"),
  modelSnapshotJson: text("model_snapshot_json", { mode: "json" }).notNull().default("{}"),
  status: text("status", { enum: ["pending", "running", "completed", "failed"] })
    .notNull()
    .default("pending"),
  summaryMetricsJson: text("summary_metrics_json", { mode: "json" }).notNull().default("{}"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  createdAt: createdAt(),
});

export const evalCaseResult = sqliteTable("eval_case_result", {
  id: id(),
  evalRunId: text("eval_run_id")
    .notNull()
    .references(() => evalRun.id),
  caseKey: text("case_key").notNull(),
  workflowRunId: text("workflow_run_id").references(() => workflowRun.id),
  expectedJson: text("expected_json", { mode: "json" }).notNull().default("{}"),
  actualJson: text("actual_json", { mode: "json" }).notNull().default("{}"),
  score: real("score").notNull().default(0),
  pass: integer("pass", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

export const auditLog = sqliteTable("audit_log", {
  id: id(),
  traceId: text("trace_id").notNull(),
  workflowRunId: text("workflow_run_id").references(() => workflowRun.id),
  agentInstanceId: text("agent_instance_id").references(() => agentInstance.id),
  actorType: text("actor_type", {
    enum: ["agent", "user", "system"],
  }).notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  detailJson: text("detail_json", { mode: "json" }).notNull(),
  createdAt: createdAt(),
});
