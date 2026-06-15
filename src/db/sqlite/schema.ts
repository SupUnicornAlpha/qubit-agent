import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─── Helper: default nanoid-style text PK ────────────────────────────────────

const id = () => text("id").primaryKey();
const createdAt = () =>
  text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
const updatedAt = () =>
  text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

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
  /** Agent 执行循环：native=自研 ReAct while 循环；claude_cli / codex_cli=外部 CLI（见 src/runtime/loop） */
  loopKind: text("loop_kind", { enum: ["native", "claude_cli", "codex_cli"] })
    .notNull()
    .default("native"),
  /**
   * native 循环下的执行路径。收敛后唯一总线为 a2a；"graph" 枚举仅兼容历史 DB 行，
   * 实际不再路由到 LangGraph（resolveExecutionPath 对 native 恒返回 a2a）。
   */
  executionPath: text("execution_path", { enum: ["graph", "a2a"] })
    .notNull()
    .default("a2a"),
  loopOptionsJson: text("loop_options_json", { mode: "json" }).notNull().default("{}"),
  startedAt: createdAt(),
  endedAt: text("ended_at"),
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
  actionType: text("action_type", {
    enum: ["retry_from_start", "resume", "manual_intervention"],
  }).notNull(),
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
 * 运行中向 Orchestrator/agent「随时插话」的消息队列（coding-agent 风格持续对话）。
 *
 * 后端运行循环（run-react-loop.ts）只在 HITL 节点硬暂停；要让用户在循环跑动时随时
 * 追加指令，这里用一张轻量队列表承接：前端 POST /workflows/:id/inject-message 入队，
 * ReAct 循环在每轮 reason 前 drain 本工作流的 queued 消息 → 注入 LLM 上下文。
 *
 * - targetRole 为空 = 任意 agent 可消费；指定 role（如 orchestrator）= 仅该角色 drain。
 * - status: queued → injected（被某轮 drain 取走）；dropped 预留给清理/取消。
 * - 软注入，不阻塞工作流；与 workflow_hitl_request（硬暂停）互补、互不冲突。
 */
export const userMessageQueue = sqliteTable(
  "user_message_queue",
  {
    id: id(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRun.id),
    /** 目标角色；NULL = 任意 agent 可消费，否则仅该 role drain */
    targetRole: text("target_role"),
    content: text("content").notNull(),
    status: text("status", { enum: ["queued", "injected", "dropped"] })
      .notNull()
      .default("queued"),
    createdAt: createdAt(),
    injectedAt: text("injected_at"),
  },
  (t) => ({
    byWorkflowStatus: index("idx_user_msg_queue_wf_status").on(t.workflowRunId, t.status),
  })
);

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
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
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
  allowedMcpServersJson: text("allowed_mcp_servers_json", { mode: "json" }).notNull().default("[]"),
  allowedConnectorsJson: text("allowed_connectors_json", { mode: "json" }).notNull().default("[]"),
  allowedHostsJson: text("allowed_hosts_json", { mode: "json" }).notNull().default("[]"),
  allowedFsPathsJson: text("allowed_fs_paths_json", { mode: "json" }).notNull().default("[]"),
  canWriteMemory: integer("can_write_memory", { mode: "boolean" }).notNull().default(true),
  canReadLiveMarket: integer("can_read_live_market", { mode: "boolean" }).notNull().default(false),
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
  /**
   * 明文 apiKey 持久化字段（migration 0079 引入）。
   *
   * 在 B-P0 阶段 apiKey 仅写入 `process.env[apiKeyRef]`，重启后丢失；user 反馈下次启动
   * 显示"缺 apiKey"即此 bug。改为把明文落库 + 启动时 hydrate 回 process.env，保证持久化。
   *
   * 安全性说明：本字段在本地 SQLite 中明文存放，仅适用于"本地工具"场景。后续 B-P1
   * 切换到 OS keychain 时，把这里的迁移成 keychain key id 即可（保持 apiKeyRef 不变）。
   */
  apiKeySecret: text("api_key_secret"),
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
  definitionId: text("definition_id").references(() => agentDefinition.id, {
    onDelete: "set null",
  }),
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

// Schema 收敛 C4（migration 0071）：原 `mcp_catalog_item` 表已并入下面的
// `mcp_catalog` —— 用 `source` 字段区分 'builtin' / 'registry' / 'fsi' 来源，
// registry 同步来的行额外带 `sourceId` / `externalId` / `version`。
//
// 之前两表 95% 字段重叠：mcp_catalog_item 的 specJson JSON blob 里存的 command /
// url / defaultToolName / defaultTimeoutMs / defaultRetryPolicyJson /
// defaultRateLimitJson / defaultCapabilitiesJson / setupSchemaJson 全部是
// mcp_catalog 的顶级列；market-service.installCatalogItemToProject 在装机时
// 就要做一次 shadow-copy 把 item 复制到 catalog，证明它们语义相同。
// 合表后这层 shadow-copy 直接删掉。

export const mcpCatalog = sqliteTable(
  "mcp_catalog",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    provider: text("provider").notNull().default("community"),
    /** 来源域：'builtin'（内置）/ 'registry'（订阅源同步）/ 'fsi'（FSI 内容包） */
    source: text("source").notNull().default("builtin"),
    /** 仅 source='registry' 时非空：指向同步源 */
    sourceId: text("source_id").references(() => mcpRegistrySource.id),
    /** 仅 source='registry' 时非空：上游 registry 的 externalId */
    externalId: text("external_id").notNull().default(""),
    /** 仅 source='registry' 时非默认值：上游版本号 */
    version: text("version").notNull().default("latest"),
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
    defaultRateLimitJson: text("default_rate_limit_json", { mode: "json" }).notNull().default("{}"),
    defaultCapabilitiesJson: text("default_capabilities_json", { mode: "json" })
      .notNull()
      .default("[]"),
    setupSchemaJson: text("setup_schema_json", { mode: "json" }).notNull().default("{}"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    /**
     * 唯一键：`(source, COALESCE(source_id,''), slug)` 见 migration 0071。
     * 不同 source 之间允许同名 slug（如 builtin 的 'filesystem-local' 与 registry 同步
     * 来的同名条目），同 source 下 (sourceId, slug) 唯一。
     *
     * 注意：这里的 drizzle `uniqueIndex` 声明只是给 `.onConflictDoNothing` 之类
     * targeting 用，真正的 DDL 在 migration 0071 用了 COALESCE 表达式索引。
     */
    sourceSlugUnique: uniqueIndex("idx_mcp_catalog_source_slug").on(
      table.source,
      table.sourceId,
      table.slug
    ),
  })
);

