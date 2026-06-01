import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    enum: ["pending", "running", "completed", "failed", "cancelled", "awaiting_approval"],
  })
    .notNull()
    .default("pending"),
  /** 研究团队分析选用的 Agent 组（见迁移 0023_agent_group；Drizzle 侧不声明 FK 避免表定义顺序循环） */
  agentGroupId: text("agent_group_id"),
  /** Agent 执行循环：native=LangGraph；claude_cli / codex_cli=外部 CLI（见 src/runtime/loop） */
  loopKind: text("loop_kind", { enum: ["native", "claude_cli", "codex_cli"] })
    .notNull()
    .default("native"),
  /** native 循环下的执行路径：graph=LangGraph；a2a=内存总线 + AgentRuntime */
  executionPath: text("execution_path", { enum: ["graph", "a2a"] })
    .notNull()
    .default("graph"),
  loopOptionsJson: text("loop_options_json", { mode: "json" }).notNull().default("{}"),
  startedAt: createdAt(),
  endedAt: text("ended_at"),
  /** LangGraph checkpointer 的 thread_id（一般等于 workflow_run.id；显式存储便于跨表查询） */
  langgraphThreadId: text("langgraph_thread_id"),
  /** 最近一次写入的 LangGraph checkpoint id；用于 sweep 时判断断点存在性 */
  lastCheckpointId: text("last_checkpoint_id"),
  lastCheckpointAt: text("last_checkpoint_at"),
  /** 累计被续跑/重试次数（Phase 1 用于幂等限流） */
  resumeCount: integer("resume_count").notNull().default(0),
  /** Phase 2.5：CLI loop（claude_cli/codex_cli）的 session id，用于 `--resume`。 */
  cliSessionId: text("cli_session_id"),
  /** Phase 2.5：CLI loop 首次启动用的可执行（便于 restore 时拼出一致的命令）。 */
  cliLoopCommand: text("cli_loop_command"),
  /** Phase 2.5：CLI session 累计 resume 次数。 */
  cliSessionResumedCount: integer("cli_session_resumed_count").notNull().default(0),
  /** 研究场景标签（见迁移 0040_research_scenario；Drizzle 侧不声明 FK 避免循环） */
  researchScenarioId: text("research_scenario_id"),
});

