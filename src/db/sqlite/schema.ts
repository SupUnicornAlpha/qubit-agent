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

export const workflowRun = sqliteTable("workflow_run", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  sessionId: text("session_id"),
  goal: text("goal").notNull(),
  mode: text("mode", { enum: ["research", "backtest", "simulation", "live"] }).notNull(),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("pending"),
  startedAt: createdAt(),
  endedAt: text("ended_at"),
});

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
  transport: text("transport", { enum: ["stdio", "http", "ws"] }).notNull(),
  command: text("command"),
  url: text("url"),
  capabilitiesJson: text("capabilities_json", { mode: "json" }).notNull().default("[]"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
});

export const agentDefinition = sqliteTable("agent_definition", {
  id: id(),
  role: text("role", {
    enum: [
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
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
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

// ─── 2.8 审计与可观测域 ──────────────────────────────────────────────────────

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