export const mcpCatalogInstall = sqliteTable("mcp_catalog_install", {
  id: id(),
  projectId: text("project_id").references(() => project.id),
  workspaceId: text("workspace_id").references(() => workspace.id),
  sourceId: text("source_id").references(() => mcpRegistrySource.id),
  // Schema 收敛 C4（migration 0071）：原 `catalog_item_id` 列已删除 ——
  // `mcp_catalog_item` 已并入 `mcp_catalog`，安装审计只需 `catalog_id` 一条 FK。
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
  /**
   * Per-Agent LLM 采样配置（迁移 0067，LLM 网关 P1）。
   *
   * 形如 `{ "temperature": 0.2, "maxOutputTokens": 8192, "reasoningEffort": "high" }`。
   * 字段全部 optional：不写 / 写 `{}` 等价于走网关默认值（与 P0 行为一致）。
   *
   * 为什么用 JSON 列而不是 N 个独立 column：
   *   - 字段会持续扩展（top_p / top_k / repetition_penalty / vendor 私有 knob）；
   *   - 老 agent 行下 ALTER 加 5+ 列会污染 audit 历史；
   *   - 网关只会 spread 已知字段，未知 knob 直接忽略，前向兼容。
   */
  llmConfigJson: text("llm_config_json", { mode: "json" }).notNull().default("{}"),
  /**
   * 角色产出能力（migration 0073）。Dispatcher 据此把 role 自动分桶进 MSA fusion /
   * report aggregator / events collector / factor candidates collector / 等。
   *
   * 取代了硬编码的 `isMsAnalystRole` / `POST_FUSION_AUX_ROLES` / `RESEARCH_TEAM_SLOT_SET`
   * 三套散落 role 列表。空数组（旧 seed 行 / 第三方 def）走 dispatcher 兼容路径，
   * 仍按 role 名走老 fallback。
   *
   * 合法值：`signal | report | events | factor_candidates | strategy_dsl | backtest_results | risk_assessment`
   * 详见 src/runtime/types.ts `AgentOutput`。
   */
  outputsJson: text("outputs_json", { mode: "json" }).notNull().default("[]"),
  maxIterations: integer("max_iterations").notNull().default(20),
  sandboxPolicyId: text("sandbox_policy_id")
    .notNull()
    .references(() => sandboxPolicy.id),
  signalWeight: real("signal_weight").notNull().default(1.0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * Per-field user-override sentinel（migration 0074, F-P0-06 fix）。
   *
   * 形如 `{"mcp_servers_json": true, "tools_json": true}`：列出 user 显式改过、
   * 不希望被启动期 seed / workspace-config 同步覆盖的字段名。Seed / sync 路径
   * 会在 UPSERT 前查这张 map，对 sentinel=true 的字段跳过 `set:` 子句。
   *
   * 写入入口：
   *   - `POST /api/v1/agents/definitions/:id/bindings`（前端 / curl）
   *   - `setAgentDefinitionBinding()` runtime helper（程序化绑定）
   *   - 直连 SQL：脚本可以 `UPDATE … SET user_overrides_json = json_set(...)` 自助
   *
   * 不覆盖：role / name / version 仍 seed-only。
   *
   * Reset：`POST /api/v1/agents/builtin/reload`（force=true）会清空所有 override
   * 并回到 SEED_AGENT_DEFINITIONS 默认值，等价于 factory reset。
   */
  userOverridesJson: text("user_overrides_json", { mode: "json" }).notNull().default("{}"),
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
  /**
   * 编组的 dispatch 模式（migration 0073）。决定 analyst-team.ts / 同类 runner
   * 怎么编排 memberRoles 的产出。
   *
   * 合法值（详见 src/runtime/seed-agent-catalog.ts `AgentGroupPipelineKind`）：
   *   - 'msa_fusion'          : 4 类 analyst_* → 投票融合 → 可选 aux post-fusion（**当前默认行为**）
   *   - 'sequential_research' : 按 memberRoles 顺序跑，无 MSA 投票
   *   - 'event_radar'         : events 角色主导扫描，signal 角色辅助
   *   - 'factor_discovery'    : research → factor_candidates → backtest_results
   *
   * 默认 'msa_fusion'：旧编组 / 用户自定义不指定时保持现状语义。
   */
  pipelineKind: text("pipeline_kind").notNull().default("msa_fusion"),
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

// Schema 收敛 C5-1（migration 0070）：`acp_call` 已删除。
// 4 个终态 helper 之外只有 minimum-acceptance 脚本读 1 处行数断言，0 个
// monitor 服务 / 0 个前端组件消费；同样字段已落在 tool_call_log + mcp_call_log。

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
  /**
   * 监控 v3 P0 冗余列（迁移 0064）：直接记录调用方 agent 的 definitionId，
   * 让 /monitor/timeseries 等"按 Agent 切分"的查询不必 3 跳 join
   * (tool_call_log → agent_step → agent_instance → agent_definition)。
   * 旧行保持 NULL；timeseries 在 groupBy=agentDefinitionId 时直接过滤掉 NULL。
   */
  agentDefinitionId: text("agent_definition_id").references(() => agentDefinition.id),
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
  /**
   * 工具错误分类（迁移 0084）：把原本只埋在 response_json.toolError / observation
   * 里的 `classifyToolError` 结果提成一等列。让"工具错误排查"类查询
   * （按 transient/permanent/blocked 切分、统计可重试错误占比）走单列索引，
   * 不必再 `responseJson LIKE '%"toolError":true%'` 全表扫。
   *
   * 语义：
   *   - status=success            → NULL
   *   - status=error              → transient | permanent | blocked | unknown（classifyToolError）
   *   - status=timeout            → "transient"（超时天然可重试）
   *   - status=sandbox_blocked    → "blocked"
   * 旧行保持 NULL（迁移不回填）；监控端 fallback 仍可读 response_json。
   */
  errorClass: text("error_class", {
    enum: ["transient", "permanent", "blocked", "unknown"],
  }),
  createdAt: createdAt(),
}, (t) => [
  /** 工具错误排查：按 status + errorClass 切分，配合 createdAt 做时间窗聚合 */
  index("idx_tool_call_log_status_class_created").on(t.status, t.errorClass, t.createdAt),
]);

/**
 * Exec 能力源调用日志（migration 0075）。
 *
 * 与 `tool_call_log` 1:1 同主键：`exec_call_log.id === tool_call_log.id`。
 * 仿照 mcp_call_log 同构，让监控页可以平滑 JOIN：
 *   SELECT t.*, e.provider_id, e.exit_code, e.stdout_bytes
 *   FROM tool_call_log t JOIN exec_call_log e ON t.id = e.id
 *   WHERE t.tool_name IN ('shell.exec', 'cli_agent.run');
 *
 * 设计取舍：
 *   - 不存 stdout/stderr 原文（可能 256KB 级），只存字节数 → 真要看输出从 tool_call_log.response_json 拿
 *   - error_code 是 ExecResult 的结构化码（binary_not_found / cwd_escape / wall_timeout 等）
 *   - status 沿用 tool_call_log 的 4 枚举，跨表 union 查询零映射
 */
export const execCallLog = sqliteTable("exec_call_log", {
  id: id(),
  workflowRunId: text("workflow_run_id")
    .notNull()
    .references(() => workflowRun.id),
  agentStepId: text("agent_step_id")
    .notNull()
    .references(() => agentStep.id),
  /** 监控 v3 P0：同 toolCallLog.agentDefinitionId，避免按 Agent 切分时多跳 join。 */
  agentDefinitionId: text("agent_definition_id").references(() => agentDefinition.id),
  traceId: text("trace_id"),
  retryCount: integer("retry_count").notNull().default(0),

  // ─── Provider 维度（exec 独有，便于按 binary 切分） ─────────────────
  /** EXEC_PROVIDERS 注册的 id（git / jq / duckdb / claude-code / aider）；空表示未走 registry */
  providerId: text("provider_id").notNull(),
  /** "shell" | "cli_agent" */
  execKind: text("exec_kind", { enum: ["shell", "cli_agent"] }).notNull(),
  /** 实际 binary（可能与 providerId 不同，例如 claude-code provider 的 binary 是 "claude"） */
  binary: text("binary").notNull(),

  // ─── 输入维度 ─────────────────────────────────────────────────────
  /** argv 数组（不含 binary 本身），JSON 字符串 */
  argsJson: text("args_json", { mode: "json" }).notNull().default("[]"),
  /** 工作目录绝对路径 */
  cwd: text("cwd").notNull(),
  /** stdin 字节数（仅记长度，避免落原文） */
  stdinBytes: integer("stdin_bytes").notNull().default(0),

  // ─── 输出维度 ─────────────────────────────────────────────────────
  /** 子进程退出码；NULL = 被 kill / timeout */
  exitCode: integer("exit_code"),
  /** stdout 字节数（截断前的原始量） */
  stdoutBytes: integer("stdout_bytes").notNull().default(0),
  /** stderr 字节数 */
  stderrBytes: integer("stderr_bytes").notNull().default(0),
  /** 是否触发 maxOutputBytes 截断（0/1） */
  truncated: integer("truncated").notNull().default(0),

  // ─── 状态维度 ─────────────────────────────────────────────────────
  status: text("status", {
    enum: ["success", "error", "timeout", "sandbox_blocked"],
  }).notNull(),
  /**
   * ExecResult.error 的结构化错误码：
   *   binary_not_found / binary_not_registered / cwd_escape / shell_metachar /
   *   disallowed_subcommand / wall_timeout / output_truncated / nonzero_exit / exec_failed
   */
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  latencyMs: integer("latency_ms"),

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
  /** 监控 v3 P0：同 toolCallLog.agentDefinitionId，避免按 Agent 切分时多跳 join。 */
  agentDefinitionId: text("agent_definition_id").references(() => agentDefinition.id),
  serverName: text("server_name").notNull(),
  toolName: text("tool_name").notNull(),
  /** v2 P1：与 tool_call_log 对齐，便于跨表 union 与重试关联 */
  traceId: text("trace_id"),
  retryCount: integer("retry_count").notNull().default(0),
  /**
   * 监控 v3 P0（迁移 0064）：记录调用所用 transport（stdio / http / ws），
   * 用于按 transport 维度切分 MCP 调用量、定位"stdio 不稳定但 http 正常"之类的情况。
   * 旧行 NULL；写入侧从 dispatcher 已知的 server 配置反查（详见 docs/MONITORING_V2_DESIGN.md §4.3.2）。
   */
  transport: text("transport"),
  /**
   * 监控 v3 P0：调用发生时该 server 的熔断器状态快照（closed/open/half_open）。
   * 在失败/超时复盘时尤其有用：能立刻区分"调用真的失败"还是"短路返回"。
   */
  circuitState: text("circuit_state", { enum: ["closed", "open", "half_open"] }),
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
  /**
   * 监控 v3 P0（迁移 0064）：调用方 agent 的 definitionId 冗余。
   * 不冗余的话，"某 Agent 24h 内消耗多少 token / cost"要从
   * llm_call_log → agent_step → agent_instance → agent_definition 3 跳 join；
   * 加这列后 /monitor/timeseries?source=llm_call_log&groupBy=agentDefinitionId 直接走索引。
   */
  agentDefinitionId: text("agent_definition_id").references(() => agentDefinition.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  /**
   * 监控 V3 P0（迁移 0066）：Gateway P0 增强字段。
   *
   * - `promptCachedTokens`：OpenAI Responses / Anthropic prompt-cache 命中的输入
   *   token 数（可选，老 chat.completions 模型不返回）。计 cost 时按 cached
   *   单价（约 standard 输入价的 1/4）。
   * - `reasoningTokens`：o-series / gpt-5 暴露的"链式思考"token 数；包含在
   *   `completionTokens` 内，单独存便于 reasoning ratio 监控。
   * - `firstTokenLatencyMs`：流式首 token / 非流式整段 latency，用作 TTFT 指标。
   * - `finishReason`：'stop' / 'length' / 'tool_calls' / 'content_filter' /
   *   'incomplete' 等；用于诊断"输出被截断"等高频问题。
   * - `responseId`：服务端返回的 chatcmpl-* / resp_* / msg_*；用于跨日志追溯
   *   （客服/运维拿到 id 能直接 join 到该次调用）。
   *
   * 全部 nullable：旧行不需要回填即可读，新写入路径自动填。
   */
  promptCachedTokens: integer("prompt_cached_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  firstTokenLatencyMs: integer("first_token_latency_ms"),
  finishReason: text("finish_reason"),
  responseId: text("response_id"),
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
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
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
  /**
   * 产物 lineage（migration 0080）：
   *   - createdBy：'user' | 'agent' | 'discovery_promote' | 'system'
   *   - agentInstanceId：发起注册的 agent_instance.id（仅 agent 路径）
   *   - sourceJobId：discovery_job.id（promote 时记录上游挖掘任务）
   */
  createdBy: text("created_by").notNull().default("user"),
  agentInstanceId: text("agent_instance_id"),
  sourceJobId: text("source_job_id"),
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
  /**
   * 产物 lineage（migration 0080）：
   *   - createdBy / workflowRunId：与其他研究产物表同协议
   *   - compositionId：直接关联回测使用的 strategy_composition.id（NULL = 走 raw signals 模式）
   * `agentInstanceId` 列在初始 schema 已存在，BacktestJobService.submit 改造后会真正写入。
   */
  createdBy: text("created_by").notNull().default("user"),
  workflowRunId: text("workflow_run_id"),
  compositionId: text("composition_id"),
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
    enum: ["submitted", "partially_filled", "filled", "cancelled", "rejected", "expired"],
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
    orderIntentUnique: uniqueIndex("idx_execution_task_order_intent_unique").on(
      table.orderIntentId
    ),
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
  mode: text("mode", { enum: ["mock", "sandbox", "live"] })
    .notNull()
    .default("mock"),
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

/**
 * Connector 子系统 audit 表（BaseConnector 的 init / healthcheck / execute /
 * shutdown 4 阶段生命周期事件落点）。
 *
 * 历史：
 *   - migration 0051 引入
 *   - migration 0069（C5-2）误删 —— 当时只看"前端 0 消费 + ACP-hook 写入路径下线"，
 *     没识别出 `src/connectors/`（data / memory / risk / execution / backtest /
 *     research / simulation 七类）这套活跃子系统的 audit 需求并未消失，只是
 *     原来绕 ACP 挂的 hook 在 V2 失效了
 *   - migration 0072 恢复（去掉了原来 dangling 的 `acp_call_id` FK，因为
 *     acp_call 已被 0070 删除）
 *
 * 当前状态：**表已建好但暂无写入路径**。未来给 BaseConnector 加 audit hook 时
 * 直接写本表（独立任务，不在本次 schema 收敛范围内）。
 */
export const connectorCallLog = sqliteTable(
  "connector_call_log",
  {
    id: id(),
    connectorInstanceId: text("connector_instance_id").references(() => connectorInstance.id),
    connectorName: text("connector_name").notNull().default(""),
    workflowRunId: text("workflow_run_id").references(() => workflowRun.id),
    traceId: text("trace_id").notNull(),
    operation: text("operation", {
      enum: ["init", "healthcheck", "execute", "shutdown"],
    }).notNull(),
    requestJson: text("request_json", { mode: "json" }).notNull(),
    responseJson: text("response_json", { mode: "json" }),
    latencyMs: integer("latency_ms").notNull(),
    status: text("status", { enum: ["success", "error", "timeout"] }).notNull(),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_connector_call_log_workflow_created").on(t.workflowRunId, t.createdAt),
    index("idx_connector_call_log_instance_created").on(t.connectorInstanceId, t.createdAt),
  ]
);

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
  definitionId: text("definition_id").references(() => agentDefinition.id, {
    onDelete: "set null",
  }),
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
  definitionId: text("definition_id").references(() => agentDefinition.id, {
    onDelete: "set null",
  }),
  memoryType: text("memory_type", {
    enum: ["factor_archive", "regime", "playbook", "postmortem", "execution_profile"],
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
  connectorInstanceId: text("connector_instance_id").references(() => connectorInstance.id),
  configRef: text("config_ref").notNull().default(""),
  fallbackToNative: integer("fallback_to_native", { mode: "boolean" }).notNull().default(true),
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

// ─── V2 多信号融合域（MSA） ───────────────────────────────────────────────────
//
// 历史角色字典 `agent_role_catalog` 已在 migration 0068 删除 ——
// 22 行内容运行时永不变更，已固化为 `src/runtime/seed-agent-roles.ts` 常量；
// `GET /api/v1/analyst/roles` 端点改为返回该常量。

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
  riskRulesTriggeredJson: text("risk_rules_triggered_json", { mode: "json" })
    .notNull()
    .default("[]"),
  severity: text("severity", { enum: ["warning", "block", "critical"] })
    .notNull()
    .default("block"),
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
  status: text("status", { enum: ["open", "ack", "resolved"] })
    .notNull()
    .default("open"),
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

/**
 * 自研 ReAct GraphState snapshot（替代原 LangGraph checkpointer）。
 * 节点边界写一行；resume 时按 workflowRunId 取最近一份还原运行态。
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
  /** 产物 lineage（migration 0080）：同 factor_definition 协议 */
  createdBy: text("created_by").notNull().default("user"),
  workflowRunId: text("workflow_run_id"),
  agentInstanceId: text("agent_instance_id"),
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
  /**
   * 组合显示用元信息（migration 0080）：UI 上展示 / 搜索用。
   *   - name：用户可读名（空 → UI 回退到 `kind#<id前缀>`）
   *   - description：自由文本说明（克隆自 X / Agent Y 推荐 etc.）
   */
  name: text("name").notNull().default(""),
  description: text("description").notNull().default(""),
  /** 产物 lineage（migration 0080）：同 factor_definition 协议 + 克隆链路 */
  createdBy: text("created_by").notNull().default("user"),
  workflowRunId: text("workflow_run_id"),
  agentInstanceId: text("agent_instance_id"),
  /** 克隆来源：被 clone API 创建时记录父 composition.id */
  parentCompositionId: text("parent_composition_id"),
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
  /** 产物 lineage（migration 0080）：同 factor_definition 协议 */
  createdBy: text("created_by").notNull().default("user"),
  agentInstanceId: text("agent_instance_id"),
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
    definitionId: text("definition_id").references(() => agentDefinition.id, {
      onDelete: "set null",
    }),
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
    /** Self-Evolving Agent P4b：30 天滚动 PnL 汇总，PnlAttributor 每次跑覆盖。
     * 结构 {windowDays, pnlSum, winCount, loseCount, lastUpdatedAt}。 */
    pnlAttributionJson: text("pnl_attribution_json").notNull().default("{}"),
    /**
     * W2（2026-06-11）：skill 显式声明它推荐使用的工具白名单。JSON 字符串数组，
     * 例如 `["factor.register","factor.compute","qubit-data/fetch_klines"]`。
     *
     * 用于 auto-skill-execution-hook 在工具调用成功后做"该 skill 是否被采纳"的精确判定，
     * 取代旧版基于 bodyMd 的 substring 匹配（容易把通用步骤 skill 全命中 / 漏掉重命名工具）。
     * 兼容：若该列为空数组，hook 会退回到子串匹配，保证旧 skill 仍可被自动标记 executed。
     */
    recommendedToolsJson: text("recommended_tools_json").notNull().default("[]"),
    /** P5 SkillPromoter 留位（P4b 不写，避免每期 alter 表）。 */
    lastPromotedAt: text("last_promoted_at"),
    /** 'manual' | 'auto'，P6/P9 用 */
    evolutionMode: text("evolution_mode").notNull().default("manual"),
    /** Self-Evolving Agent P5：这个 skill 是哪一次 promoter run 写的；nullable —
     * user_authored / pre-P5 自动写的 skill 不写值。不打 FK：删 run 不应级联删 skill。 */
    promotionRunId: text("promotion_run_id"),
    /** P5：promoter 评分 0~1，按规则加权（recall/success/pnl/diversity）。nullable。 */
    promotionScore: real("promotion_score"),
    /** P5：user approve / reject 时间；前端列表按 state + 该字段排序。 */
    promotionReviewAt: text("promotion_review_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("idx_agent_skill_project_name").on(t.projectId, t.name),
    index("idx_agent_skill_project_state").on(t.projectId, t.state, t.lastUsedAt),
    index("idx_agent_skill_definition").on(t.definitionId, t.state),
    index("idx_agent_skill_parent").on(t.parentSkillId),
    index("idx_agent_skill_promotion_run").on(t.projectId, t.state, t.promotionRunId),
    index("idx_agent_skill_promotion_score").on(t.projectId, t.state, t.promotionScore),
  ]
);

export const agentSkillRun = sqliteTable(
  "agent_skill_run",
  {
    id: id(),
    skillId: text("skill_id")
      .notNull()
      .references(() => agentSkill.id, { onDelete: "cascade" }),
    workflowRunId: text("workflow_run_id").references(() => workflowRun.id, {
      onDelete: "set null",
    }),
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
    /** Self-Evolving Agent P4b：单次 skill 执行分到的 PnL（v0 等权 PnL/K）。
     * nullable —— 没归因的 run（P4b 前的 / 无 PnL 上下文的）不写值，reader 用 IS NOT NULL 过滤。 */
    pnlDelta: real("pnl_delta"),
    /** 归因置信度。v0 等权恒为 1.0；P4b+ 时 Shapley 时小于 1。nullable 同上。 */
    attributionConfidence: real("attribution_confidence"),
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
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
    mode: text("mode", { enum: ["dry_run", "live"] })
      .notNull()
      .default("dry_run"),
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
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [index("idx_skill_curator_run_project").on(t.projectId, t.startedAt)]
);

/**
 * Self-Evolving Agent P5 — SkillPromoter 跑批记录。
 *
 * 一次 cron / 手动触发的扫描产出，summary + 候选明细。生产策略不下放到这里 ——
 * worker 模块自己决定哪些规则触发；本表只是结果存证 + 前端展示 + 故障复盘。
 */
export const skillPromotionRun = sqliteTable(
  "skill_promotion_run",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: ["dry_run", "live"] })
      .notNull()
      .default("dry_run"),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    triggeredBy: text("triggered_by").notNull().default("cron"),
    totalScanned: integer("total_scanned").notNull().default(0),
    totalQualified: integer("total_qualified").notNull().default(0),
    totalPromoted: integer("total_promoted").notNull().default(0),
    totalSkippedDuplicate: integer("total_skipped_duplicate").notNull().default(0),
    totalSkippedInsufficient: integer("total_skipped_insufficient").notNull().default(0),
    /** [{candidateKind, candidateId, signature, score, ruleHits, ...}, ...]，上限 200 条 */
    actionsJson: text("actions_json", { mode: "json" }).notNull().default("[]"),
    elapsedMs: integer("elapsed_ms").notNull().default(0),
    errorMessage: text("error_message"),
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [
    index("idx_skill_promotion_run_project").on(t.projectId, t.startedAt),
    index("idx_skill_promotion_run_status").on(t.status, t.startedAt),
  ]
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
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
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
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    finishedAt: text("finished_at"),
    /** "user" / "bootstrap" / "connector_init" / "test" */
    triggeredBy: text("triggered_by").notNull().default("user"),
  },
  (t) => [
    index("idx_env_install_log_kind_pkg_started").on(t.kind, t.packageName, t.startedAt),
    index("idx_env_install_log_status_started").on(t.status, t.startedAt),
  ]
);

// ─── Memory V2 · P0（experience 统一经验体）───────────────────────────────
// 详见 docs/MEMORY_V2_DESIGN.md §4：
//
// 这 4 张新表是 Memory V2 的"地基"。它们与旧 session_memory / midterm_memory
// /longterm_memory / memory_link 并存，由 P1 阶段的 Writer/Extractor/Reflector/
// Janitor/Recall 5 个 pipe 真正驱动读写；P0 阶段仅落表 + 类型 + Store/Bus 边界，
// 业务路径不切换、不破坏。
//
// 设计取舍（已与用户对齐）：
//   1. 物理新表（非 view）—— 一次性迁移、查询简洁；
//   2. 失败必反思 + 预算上限 + 签名去重 —— 由 reflection_run 持久化；
//   3. P1 仅关键词 + JSON path 召回，P2 才接 embedding；embedding_ref 字段先留空；
//   4. semantic 共享 / reflective 隔离 —— 用 visibility 字段表达，集中在 Recall 路由。

/**
 * Experience（统一经验体）
 *
 * 五种 kind：
 *   - episodic    一次工作流的事件流水（取代 session_memory）
 *   - semantic    关于世界/项目/标的的事实、规则（默认 project_shared）
 *   - procedural  可复用流程（与 agent_skill 同义；P2 收敛）
 *   - reflective  关于自己的反思：失败模式 / 偏好 / 校准（默认 agent_private）
 *   - identity    持久画像、persona、user.md 提炼
 *
 * subKind 是自由 string（取代旧 memoryType 硬编码 enum），常见值：
 *   factor_archive / regime / playbook / postmortem / execution_profile
 *   strategy_iteration / risk_review / simulation_note / param_scan
 *   failure_mode / fact / preference / persona / iteration_summary
 *
 * visibility 决定召回路由：
 *   - agent_private    仅 definitionId 自己可见 —— reflective 强制
 *   - role_shared      同 role 共享（按 agent_definition.role 比对）
 *   - project_shared   同 project 内所有 agent 可见 —— semantic / procedural 默认
 */
export const experience = sqliteTable(
  "experience",
  {
    id: id(),
    kind: text("kind", {
      enum: ["episodic", "semantic", "procedural", "reflective", "identity"],
    }).notNull(),
    /** 自由分类（取代旧 memoryType enum） */
    subKind: text("sub_kind").notNull().default(""),
    scope: text("scope", {
      enum: ["org", "workspace", "project", "strategy", "workflow"],
    }).notNull(),
    /** scopeId 对应：workflow→workflowRunId / project→projectId 等 */
    scopeId: text("scope_id").notNull(),
    /** 产生者；reflective 必填，semantic 可空（表示"项目共有"） */
    definitionId: text("definition_id").references(() => agentDefinition.id, {
      onDelete: "set null",
    }),
    visibility: text("visibility", {
      enum: ["agent_private", "role_shared", "project_shared"],
    })
      .notNull()
      .default("project_shared"),
    /** {summary, body, ...} — body 大字段也放这；不再生成额外的 markdown 镜像文件 */
    contentJson: text("content_json", { mode: "json" }).notNull(),
    /** 自由 string[] 用于过滤检索 */
    tagsJson: text("tags_json", { mode: "json" }).notNull().default("[]"),
    /** 0~1；Janitor nightly 重算（见 quality.ts） */
    qualityScore: real("quality_score").notNull().default(0.5),
    useCount: integer("use_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    /** 软归档触发时间；null 表示永不（pinned / identity） */
    decayAt: text("decay_at"),
    validFrom: text("valid_from").notNull(),
    /** 被新版本取代时填，软删 */
    validTo: text("valid_to"),
    /** evolve / consolidate 谱系 */
    parentId: text("parent_id"),
    /** 哪次 workflow 产生 */
    sourceRunId: text("source_run_id").references(() => workflowRun.id, {
      onDelete: "set null",
    }),
    /** P2 接 embedding 时回填；P1 一律 null */
    embeddingRef: text("embedding_ref"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    metadataJson: text("metadata_json", { mode: "json" }).notNull().default("{}"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_experience_scope_kind_quality").on(t.scope, t.scopeId, t.kind, t.qualityScore),
    index("idx_experience_def_kind_validfrom").on(t.definitionId, t.kind, t.validFrom),
    index("idx_experience_kind_subkind").on(t.kind, t.subKind),
    index("idx_experience_decay").on(t.decayAt),
    index("idx_experience_parent").on(t.parentId),
  ]
);

/**
 * Experience 之间的关系图（取代死表 memory_link，并由 Extractor / Reflector
 * 在 P1 真正写入）。
 */
export const experienceLink = sqliteTable(
  "experience_link",
  {
    id: id(),
    fromId: text("from_id")
      .notNull()
      .references(() => experience.id, { onDelete: "cascade" }),
    toId: text("to_id")
      .notNull()
      .references(() => experience.id, { onDelete: "cascade" }),
    relation: text("relation", {
      enum: ["derive_from", "summarize_to", "evidence_of", "conflicts_with", "supersedes"],
    }).notNull(),
    weight: real("weight").notNull().default(1.0),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_experience_link_from_rel").on(t.fromId, t.relation),
    index("idx_experience_link_to_rel").on(t.toId, t.relation),
    uniqueIndex("idx_experience_link_unique").on(t.fromId, t.toId, t.relation),
  ]
);

/**
 * 反思执行留痕。
 *
 * Reflector 的 3 个跳过分支也写一行（status=skipped_*），便于回答"我们今天到底
 * 有多少失败被反思了、多少被预算/去重挡掉了"。
 */
export const reflectionRun = sqliteTable(
  "reflection_run",
  {
    id: id(),
    scope: text("scope", {
      enum: ["workflow_completed", "workflow_failed", "daily", "manual"],
    }).notNull(),
    /** 反思对象；workflow_* 时为 workflowRunId */
    subjectRunId: text("subject_run_id").references(() => workflowRun.id, {
      onDelete: "set null",
    }),
    /** 仅 workflow_failed 有；用于 24h 去重 */
    failureSignature: text("failure_signature"),
    /** 产生 reflective 的归属 agent（隔离写入） */
    definitionId: text("definition_id").references(() => agentDefinition.id, {
      onDelete: "set null",
    }),
    status: text("status", {
      enum: ["running", "completed", "skipped_dedup", "skipped_budget", "sampled_out", "failed"],
    }).notNull(),
    budgetTokensUsed: integer("budget_tokens_used").notNull().default(0),
    /** 反思产出的 experience id 列表（含 reflective 与 semantic） */
    producedExperienceIdsJson: text("produced_experience_ids_json", { mode: "json" })
      .notNull()
      .default("[]"),
    errorMessage: text("error_message"),
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [
    index("idx_reflection_run_signature").on(t.failureSignature, t.startedAt),
    index("idx_reflection_run_status_started").on(t.status, t.startedAt),
    index("idx_reflection_run_subject").on(t.subjectRunId),
  ]
);

/**
 * Experience 全生命周期审计 —— 写入 / 召回 / 执行 / 衰减 / 归档 / 晋升。
 *
 * 与 skill_recall_log 的关系：P1 阶段并存；P2 用本表替代（带 kind 维度）。
 */
export const experienceOpLog = sqliteTable(
  "experience_op_log",
  {
    id: id(),
    experienceId: text("experience_id")
      .notNull()
      .references(() => experience.id, { onDelete: "cascade" }),
    op: text("op", {
      enum: ["create", "update", "recall", "execute", "decay", "archive", "promote"],
    }).notNull(),
    /** recall / execute 时填 */
    workflowRunId: text("workflow_run_id").references(() => workflowRun.id, {
      onDelete: "set null",
    }),
    /** execute 时填，驱动 qualityScore 计算 */
    outcome: text("outcome", {
      enum: ["success", "fail", "partial", "unknown"],
    }),
    /** "extractor" / "reflector" / "reason" / "janitor" / "user" 等 */
    actor: text("actor").notNull().default("system"),
    metadataJson: text("metadata_json", { mode: "json" }).notNull().default("{}"),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_experience_op_log_exp_created").on(t.experienceId, t.createdAt),
    index("idx_experience_op_log_workflow_op").on(t.workflowRunId, t.op),
    index("idx_experience_op_log_op_created").on(t.op, t.createdAt),
  ]
);

// ─── Self-Evolving Agent P4a — PnL Infrastructure ───────────────────────────
// 见 docs/SELF_EVOLVING_AGENT_DESIGN.md §P4a。3 张表为飞轮"PnL 反馈环"打底，
// P4b 的 PnlAttributor worker 读 fill / execution_report → join daily_mark_price →
// 估 fee_schedule → 写 strategy_pnl_snapshot。

/**
 * EOD 收盘价物化表。让 PnL 跑批与 broker connector 解耦：DailyMarkPriceFetcher
 * 在交易日结束后一次性从 klines connector 拉所有持仓 symbol，PnlAttributor 只读本表。
 */
export const dailyMarkPrice = sqliteTable(
  "daily_mark_price",
  {
    id: id(),
    /** CN | US | HK | CRYPTO，与 trading_account.market_scope / strategy_runtime.market 对齐 */
    market: text("market").notNull(),
    symbol: text("symbol").notNull(),
    /** ISO date 'YYYY-MM-DD'（按 market 本地交易日） */
    tradingDay: text("trading_day").notNull(),
    close: real("close").notNull(),
    open: real("open"),
    high: real("high"),
    low: real("low"),
    volume: real("volume"),
    /** klines data source meta：'eastmoney' / 'yfinance' / 'yahoo_chart' / 'tushare_daily' / 'akshare' / 'binance_crypto' / 'synthetic' */
    source: text("source").notNull(),
    fetchedAt: text("fetched_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("idx_daily_mark_price_unique").on(t.market, t.symbol, t.tradingDay),
    index("idx_daily_mark_price_symbol_day").on(t.symbol, t.tradingDay),
  ]
);

/**
 * 时序日度 PnL 快照（runtime × symbol × day）。
 *
 * 注意：和 `strategy_position_snapshot` 是不同物种：
 *   - strategy_position_snapshot：(runtime, symbol) 唯一行，只存"当前"持仓与买入价
 *   - strategy_pnl_snapshot：(runtime, day, symbol) 时序，含 realized/unrealized/cum/fee/turnover
 *
 * 由 PnlAttributor worker upsert；source 字段记录算法版本（"pnl_attributor_v0" 等权归因）。
 */
export const strategyPnlSnapshot = sqliteTable(
  "strategy_pnl_snapshot",
  {
    id: id(),
    strategyRuntimeId: text("strategy_runtime_id")
      .notNull()
      .references(() => strategyRuntime.id, { onDelete: "cascade" }),
    /** ISO date 'YYYY-MM-DD' */
    tradingDay: text("trading_day").notNull(),
    symbol: text("symbol").notNull(),
    /** 当日收盘持仓数量（含未平仓） */
    qty: real("qty").notNull().default(0),
    /** 移动平均成本（FIFO 简化）；qty=0 时为 null */
    avgCost: real("avg_cost"),
    /** 当日 mark：取 daily_mark_price.close；查不到时由 last_fill.fill_price 回退 */
    markPrice: real("mark_price"),
    marketValue: real("market_value").notNull().default(0),
    realizedPnlDaily: real("realized_pnl_daily").notNull().default(0),
    unrealizedPnlDaily: real("unrealized_pnl_daily").notNull().default(0),
    realizedPnlCum: real("realized_pnl_cum").notNull().default(0),
    unrealizedPnlCum: real("unrealized_pnl_cum").notNull().default(0),
    feeDaily: real("fee_daily").notNull().default(0),
    feeCum: real("fee_cum").notNull().default(0),
    turnoverDaily: real("turnover_daily").notNull().default(0),
    /** 'pnl_attributor_v0' / 'pnl_attributor_v1' */
    source: text("source").notNull(),
    /** mark_source / partial_data_flag / fill_count 等 */
    metadataJson: text("metadata_json", { mode: "json" }).notNull().default("{}"),
    computedAt: text("computed_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("idx_strategy_pnl_snapshot_unique").on(t.strategyRuntimeId, t.tradingDay, t.symbol),
    index("idx_strategy_pnl_snapshot_runtime_day").on(t.strategyRuntimeId, t.tradingDay),
    index("idx_strategy_pnl_snapshot_symbol_day").on(t.symbol, t.tradingDay),
  ]
);

/**
 * 内置费率表。fill.fee 现在全 0，FeeCalculator 按 (broker, market, asset_class, side)
 * 多维匹配本表（priority 越大越优先；'*' 通配 priority=10，精确匹配 priority=100）。
 * 默认 seed 覆盖 CN/US/HK/CRYPTO 主流；'paper' broker 兜底零费率。
 */
export const feeSchedule = sqliteTable(
  "fee_schedule",
  {
    id: id(),
    /** 'paper' | 'futu' | 'ib' | 'ccxt' | '*' 通配 */
    broker: text("broker").notNull(),
    /** 'CN' | 'US' | 'HK' | 'CRYPTO' | '*' */
    market: text("market").notNull(),
    /** 'stock' | 'crypto' | 'future' | 'option' | '*' */
    assetClass: text("asset_class").notNull(),
    /** 'buy' | 'sell' | '*' */
    side: text("side").notNull(),
    commissionRate: real("commission_rate").notNull().default(0),
    commissionMin: real("commission_min").notNull().default(0),
    /** 印花税（CN A 股卖 0.001、HK 0.0013 等） */
    stampDutyRate: real("stamp_duty_rate").notNull().default(0),
    /** 过户费 / SEC fee / TAF 等 */
    transferFeeRate: real("transfer_fee_rate").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** 越大越优先；精确匹配 100，通配 10 */
    priority: integer("priority").notNull().default(0),
    effectiveFrom: text("effective_from").notNull(),
    /** null = 一直有效 */
    effectiveTo: text("effective_to"),
    metadataJson: text("metadata_json", { mode: "json" }).notNull().default("{}"),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_fee_schedule_match").on(
      t.broker,
      t.market,
      t.assetClass,
      t.side,
      t.enabled,
      t.priority
    ),
  ]
);

// ─── Self-Evolving Agent P4b — PnL Attribution ─────────────────────────────
// 见 docs/SELF_EVOLVING_AGENT_DESIGN.md §P4b。新表把 strategy_pnl_snapshot 进一步
// 归因到 (workflow_run, agent_definition, skill[]) 维度。一行 = 一次 workflow_run
// 在一个交易日产生的 PnL 归因结果。

/**
 * Agent + Skill 维度的 PnL 归因明细。
 * 一行 = (workflow_run, definition, as_of_date) 唯一；skill 多个走 skill_ids_json + per_skill_share。
 * 由 PnlAttributor worker 写入；upsert 唯一键见 idx_agent_pnl_attr_unique。
 */
export const agentPnlAttribution = sqliteTable(
  "agent_pnl_attribution",
  {
    id: id(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRun.id, { onDelete: "cascade" }),
    /** Nullable —— strategyRuntime 反查 workflow_run 可能拿不到 agent（典型：cron 触发的 fill）。 */
    definitionId: text("definition_id").references(() => agentDefinition.id, {
      onDelete: "set null",
    }),
    strategyRuntimeId: text("strategy_runtime_id")
      .notNull()
      .references(() => strategyRuntime.id, { onDelete: "cascade" }),
    /** ISO date 'YYYY-MM-DD'（按 market 本地交易日） */
    asOfDate: text("as_of_date").notNull(),
    /** 归因到该 (run, def, date) 的 PnL（已扣 fee） */
    pnlAttributed: real("pnl_attributed").notNull().default(0),
    /** 该 run 召回执行过的 skill_id 列表（JSON string[]）；可为空数组 */
    skillIdsJson: text("skill_ids_json").notNull().default("[]"),
    /** pnl_attributed / max(1, len(skill_ids_json))；冗余给 reader */
    perSkillShare: real("per_skill_share").notNull().default(0),
    /** 'equal_weight_v0' / 'time_decay_v1' / 'shapley_v2' */
    attributionMethod: text("attribution_method").notNull().default("equal_weight_v0"),
    /** v0 恒为 1.0；Shapley 时小于 1 */
    attributionConfidence: real("attribution_confidence").notNull().default(1.0),
    metadataJson: text("metadata_json", { mode: "json" }).notNull().default({}),
    computedAt: text("computed_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("idx_agent_pnl_attr_unique").on(t.workflowRunId, t.definitionId, t.asOfDate),
    index("idx_agent_pnl_attr_runtime_date").on(t.strategyRuntimeId, t.asOfDate),
    index("idx_agent_pnl_attr_def_date").on(t.definitionId, t.asOfDate),
  ]
);

// ───────────────────────── Self-Evolving Agent P7 — ToolGapWatcher ─────────────────────────
// 详见 docs/SELF_EVOLVING_AGENT_DESIGN.md §6.5
// migration: 0063_self_evolve_p7_tool_gap.sql

export const toolGapLog = sqliteTable(
  "tool_gap_log",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    workflowRunId: text("workflow_run_id"),
    definitionId: text("definition_id"),
    detectionKind: text("detection_kind", {
      enum: ["unknown_tool", "repeated_fail", "reflective_mention", "explicit_report"],
    }).notNull(),
    /** 'tool:get_weather' / 'mcp:slack/post_message' / 'concept:realtime_options_chain' */
    gapSignature: text("gap_signature").notNull(),
    requestedToolName: text("requested_tool_name"),
    requestedToolKind: text("requested_tool_kind"),
    excerpt: text("excerpt"),
    sourceToolCallId: text("source_tool_call_id"),
    sourceExperienceId: text("source_experience_id"),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeenAt: text("first_seen_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    lastSeenAt: text("last_seen_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    status: text("status", {
      enum: ["open", "proposed", "installed", "wont_fix", "rejected"],
    })
      .notNull()
      .default("open"),
    statusAt: text("status_at"),
    statusBy: text("status_by"),
    statusReason: text("status_reason"),
    metadataJson: text("metadata_json", { mode: "json" }).notNull().default({}),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("idx_tool_gap_log_project_status").on(t.projectId, t.status, t.lastSeenAt),
    index("idx_tool_gap_log_kind").on(t.projectId, t.detectionKind, t.lastSeenAt),
    // 注：partial unique index `idx_tool_gap_log_dedup_open` (status='open') 由 SQL migration
    // 直接创建；drizzle ORM 不支持 WHERE 子句，这里不再声明，避免生成器尝试 drop。
  ]
);

export const toolGapRun = sqliteTable(
  "tool_gap_run",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    triggeredBy: text("triggered_by").notNull().default("cron"),
    fromTs: text("from_ts"),
    toTs: text("to_ts"),
    unknownToolCount: integer("unknown_tool_count").notNull().default(0),
    repeatedFailCount: integer("repeated_fail_count").notNull().default(0),
    reflectiveMentionCount: integer("reflective_mention_count").notNull().default(0),
    totalSignals: integer("total_signals").notNull().default(0),
    gapsCreated: integer("gaps_created").notNull().default(0),
    gapsIncremented: integer("gaps_incremented").notNull().default(0),
    gapsSkipped: integer("gaps_skipped").notNull().default(0),
    actionsJson: text("actions_json", { mode: "json" }).notNull().default("[]"),
    elapsedMs: integer("elapsed_ms").notNull().default(0),
    errorMessage: text("error_message"),
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [index("idx_tool_gap_run_project").on(t.projectId, t.startedAt)]
);

// ───────────────────────── Self-Evolving Agent P8 — AutoInstaller propose 模式 ─────────────────────────
// 详见 docs/SELF_EVOLVING_AGENT_DESIGN.md §6.6
// migration: 0065_self_evolve_p8_auto_installer.sql

export const autoInstallProposal = sqliteTable(
  "auto_install_proposal",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** 关联 tool_gap_log.id；不打 FK 以容忍 gap 软删 */
    gapLogId: text("gap_log_id").notNull(),
    proposalKind: text("proposal_kind", {
      enum: ["install_mcp_catalog", "install_mcp_external", "no_candidate"],
    }).notNull(),
    safetyLevel: text("safety_level", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    matchScore: real("match_score").notNull().default(0),
    /**
     * 'mcp_catalog' | null（no_candidate 时为 null）
     *
     * Schema 收敛 C4（migration 0071）后：合表只有 mcp_catalog 一张表，新写入恒为
     * 'mcp_catalog'；历史行可能仍有 'mcp_catalog_item' 字面值，前端按 proposal_kind
     * 区分 install_mcp_catalog vs install_mcp_external 即可。
     */
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    targetSlug: text("target_slug"),
    /** propose 时的不可变快照，避免 catalog 后续被改 */
    payloadJson: text("payload_json", { mode: "json" }).notNull().default({}),
    /** top-3 候选明细（含 score / ruleHits / slug） */
    candidatesJson: text("candidates_json", { mode: "json" }).notNull().default("[]"),
    state: text("state", {
      enum: ["pending_review", "approved", "rejected", "no_candidate"],
    })
      .notNull()
      .default("pending_review"),
    stateAt: text("state_at"),
    stateBy: text("state_by"),
    stateReason: text("state_reason"),
    proposerRunId: text("proposer_run_id"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("idx_auto_install_proposal_project_state").on(t.projectId, t.state, t.createdAt),
    index("idx_auto_install_proposal_gap").on(t.gapLogId, t.createdAt),
    // partial unique `idx_auto_install_proposal_gap_pending` (state='pending_review') 由 SQL migration
    // 直接创建；drizzle ORM 不支持 WHERE 子句，此处不声明避免 generator 误 drop。
  ]
);

export const autoInstallerRun = sqliteTable(
  "auto_installer_run",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    triggeredBy: text("triggered_by").notNull().default("cron"),
    gapsScanned: integer("gaps_scanned").notNull().default(0),
    proposalsCreated: integer("proposals_created").notNull().default(0),
    proposalsSkippedExisting: integer("proposals_skipped_existing").notNull().default(0),
    proposalsNoCandidate: integer("proposals_no_candidate").notNull().default(0),
    actionsJson: text("actions_json", { mode: "json" }).notNull().default("[]"),
    elapsedMs: integer("elapsed_ms").notNull().default(0),
    errorMessage: text("error_message"),
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [index("idx_auto_installer_run_project").on(t.projectId, t.startedAt)]
);