/** Saved from IDE: indicator draft + optional Python signal (buy/sell) for backtest / live reuse. */
export const indicatorStrategyScript = sqliteTable("indicator_strategy_script", {
  id: id(),
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSession.id, { onDelete: "cascade" }),
  workflowRunId: text("workflow_run_id").references(() => workflowRun.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  ideCode: text("ide_code").notNull().default(""),
  signalCode: text("signal_code").notNull().default(""),
  aiPromptSnapshot: text("ai_prompt_snapshot"),
  chartSnapshotJson: text("chart_snapshot_json").notNull().default("{}"),
  purpose: text("purpose", { enum: ["research", "live_trading", "both"] })
    .notNull()
    .default("both"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workflowHitlRequest = sqliteTable("workflow_hitl_request", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id, { onDelete: "cascade" }),
  runId: text("run_id"),
  agentInstanceId: text("agent_instance_id"),
  stepIndex: integer("step_index").notNull().default(0),
  scope: text("scope", { enum: ["chat_orchestrator", "team_orchestrator"] })
    .notNull()
    .default("chat_orchestrator"),
  requestKind: text("request_kind", { enum: ["tool_call", "team_research_plan"] })
    .notNull()
    .default("tool_call"),
  status: text("status", { enum: ["pending", "approved", "rejected"] })
    .notNull()
    .default("pending"),
  title: text("title").notNull().default(""),
  summary: text("summary").notNull().default(""),
  payloadJson: text("payload_json", { mode: "json" }).notNull().default({}),
  /**
   * HITL v2：交互类型分发器，前端按此渲染对应组件。
   *   - approve_only：批准 / 拒绝（v1 兼容默认值）
   *   - single_choice：单选（inputSchemaJson.options 给选项数组）
   *   - multi_choice：多选（同上 + minSelect/maxSelect）
   *   - free_form：自由文本（inputSchemaJson.placeholder/maxLength）
   * 详见 docs/HITL_REDESIGN.md
   */
  inputKind: text("input_kind", {
    enum: ["approve_only", "single_choice", "multi_choice", "free_form"],
  })
    .notNull()
    .default("approve_only"),
  /** 渲染所需 schema（options 列表、placeholder、maxLength 等）。approve_only 为 {}. */
  inputSchemaJson: text("input_schema_json", { mode: "json" }).notNull().default({}),
  /**
   * 用户实际选择 / 输入的内容；approve_only 时保持 NULL。
   * single_choice → { value: string }；multi_choice → { values: string[] }；
   * free_form → { text: string }
   */
  responseJson: text("response_json", { mode: "json" }),
  createdAt: createdAt(),
  resolvedAt: text("resolved_at"),
  resolvedBy: text("resolved_by"),
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

/**
 * P0-2：研究团队异步任务的持久化真相源。
 *
 * 旧设计：`src/runtime/msa/analyst-research-jobs.ts` 全靠进程内存 Map，重启就丢；
 * `restoreRunningWorkflows` 也不扫 awaiting_approval，所以「审批中遇到 backend 重启
 * → resolveHitlRequest 找不到 resumePayload → workflow 被标 failed」是必然路径。
 *
 * 现在把 register / pause / resume / complete / fail 全落到这张表，Map 仅作热路径
 * cache。重启后 restoreRunningWorkflows 从这里回填 cache，HITL 审批链路就能跨重启续跑。
 */
export const analystResearchJob = sqliteTable(
  "analyst_research_job",
  {
    /** 与轮询 GET /analyst/job/:jobId 的 jobId 同源；由 analyst.routes 生成 */
    id: id(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRun.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["running", "completed", "failed", "awaiting_approval"],
    })
      .notNull()
      .default("running"),
    ticker: text("ticker").notNull().default(""),
    /** ParsedResearchTeamExecute JSON；pause/resume 用以让 HITL 批准后重派 */
    resumePayloadJson: text("resume_payload_json", { mode: "json" }),
    /** AnalystTeamResult JSON；completed 时填，前端轮询 GET /job/:jobId 读 */
    resultJson: text("result_json", { mode: "json" }),
    errorMessage: text("error_message"),
    /** awaiting_approval 时挂上的 HITL 请求 ID（与 workflow_hitl_request.id 对应） */
    hitlRequestId: text("hitl_request_id"),
    hitlTitle: text("hitl_title"),
    hitlSummary: text("hitl_summary"),
    /** 不用 createdAt() helper：那个 helper 把 SQL 列名硬编码成 `created_at`，
     *  这里列名必须叫 `started_at` 与 migration 0046 对齐。 */
    startedAt: text("started_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
    updatedAt: updatedAt(),
  },
  (table) => ({
    byWorkflowStatus: index("idx_analyst_research_job_workflow").on(
      table.workflowRunId,
      table.status
    ),
  })
);

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
  status: text("status", {
    enum: ["queued", "running", "completed", "failed", "awaiting_approval"],
  })
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
  definitionId: text("definition_id").references(() => agentDefinition.id, { onDelete: "set null" }),
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

export const skillMarketInstall = sqliteTable(
  "skill_market_install",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    registry: text("registry").notNull().default("open-skill-market"),
    externalSkillId: text("external_skill_id").notNull(),
    skillName: text("skill_name").notNull(),
    description: text("description").notNull().default(""),
    metaJson: text("meta_json", { mode: "json" }).notNull().default("{}"),
    installStatus: text("install_status", { enum: ["installed", "removed"] })
      .notNull()
      .default("installed"),
    installedBy: text("installed_by").notNull().default("user"),
    createdAt: createdAt(),
  },
  (table) => ({
    projectExtUnique: uniqueIndex("idx_skill_market_install_project_ext").on(
      table.projectId,
      table.externalSkillId
    ),
  })
);

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

/** 可复用的多 Agent 编排：成员指向 analyst_* 等 definition，relations 描述协作/汇报关系（展示与后续编排用） */
export const agentGroup = sqliteTable("agent_group", {
  id: id(),
  workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  relationsJson: text("relations_json", { mode: "json" }).notNull().default("[]"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const agentGroupMember = sqliteTable(
  "agent_group_member",
  {
    id: id(),
    groupId: text("group_id")
      .notNull()
      .references(() => agentGroup.id, { onDelete: "cascade" }),
    definitionId: text("definition_id")
      .notNull()
      .references(() => agentDefinition.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("agent_group_member_unique_def").on(t.groupId, t.definitionId)]
);

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
  /** 可选；空则使用 dataDir/agents/{definitionId} */
  configRootUri: text("config_root_uri").notNull().default(""),
  /** 空则运行时使用 def:{definitionId} */
  memoryNamespace: text("memory_namespace").notNull().default(""),
  promptMode: text("prompt_mode", { enum: ["db_primary", "file_primary", "merged"] })
    .notNull()
    .default("db_primary"),
  configContentHash: text("config_content_hash").notNull().default(""),
  configSyncedAt: text("config_synced_at").notNull().default(""),
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
  phase: text("phase", {
    enum: ["perceive", "reason", "act", "observe", "external"],
  }).notNull(),
  thought: text("thought"),
  actionType: text("action_type", {
    enum: ["tool_call", "final_answer", "memory_read", "memory_write", "a2a_send", "cli_io"],
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
  /**
   * v2 P1 起新写入端直接落 workflow_run_id，避免老路径必须 join agent_step；
   * 旧行保持 NULL，前端 fallback 走 join 兼容。
   */
  workflowRunId: text("workflow_run_id").references(() => workflowRun.id),
  /** v2 P1：retry 上下文跨记录关联（idempotency / 多次 retry 同一 trace） */
  traceId: text("trace_id"),
  retryCount: integer("retry_count").notNull().default(0),
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
  /** v2 P1：与 tool_call_log 对齐，便于跨表 union 与重试关联 */
  traceId: text("trace_id"),
  retryCount: integer("retry_count").notNull().default(0),
  requestJson: text("request_json", { mode: "json" }).notNull(),
  responseJson: text("response_json", { mode: "json" }),
  status: text("status", { enum: ["success", "timeout", "failed", "sandbox_blocked"] }).notNull(),
  errorCode: text("error_code"),
  latencyMs: integer("latency_ms"),
  createdAt: createdAt(),
});

/**
 * 监控 V2 P1：LLM 调用粒度落库（每次 reason 节点的 LLM 调用一行）。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.1 / §4.3。
 *
 * 与 `agent_step.tokenCount` 的关系：
 *   - agent_step.tokenCount 仍保留为「步级别 token 聚合」（兼容旧前端）
 *   - llm_call_log 提供按 provider/model/24h 的跨工作流查询能力，并写 costUsd
 */
export const llmCallLog = sqliteTable("llm_call_log", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  agentStepId: text("agent_step_id").references(() => agentStep.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  latencyMs: integer("latency_ms").notNull(),
  status: text("status", {
    enum: ["success", "error", "timeout", "fallback"],
  }).notNull(),
  errorMessage: text("error_message"),
  costUsd: real("cost_usd"),
  /** secret-redacted 元信息（system/user prompt 长度等），不存原文。 */
  requestMetaJson: text("request_meta_json", { mode: "json" }).notNull().default("{}"),
  createdAt: createdAt(),
});

/**
 * 监控 V2 P1：MCP 熔断状态持久化。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.3 / §7.2 / §7.4。
 *
 * 与内存熔断（src/runtime/external-call/policy.ts:circuitByKey）的关系：
 *   - 内存为主：dispatcher 入口仍读 Map 做快速判定
 *   - DB 为辅：进程启动时还原 / 每 30s flush；让前端能看到「现在 datadog server 熔断中」
 */
export const mcpServerHealth = sqliteTable(
  "mcp_server_health",
  {
    id: id(),
    serverName: text("server_name").notNull(),
    circuitState: text("circuit_state", { enum: ["closed", "open", "half_open"] })
      .notNull()
      .default("closed"),
    failureCount: integer("failure_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    lastFailureAt: text("last_failure_at"),
    lastSuccessAt: text("last_success_at"),
    openedAt: text("opened_at"),
    lastCheckAt: text("last_check_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    cooldownMs: integer("cooldown_ms").notNull().default(30_000),
    lastErrorMessage: text("last_error_message"),
    createdAt: createdAt(),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [uniqueIndex("idx_mcp_server_health_name").on(t.serverName)]
);

/**
 * 监控 V2 P1：Skill 召回日志（reason 节点检索出来的候选 skill）。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.4。
 *
 * 与 agent_skill_run（显式执行）的对偶：本表抓「召回侧」，
 * agent_skill_run 抓「执行侧」；前端通过 executed 比较召回质量。
 */
export const skillRecallLog = sqliteTable("skill_recall_log", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  agentStepId: text("agent_step_id").references(() => agentStep.id),
  definitionId: text("definition_id").references(() => agentDefinition.id),
  skillId: text("skill_id")
    .notNull()
    .references(() => agentSkill.id),
  recallRank: integer("recall_rank"),
  score: real("score"),
  executed: integer("executed", { mode: "boolean" }).notNull().default(false),
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
  /**
   * 产出该 strategy_version 的 workflow_run.id；nullable 保留给 IDE / REST API /
   * 历史数据（M8 之前的产物没有 workflow 上下文）。
   * 用于研究产出侧栏严格按"本工作流"过滤；详见 migration 0047。
   */
  workflowRunId: text("workflow_run_id"),
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
  /** 因子表达式（与 lang 配合）：qlib_expr / python / sql / jsonlogic */
  expr: text("expr").notNull().default(""),
  lang: text("lang", {
    enum: ["qlib_expr", "python", "sql", "jsonlogic"],
  })
    .notNull()
    .default("python"),
  universe: text("universe").notNull().default("CN-A"),
  /** 预测周期（天） */
  horizon: integer("horizon").notNull().default(5),
  status: text("status", {
    enum: ["draft", "active", "archived"],
  })
    .notNull()
    .default("draft"),
  /** 计算用 Provider key（factor_compute kind），ProviderResolver 解析时使用 */
  providerKey: text("provider_key").notNull().default("python_inline"),
  /**
   * 产出该 factor 的 workflow_run.id；nullable 保留给 IDE / REST API / 历史数据
   * （M8 之前的产物没有 workflow 上下文）。
   * 用于研究产出侧栏严格按"本工作流"过滤；详见 migration 0047。
   */
  workflowRunId: text("workflow_run_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
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
  /** 回测 Provider 留痕：哪个 BacktestProvider 跑出了这次结果（sma_legacy / backtrader / veighna_bt …） */
  providerId: text("provider_id"),
  engineKey: text("engine_key").notNull().default("sma_legacy"),
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
  market: text("market"),
  symbol: text("symbol"),
  timeframe: text("timeframe"),
  strategyRuntimeId: text("strategy_runtime_id"),
  signalBarTime: text("signal_bar_time"),
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
    brokerAccountId: text("broker_account_id").references(() => brokerAccount.id),
    dispatchMode: text("dispatch_mode", { enum: ["paper", "live"] })
      .notNull()
      .default("paper"),
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

export const strategyRuntime = sqliteTable("strategy_runtime", {
  id: id(),
  strategyScriptId: text("strategy_script_id")
    .notNull()
    .references(() => indicatorStrategyScript.id, { onDelete: "cascade" }),
  brokerAccountId: text("broker_account_id").references(() => brokerAccount.id),
  status: text("status", {
    enum: ["stopped", "starting", "running", "error", "stopping"],
  })
    .notNull()
    .default("stopped"),
  executionMode: text("execution_mode", { enum: ["paper", "live"] })
    .notNull()
    .default("paper"),
  market: text("market").notNull(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("1d"),
  paramsJson: text("params_json", { mode: "json" }).notNull().default({}),
  lastBarTime: text("last_bar_time"),
  lastSignalAt: text("last_signal_at"),
  errorMessage: text("error_message"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const strategyRuntimeLog = sqliteTable("strategy_runtime_log", {
  id: id(),
  strategyRuntimeId: text("strategy_runtime_id")
    .notNull()
    .references(() => strategyRuntime.id, { onDelete: "cascade" }),
  level: text("level", { enum: ["debug", "info", "warn", "error"] })
    .notNull()
    .default("info"),
  message: text("message").notNull(),
  payloadJson: text("payload_json", { mode: "json" }).notNull().default({}),
  createdAt: createdAt(),
});

export const strategyPositionSnapshot = sqliteTable(
  "strategy_position_snapshot",
  {
    id: id(),
    strategyRuntimeId: text("strategy_runtime_id")
      .notNull()
      .references(() => strategyRuntime.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    qty: real("qty").notNull().default(0),
    avgPrice: real("avg_price"),
    updatedAt: updatedAt(),
  },
  (table) => ({
    runtimeSymbolUnique: uniqueIndex("idx_strategy_position_runtime_symbol").on(
      table.strategyRuntimeId,
      table.symbol
    ),
  })
);

export const strategySignalDedup = sqliteTable(
  "strategy_signal_dedup",
  {
    id: id(),
    strategyRuntimeId: text("strategy_runtime_id")
      .notNull()
      .references(() => strategyRuntime.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    signalType: text("signal_type", { enum: ["buy", "sell"] }).notNull(),
    signalBarTime: text("signal_bar_time").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    dedupUnique: uniqueIndex("idx_strategy_signal_dedup_unique").on(
      table.strategyRuntimeId,
      table.symbol,
      table.signalType,
      table.signalBarTime
    ),
  })
);

export const brokerAccount = sqliteTable("broker_account", {
  id: id(),
  provider: text("provider", { enum: ["futu", "ib", "ccxt"] }).notNull(),
  accountRef: text("account_ref").notNull(),
  mode: text("mode", { enum: ["mock", "sandbox", "live"] }).notNull().default("mock"),
  baseUrl: text("base_url"),
  providerConfigJson: text("provider_config_json", { mode: "json" }).notNull().default({}),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
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
  provider: text("provider", { enum: ["futu", "ib", "ccxt"] }).notNull(),
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
  /**
   * 监控 V2 P2 起 NULLABLE：
   * ACP 调用上下文（act.ts → AcpCaller → registry.dispatchAcpCall）只知道 connector 名字，
   * 不一定有持久化 connector_instance 行（市场行情 / 新闻类无状态 connector 永远没 instance）。
   * 详见 migration 0051。
   */
  connectorInstanceId: text("connector_instance_id").references(() => connectorInstance.id),
  /** 监控 V2 P2 新增：每条 log 都明确记录 connector 名字（不依赖 instance 反查） */
  connectorName: text("connector_name").notNull().default(""),
  /** 监控 V2 P2 新增：与 tool_call_log / mcp_call_log 对齐，便于跨表查询同一工作流的所有外部调用 */
  workflowRunId: text("workflow_run_id").references(() => workflowRun.id),
  acpCallId: text("acp_call_id").references(() => acpCall.id),
  traceId: text("trace_id").notNull(),
  operation: text("operation", {
    enum: ["init", "healthcheck", "execute", "shutdown"],
  }).notNull(),
  requestJson: text("request_json", { mode: "json" }).notNull(),
  responseJson: text("response_json", { mode: "json" }),
  latencyMs: integer("latency_ms").notNull(),
  status: text("status", { enum: ["success", "error", "timeout"] }).notNull(),
  /** 监控 V2 P2：失败 / timeout 时的错误消息摘要，最长 500 字 */
  errorMessage: text("error_message"),
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
  definitionId: text("definition_id").references(() => agentDefinition.id, { onDelete: "set null" }),
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
  definitionId: text("definition_id").references(() => agentDefinition.id, { onDelete: "set null" }),
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

/** Server-side market backtest job (SMA crossover v1, etc.). */
export const backtestJob = sqliteTable("backtest_job", {
  id: id(),
  status: text("status", {
    enum: ["queued", "running", "completed", "failed"],
  })
    .notNull()
    .default("queued"),
  kind: text("kind").notNull(),
  paramsJson: text("params_json", { mode: "json" }).notNull(),
  resultJson: text("result_json", { mode: "json" }),
  error: text("error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * 即时通讯渠道枚举：
 * - telegram  / feishu  / wecom (企业微信)
 * - whatsapp  / dingtalk
 * - webhook    （通用 outbound HTTP）
 */
export const COMMUNICATION_CHANNEL_KINDS = [
  "telegram",
  "feishu",
  "wecom",
  "whatsapp",
  "dingtalk",
  "webhook",
] as const;
export type CommunicationChannelKind = (typeof COMMUNICATION_CHANNEL_KINDS)[number];

export const communicationChannel = sqliteTable("communication_channel", {
  id: id(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id),
  projectId: text("project_id").references(() => project.id),
  kind: text("kind", { enum: COMMUNICATION_CHANNEL_KINDS }).notNull(),
  name: text("name").notNull(),
  externalChatId: text("external_chat_id").notNull(),
  secretRef: text("secret_ref").notNull().default(""),
  /**
   * 各 provider 私有配置（webhook URL / app_id / corp_id / agent_id / phone_number_id / sign 等）。
   * 与 secretRef 互补：通用敏感凭证放 secretRef，结构化参数放此处。
   */
  metaJson: text("meta_json", { mode: "json" }).notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const communicationMessageLog = sqliteTable("communication_message_log", {
  id: id(),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  channelKind: text("channel_kind", { enum: COMMUNICATION_CHANNEL_KINDS }).notNull(),
  channelId: text("channel_id").references(() => communicationChannel.id),
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

/** 研究团队 / 多 Agent 对话与 tool 调用轨迹（用于 IDE 拓扑与回放） */
export const researchTeamInteraction = sqliteTable("research_team_interaction", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  fromRole: text("from_role").notNull(),
  toRole: text("to_role").notNull(),
  kind: text("kind", {
    enum: ["llm_message", "tool_call", "signal_submit"],
  }).notNull(),
  toolKind: text("tool_kind"),
  toolName: text("tool_name"),
  contentText: text("content_text").notNull().default(""),
  payloadJson: text("payload_json", { mode: "json" }).notNull().default({}),
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

export const agentRuntimeMetric = sqliteTable(
  "agent_runtime_metric",
  {
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
    /**
     * 拆分聚合（v2 增加，迁移 0048）：
     *   { byTool: {...}, byMcp: {...}, bySkill: {...}, errorTopN: [...] }
     * 旧行默认 '{}'。前端 JSON.parse 失败时降级为空对象。
     */
    breakdownJson: text("breakdown_json", { mode: "json" }).notNull().default("{}"),
    createdAt: createdAt(),
  },
  (t) => [
    /**
     * v2 起 aggregateAgentRuntimeMetrics 使用 UPSERT 而非 INSERT；
     * 此唯一索引保证同 (definition, window) 只产生一行（迁移 0048 已 dedupe）。
     */
    uniqueIndex("idx_agent_runtime_metric_def_window").on(
      t.definitionId,
      t.windowStart,
      t.windowEnd
    ),
  ]
);

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

/** 实时交易 Agent 单 workflow 上下文消息（追加写入，过长时压缩） */
export const traderContextMessage = sqliteTable(
  "trader_context_message",
  {
    id: id(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRun.id, { onDelete: "cascade" }),
    /** 外部事件 id，用于 poll/下单 等去重 */
    sourceId: text("source_id"),
    role: text("role", {
      enum: ["user", "system", "driver", "agent", "compressed"],
    }).notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    payloadJson: text("payload_json", { mode: "json" }).notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("idx_trader_ctx_wf_source").on(t.workflowRunId, t.sourceId)]
);

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

// ─── LangGraph checkpointer 持久化 ────────────────────────────────────────────
// 每个 ReAct 节点完成后 LangGraph 会调用 `put`，把当前 channel state 落到这里。
// pending writes 在节点中断时存放未提交的写入，便于重启后恢复同一节点。

export const langgraphCheckpoint = sqliteTable(
  "langgraph_checkpoint",
  {
    threadId: text("thread_id").notNull(),
    checkpointNs: text("checkpoint_ns").notNull().default(""),
    checkpointId: text("checkpoint_id").notNull(),
    parentCheckpointId: text("parent_checkpoint_id"),
    type: text("type").notNull().default("json"),
    checkpointBlob: text("checkpoint_blob").notNull(),
    metadataBlob: text("metadata_blob").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("idx_langgraph_checkpoint_pk").on(t.threadId, t.checkpointNs, t.checkpointId),
  ]
);

/**
 * Phase 2.2：旁路 ReAct GraphState snapshot。
 * 节点边界写一行；与 langgraph_checkpoint 的二进制 blob 互为冗余。
 */
export const agentCheckpointSnapshot = sqliteTable(
  "agent_checkpoint_snapshot",
  {
    id: id(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRun.id),
    agentInstanceId: text("agent_instance_id")
      .notNull()
      .references(() => agentInstance.id),
    runId: text("run_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    phase: text("phase").notNull(),
    iteration: integer("iteration").notNull().default(0),
    snapshotJson: text("snapshot_json", { mode: "json" }).notNull(),
    stateHash: text("state_hash"),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_agent_checkpoint_snapshot_workflow").on(t.workflowRunId, t.stepIndex),
    index("idx_agent_checkpoint_snapshot_run").on(t.runId, t.stepIndex),
  ]
);

export const langgraphCheckpointWrite = sqliteTable(
  "langgraph_checkpoint_write",
  {
    threadId: text("thread_id").notNull(),
    checkpointNs: text("checkpoint_ns").notNull().default(""),
    checkpointId: text("checkpoint_id").notNull(),
    taskId: text("task_id").notNull(),
    idx: integer("idx").notNull(),
    channel: text("channel").notNull(),
    type: text("type").notNull().default("json"),
    valueBlob: text("value_blob").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("idx_langgraph_checkpoint_write_pk").on(
      t.threadId,
      t.checkpointNs,
      t.checkpointId,
      t.taskId,
      t.idx
    ),
  ]
);

// ─── M1：Provider 抽象层 ──────────────────────────────────────────────────────
// 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §5.4：所有外部能力通过 Provider 接口隔离

/**
 * Provider 注册中心：因子计算 / 因子评估 / 规则引擎 / 回测引擎 / 实盘 EMS / 行情源 / LLM / 因子挖掘
 * - status=enabled 且 priority 最高的同 kind Provider 默认被解析
 * - is_builtin=1 标识 bootstrap 注册的内置 Provider（不可删除，可禁用）
 * - is_fallback=1 标识最低保真 fallback（任何 kind 至少 1 个）
 */
export const providerRegistry = sqliteTable("provider_registry", {
  id: id(),
  kind: text("kind", {
    enum: ["factor_compute", "factor_eval", "rule_engine", "backtest"],
  }).notNull(),
  providerKey: text("provider_key").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull().default(""),
  capabilityJson: text("capability_json", { mode: "json" }).notNull().default("{}"),
  configJson: text("config_json", { mode: "json" }).notNull().default("{}"),
  status: text("status", { enum: ["enabled", "disabled"] })
    .notNull()
    .default("enabled"),
  priority: integer("priority").notNull().default(50),
  version: text("version").notNull().default("0.1.0"),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  isFallback: integer("is_fallback", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Provider 与业务对象的绑定，支持 project/workflow/strategy_version/global 粒度选型 */
export const providerBinding = sqliteTable("provider_binding", {
  id: id(),
  scope: text("scope", {
    enum: ["global", "project", "workflow", "strategy_version"],
  }).notNull(),
  scopeId: text("scope_id"),
  kind: text("kind").notNull(),
  providerId: text("provider_id")
    .notNull()
    .references(() => providerRegistry.id, { onDelete: "cascade" }),
  paramsJson: text("params_json", { mode: "json" }).notNull().default("{}"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── M1：研究场景注册中心 ────────────────────────────────────────────────────
// 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.6：研究团队多场景化

/** 研究场景：分析辩论 / 策略撰写 / 因子研究 / 规则研究 / 风控审查 / PM 组合 / 挖掘 / 选股 / 实盘 / 复盘 / 事件雷达 */
export const researchScenario = sqliteTable("research_scenario", {
  id: id(),
  key: text("key").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull().default(""),
  /** 默认编组（agent_group.id）；不声明 FK 以避免循环 */
  defaultAgentGroupId: text("default_agent_group_id"),
  /** schema-driven 表单（字段 → FieldSchema） */
  inputSchemaJson: text("input_schema_json", { mode: "json" }).notNull().default("{}"),
  /** 主/副产物契约：{primary: 'factor_definition_batch', secondary: [...]} */
  outputContractJson: text("output_contract_json", { mode: "json" }).notNull().default("{}"),
  /** [{kind: 'factor_compute', level: 'required'}, ...] */
  requiredCapabilitiesJson: text("required_capabilities_json", { mode: "json" })
    .notNull()
    .default("[]"),
  /** 默认工具：builtinTools / connectors / mcpServers / defaultParams */
  toolPresetJson: text("tool_preset_json", { mode: "json" }).notNull().default("{}"),
  /** maxIterations / reactLoop / requireDebate / requireRiskVeto / requirePmApproval */
  loopDefaultsJson: text("loop_defaults_json", { mode: "json" }).notNull().default("{}"),
  status: text("status", { enum: ["enabled", "disabled"] })
    .notNull()
    .default("enabled"),
  sortOrder: integer("sort_order").notNull().default(100),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 场景 → 编组：同一场景可绑定多个编组（默认 / 轻量 / 深度 / 用户自建） */
export const researchScenarioGroup = sqliteTable("research_scenario_group", {
  id: id(),
  scenarioId: text("scenario_id")
    .notNull()
    .references(() => researchScenario.id, { onDelete: "cascade" }),
  agentGroupId: text("agent_group_id").notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(100),
  createdAt: createdAt(),
});

// ─── M1：因子-规则-策略 三段式骨架 ────────────────────────────────────────────
// 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.1 §6.2 §6.3 §6.4
// 因子值（symbol×date×factor 高基数）由 DuckDB+Parquet 承载，本表只存控制面/评估面

/** 因子质量评估：IC / RankIC / IR / 衰减 / 换手率 */
export const factorEvaluation = sqliteTable("factor_evaluation", {
  id: id(),
  factorId: text("factor_id")
    .notNull()
    .references(() => factorDefinition.id, { onDelete: "cascade" }),
  asof: text("asof").notNull(),
  universe: text("universe").notNull(),
  providerId: text("provider_id"),
  ic: real("ic"),
  rankIc: real("rank_ic"),
  ir: real("ir"),
  turnover: real("turnover"),
  decayCurveJson: text("decay_curve_json", { mode: "json" }).notNull().default("[]"),
  groupReturnsJson: text("group_returns_json", { mode: "json" }).notNull().default("[]"),
  sampleSize: integer("sample_size").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  error: text("error"),
  createdAt: createdAt(),
});

/** 规则定义：JSONLogic 子集 / Python；applies_to 决定挂在选股/过滤/打分/排序/风控的哪一段 */
export const ruleDefinition = sqliteTable("rule_definition", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  appliesTo: text("applies_to", {
    enum: ["select", "filter", "score", "order", "risk"],
  })
    .notNull()
    .default("score"),
  lang: text("lang", { enum: ["jsonlogic", "python"] })
    .notNull()
    .default("jsonlogic"),
  dslJson: text("dsl_json", { mode: "json" }).notNull().default("{}"),
  status: text("status", { enum: ["draft", "active", "archived"] })
    .notNull()
    .default("draft"),
  providerKey: text("provider_key").notNull().default("jsonlogic"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 规则评估留痕：方便 debug 与归因 */
export const ruleEvaluationLog = sqliteTable("rule_evaluation_log", {
  id: id(),
  ruleId: text("rule_id")
    .notNull()
    .references(() => ruleDefinition.id, { onDelete: "cascade" }),
  asof: text("asof").notNull(),
  inputHash: text("input_hash").notNull().default(""),
  outputJson: text("output_json", { mode: "json" }).notNull().default("{}"),
  sampleSize: integer("sample_size").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  error: text("error"),
  createdAt: createdAt(),
});

/** 策略组合：factor_ids + rule_ids + 权重方法 + 调仓频率 + 选股域 */
export const strategyComposition = sqliteTable("strategy_composition", {
  id: id(),
  strategyVersionId: text("strategy_version_id")
    .notNull()
    .references(() => strategyVersion.id, { onDelete: "cascade" }),
  kind: text("kind", {
    enum: ["factor_score", "rule", "hybrid", "script"],
  })
    .notNull()
    .default("factor_score"),
  factorIdsJson: text("factor_ids_json", { mode: "json" }).notNull().default("[]"),
  ruleIdsJson: text("rule_ids_json", { mode: "json" }).notNull().default("[]"),
  weightMethod: text("weight_method", {
    enum: ["equal", "rank_ic_weighted", "ic_ir_weighted", "manual"],
  })
    .notNull()
    .default("equal"),
  rebalanceFreq: text("rebalance_freq").notNull().default("1d"),
  universe: text("universe").notNull().default("CN-A"),
  paramsJson: text("params_json", { mode: "json" }).notNull().default("{}"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 挖掘任务编排留痕：因子挖掘 / 规则挖掘 / 协演化 */
export const discoveryJob = sqliteTable("discovery_job", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id),
  workflowRunId: text("workflow_run_id"),
  kind: text("kind", {
    enum: ["factor_gp", "factor_alpha101", "factor_llm", "rule_llm", "genome_evolve"],
  }).notNull(),
  inputJson: text("input_json", { mode: "json" }).notNull().default("{}"),
  outputJson: text("output_json", { mode: "json" }).notNull().default("{}"),
  status: text("status", {
    enum: ["pending", "running", "succeeded", "failed", "cancelled", "stopped_early"],
  })
    .notNull()
    .default("pending"),
  error: text("error"),
  startedAt: createdAt(),
  endedAt: text("ended_at"),
  createdAt: createdAt(),
});

// ─── M11: Agent 自进化（agent_skill / agent_skill_run / skill_curator_run / skill_evolution_run）─

export const agentSkill = sqliteTable(
  "agent_skill",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    definitionId: text("definition_id").references(() => agentDefinition.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    bodyMd: text("body_md").notNull().default(""),
    category: text("category").notNull().default("general"),
    version: text("version").notNull().default("v1"),
    parentSkillId: text("parent_skill_id"),
    source: text("source", {
      enum: ["agent_created", "user_authored", "open_skill_market", "evolved"],
    })
      .notNull()
      .default("agent_created"),
    externalInstallId: text("external_install_id").references(() => skillMarketInstall.id, {
      onDelete: "set null",
    }),
    state: text("state", { enum: ["active", "stale", "archived", "pending_review"] })
      .notNull()
      .default("active"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    useCount: integer("use_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    lastUsedAt: text("last_used_at"),
    metadataJson: text("metadata_json", { mode: "json" }).notNull().default("{}"),
    createdBy: text("created_by").notNull().default("agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("idx_agent_skill_project_name").on(t.projectId, t.name),
    index("idx_agent_skill_project_state").on(t.projectId, t.state, t.lastUsedAt),
    index("idx_agent_skill_definition").on(t.definitionId, t.state),
    index("idx_agent_skill_parent").on(t.parentSkillId),
  ]
);

export const agentSkillRun = sqliteTable(
  "agent_skill_run",
  {
    id: id(),
    skillId: text("skill_id")
      .notNull()
      .references(() => agentSkill.id, { onDelete: "cascade" }),
    workflowRunId: text("workflow_run_id").references(() => workflowRun.id, { onDelete: "set null" }),
    agentInstanceId: text("agent_instance_id").references(() => agentInstance.id, {
      onDelete: "set null",
    }),
    definitionId: text("definition_id").references(() => agentDefinition.id, {
      onDelete: "set null",
    }),
    outcome: text("outcome", { enum: ["success", "fail", "partial", "unknown"] })
      .notNull()
      .default("unknown"),
    score: real("score"),
    notes: text("notes").notNull().default(""),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [
    index("idx_agent_skill_run_skill").on(t.skillId, t.startedAt),
    index("idx_agent_skill_run_workflow").on(t.workflowRunId),
  ]
);

export const skillCuratorRun = sqliteTable(
  "skill_curator_run",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: ["dry_run", "live"] }).notNull().default("dry_run"),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    triggeredBy: text("triggered_by").notNull().default("cron"),
    totalChecked: integer("total_checked").notNull().default(0),
    markedStale: integer("marked_stale").notNull().default(0),
    archived: integer("archived").notNull().default(0),
    consolidated: integer("consolidated").notNull().default(0),
    pruned: integer("pruned").notNull().default(0),
    summaryText: text("summary_text").notNull().default(""),
    summaryYaml: text("summary_yaml").notNull().default(""),
    actionsJson: text("actions_json", { mode: "json" }).notNull().default("[]"),
    errorMessage: text("error_message"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [index("idx_skill_curator_run_project").on(t.projectId, t.startedAt)]
);

export const skillEvolutionRun = sqliteTable(
  "skill_evolution_run",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    baseSkillId: text("base_skill_id")
      .notNull()
      .references(() => agentSkill.id, { onDelete: "cascade" }),
    datasetId: text("dataset_id").references(() => evalDataset.id),
    iterations: integer("iterations").notNull().default(5),
    candidatesEvaluated: integer("candidates_evaluated").notNull().default(0),
    baselineScore: real("baseline_score"),
    bestScore: real("best_score"),
    winningSkillId: text("winning_skill_id"),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    reportJson: text("report_json", { mode: "json" }).notNull().default("{}"),
    errorMessage: text("error_message"),
    triggeredBy: text("triggered_by").notNull().default("user"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [
    index("idx_skill_evolution_base").on(t.baseSkillId, t.startedAt),
    index("idx_skill_evolution_project").on(t.projectId, t.startedAt),
  ]
);

// ─── EnvironmentManager（v0.2）─────────────────────────────────────────────
// 详见 docs/ENVIRONMENT_MANAGER_DESIGN.md §4.3 / §6.0：
// 把 Python pip / mcp-bin npm 包的「期望清单」从代码常量挪到 DB，让用户
// 可以在 UI 编辑（启停 / 改版本约束 / 新增推荐项），同时保留代码 seed
// 作为系统默认值。设计参考 provider_registry：seed 仅 upsert 系统侧字段，
// 不覆盖用户编辑过的字段。
//
// 仅 stdio 类 MCP 进入 env_registry（kind=npm）；HTTP/WS 类远程 MCP 不
// 入此表，仅在 connector-probes 中体检（决议 §10.6）。

/** EnvironmentManager 期望清单：包元信息 + 用户编辑覆写 */
export const envRegistry = sqliteTable(
  "env_registry",
  {
    id: id(),
    /** python = pip 包；npm = mcp-bin 下 npm stdio 包 */
    kind: text("kind", { enum: ["python", "npm"] }).notNull(),
    packageName: text("package_name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    /** 默认版本约束（来自 seed），如 ">=0.2.40" */
    versionSpec: text("version_spec"),
    /** 用户在 UI 覆写的版本，优先于 versionSpec */
    userVersionSpec: text("user_version_spec"),
    /** 缺失是否影响 ok（true → 可选） */
    optional: integer("optional", { mode: "boolean" }).notNull().default(true),
    /** "data-source/yfinance" / "broker/futu" / "core" 等 */
    capability: text("capability").notNull().default("misc"),
    /** seed 来源；user = 用户自建项 */
    source: text("source", {
      enum: ["requirements", "connector-meta", "seed-mcp", "user"],
    })
      .notNull()
      .default("user"),
    status: text("status", { enum: ["enabled", "disabled"] })
      .notNull()
      .default("enabled"),
    /** 系统默认项（不可 DELETE，仅可 disabled） */
    isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
    /** 透传字段，例如 npm 包的 npxArgs 默认值 */
    extraJson: text("extra_json", { mode: "json" }).notNull().default("{}"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("idx_env_registry_kind_pkg").on(t.kind, t.packageName),
    index("idx_env_registry_kind_status_cap").on(t.kind, t.status, t.capability),
  ]
);

/** EnvironmentManager 安装/卸载/升级历史；short-poll 进度 + 排障审计用 */
export const envInstallLog = sqliteTable(
  "env_install_log",
  {
    id: id(),
    kind: text("kind", { enum: ["python", "npm"] }).notNull(),
    operation: text("operation", {
      enum: ["install", "uninstall", "upgrade"],
    }).notNull(),
    packageName: text("package_name").notNull(),
    requestedVersion: text("requested_version"),
    installedVersion: text("installed_version"),
    status: text("status", {
      enum: ["running", "success", "failed", "timeout"],
    }).notNull(),
    /** stderr 截断 800 字符；失败排障用 */
    errorMessage: text("error_message"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    finishedAt: text("finished_at"),
    /** "user" / "bootstrap" / "connector_init" / "test" */
    triggeredBy: text("triggered_by").notNull().default("user"),
  },
  (t) => [
    index("idx_env_install_log_kind_pkg_started").on(
      t.kind,
      t.packageName,
      t.startedAt
    ),
    index("idx_env_install_log_status_started").on(t.status, t.startedAt),
  ]
);
