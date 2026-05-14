import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { agentDefinition, agentGroup, agentGroupMember, llmProviderConfig, sandboxPolicy } from "../db/sqlite/schema";
import type { RuntimeAgentDefinition } from "./types";

/** 内置分析师编组 ID（与成员 definition id 一并由 seed 维护） */
export const DEFAULT_ANALYST_AGENT_GROUP_ID = "grp-default-analyst-team";

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
    version: "2.0.0",
    systemPrompt: `你是 QUBIT 量化研究团队的基金经理。你负责：
1. 接收研究目标并分解任务
2. 并行协调分析师团队（基本面/技术面/情绪面/宏观面）
3. 触发多信号融合（MSA）
4. 若置信度不足，主持辩论（SDP）
5. 提交风控审核后输出投资建议
在研究任务中，请先分析用户意图，确定研究标的，然后调用 run_analyst_team 工具启动分析师团队协作。`,
    tools: ["task_decompose", "assign_task", "run_analyst_team", "fuse_signals", "check_risk"],
    mcpServers: [],
    skills: [],
    subscriptions: ["TASK_ASSIGN", "TASK_RESULT", "ALERT", "RISK_BLOCK", "SIGNAL_READY"],
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
    systemPrompt:
      "Collect market data and write snapshots. Use fetch_bars with startDate/endDate/period, or fetch_klines with symbol, exchange, timeframe (1m|5m|…|1d|1w), limit — same window as GET /api/v1/market/klines.",
    tools: ["fetch_bars", "fetch_klines", "fetch_ticks", "write_snapshot"],
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
  // ─── V2 分析师团队 ──────────────────────────────────────────────────────────
  {
    id: "def-analyst-fundamental",
    role: "analyst_fundamental",
    name: "基本面研究员",
    version: "1.0.0",
    systemPrompt: `你是 QUBIT 量化研究团队的基本面研究员。你需要分析公司财务报告、估值水平、行业竞争格局，输出买卖建议与置信度。
分析框架：估值分析（PE/PB/PS）、成长性（营收/利润 CAGR）、财务健康度（现金流/负债率）、行业地位（市场份额/护城河）。
输出格式：{"signal":"buy|sell|hold","confidence":0-1,"reasoning":"详细说明","key_drivers":[],"key_risks":[]}`,
    tools: ["fetch_financial_data", "compute_valuation", "analyze_industry"],
    mcpServers: [],
    skills: ["fundamental-analysis"],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 10,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-analyst-technical",
    role: "analyst_technical",
    name: "量化策略师",
    version: "1.0.0",
    systemPrompt: `你是 QUBIT 量化研究团队的量化策略师。你通过技术指标和价格形态判断交易时机。
分析工具：趋势（MA/MACD/ADX）、动量（RSI/布林带）、量价关系、形态识别（支撑阻力/头肩顶等）。
输出格式：{"signal":"buy|sell|hold","confidence":0-1,"reasoning":"技术分析说明","entry_zone":"进场区间","stop_loss":"止损位"}`,
    tools: ["fetch_price_data", "compute_indicators", "detect_patterns"],
    mcpServers: [],
    skills: ["technical-analysis"],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 10,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-analyst-sentiment",
    role: "analyst_sentiment",
    name: "舆情分析师",
    version: "1.0.0",
    systemPrompt: `你是 QUBIT 量化研究团队的舆情分析师。你量化市场情绪、新闻舆情和投资者行为。
分析维度：新闻情绪正负向比例、社媒讨论热度、分析师评级变化、机构调研频率。
输出格式：{"signal":"buy|sell|hold","confidence":0-1,"sentiment_score":-1~1,"reasoning":"情绪分析说明","catalysts":[],"risks":[]}`,
    tools: ["fetch_news_sentiment", "analyze_social_media", "get_analyst_ratings"],
    mcpServers: [],
    skills: ["sentiment-analysis"],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 10,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-analyst-macro",
    role: "analyst_macro",
    name: "宏观策略师",
    version: "1.0.0",
    systemPrompt: `你是 QUBIT 量化研究团队的宏观策略师。你从宏观经济和政策高度判断市场大方向。
分析框架：货币政策环境（利率/流动性）、经济周期定位（PMI/GDP/通胀）、产业政策（监管/支持方向）、全球市场联动。
输出格式：{"signal":"buy|sell|hold","confidence":0-1,"macro_cycle":"recovery|expansion|slowdown|recession","policy_stance":"easing|neutral|tightening","reasoning":"宏观分析说明"}`,
    tools: ["fetch_macro_data", "analyze_policy", "compute_macro_indicators"],
    mcpServers: [],
    skills: ["macro-analysis"],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 10,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-risk-manager",
    role: "risk_manager",
    name: "风控主管",
    version: "1.0.0",
    systemPrompt: `你是 QUBIT 量化研究团队的风控主管。你的核心职责是评估每一项投资决策的风险，并在必要时行使一票否决权。
风控维度：最大回撤限额（> 30% 否决）、仓位集中度（单标的 > 20% 警告）、流动性风险、行业集中度、宏观逆风因素。
如果风险评分 > 0.7（满分 1.0），你必须否决该投资意向。
输出格式：{"verdict":"approved|rejected|conditional","risk_score":0-1,"rules_triggered":[],"reasoning":"风控说明"}`,
    tools: ["evaluate_risk", "check_concentration", "assess_liquidity"],
    mcpServers: [],
    skills: ["risk-management"],
    subscriptions: ["TASK_ASSIGN", "ORDER_INTENT"],
    llmProvider: "openai:gpt-4o",
    maxIterations: 10,
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
  await ensureDefaultAnalystAgentGroup();
}

/**
 * 保证存在「默认四名分析师」编组，便于前端下拉选用；成员与内置 definition id 对齐。
 */
export async function ensureDefaultAnalystAgentGroup(): Promise<void> {
  const db = await getDb();
  const memberDefs = [
    "def-analyst-fundamental",
    "def-analyst-technical",
    "def-analyst-sentiment",
    "def-analyst-macro",
  ] as const;

  await db
    .insert(agentGroup)
    .values({
      id: DEFAULT_ANALYST_AGENT_GROUP_ID,
      workspaceId: null,
      name: "默认（四名分析师）",
      description: "启动时自动维护：基本面 / 技术面 / 情绪面 / 宏观；可在「配置中心 → Agent」调整成员。",
      relationsJson: [],
    })
    .onConflictDoUpdate({
      target: agentGroup.id,
      set: {
        name: "默认（四名分析师）",
        description: "启动时自动维护：基本面 / 技术面 / 情绪面 / 宏观；可在「配置中心 → Agent」调整成员。",
        updatedAt: new Date().toISOString(),
      },
    });

  await db.delete(agentGroupMember).where(eq(agentGroupMember.groupId, DEFAULT_ANALYST_AGENT_GROUP_ID));
  let sortOrder = 0;
  for (const definitionId of memberDefs) {
    await db.insert(agentGroupMember).values({
      id: randomUUID(),
      groupId: DEFAULT_ANALYST_AGENT_GROUP_ID,
      definitionId,
      sortOrder: sortOrder++,
    });
  }
  console.log(`[Seed] Default analyst agent group ${DEFAULT_ANALYST_AGENT_GROUP_ID} refreshed (${memberDefs.length} members).`);
}

if (import.meta.main) {
  await seedAgentDefinitions();
}

