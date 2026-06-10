/**
 * 跨场景「全局健康度」聚合器（Round 9 复盘 2026-06-09 新增）。
 *
 * 评测主流程 (run-readiness-evaluation.ts) 跑完一轮 N 个 scenario 后，会拿到
 * N 个 workflowRunId。这里把这 N 个 workflow 在 tool_call_log / mcp_call_log /
 * llm_call_log / skill_recall_log 四张日志表里的痕迹按维度汇总，输出五块健康度
 * 视图，给 health-canvas 渲染、给 dev 排查"上一轮评测里 X 工具集体超时"之类
 * 跨场景问题。
 *
 * 为什么不放进单 workflow 的 grader：
 *   - 单 workflow 的 AQM B/C 指标关注"本场景表现"；跨工作流的聚合关注"整体健康"
 *     （例如某 MCP server 在 8/10 个 workflow 都出现 circuit_open，单 workflow
 *     视角会错过这个 pattern）。
 *   - 聚合视图独立产出可以单独迭代阈值，不破坏 AQM 主指标定义。
 */
/**
 * 最小 sqlite 接口（兼容 bun:sqlite / better-sqlite3 / 测试 mock）：
 * 项目主路径用 bun:sqlite（artifact-checker.test.ts 等已锚定）；
 * 这里只用 prepare+all，定义最小接口避免硬绑实现。
 */
export interface SqliteLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

export interface ToolHealthRow {
  toolName: string;
  toolKind: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  sandboxBlockedCount: number;
  successRate: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  topErrors: Array<{ message: string; count: number }>;
  healthGrade: "green" | "yellow" | "red";
}

export interface McpHealthRow {
  serverName: string;
  totalCalls: number;
  successCount: number;
  timeoutCount: number;
  failedCount: number;
  sandboxBlockedCount: number;
  circuitOpenCount: number;
  avgLatencyMs: number | null;
  transports: string[];
  healthGrade: "green" | "yellow" | "red";
}

export interface LlmCostRow {
  provider: string;
  model: string;
  totalCalls: number;
  successCount: number;
  fallbackCount: number;
  errorCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  avgTokensPerCall: number | null;
  p95TokensPerCall: number | null;
  truncationCount: number;
  truncationRate: number;
}

export interface SkillRecallRow {
  skillId: string;
  recallCount: number;
  executedCount: number;
  executedRate: number;
  avgScore: number | null;
}

export interface ErrorAggRow {
  source: "tool" | "mcp" | "llm";
  pattern: string;
  count: number;
  examples: string[];
}

/**
 * Wave-1（2026-06-10）：MCP 采纳率视图。
 *
 * 用来一眼回答"我配置了这么多 MCP server，agent 真的用了吗"：
 *   - configuredServers：mcp_server_config.enabled=true 且 project 级（projectId IS NULL）的 server 名
 *   - usedServers：本轮 evaluation 在 mcp_call_log 实际出现过的 server 名
 *   - 漏用名 (configured - used) 通常是 prompt 拼装层"劝退过度"或 def.mcp_servers_json
 *     没注入的问题
 */
export interface McpAdoptionRow {
  configuredServers: string[];
  usedServers: string[];
  unusedServers: string[];
  adoptionRate: number;
}

export interface HealthReport {
  generatedAt: string;
  workflowRunIds: string[];
  tools: ToolHealthRow[];
  mcp: McpHealthRow[];
  llm: LlmCostRow[];
  skills: SkillRecallRow[];
  errors: ErrorAggRow[];
  mcpAdoption: McpAdoptionRow;
  summary: {
    totalToolCalls: number;
    totalMcpCalls: number;
    totalLlmCalls: number;
    totalTokens: number;
    totalCostUsd: number;
    redToolCount: number;
    redMcpCount: number;
  };
}

interface ToolRow {
  tool_name: string;
  tool_kind: string;
  status: string;
  latency_ms: number | null;
  error_message: string | null;
}

interface McpRow {
  server_name: string;
  status: string;
  circuit_state: string | null;
  transport: string | null;
  latency_ms: number | null;
  error_code: string | null;
}

interface LlmRow {
  provider: string;
  model: string;
  status: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  finish_reason: string | null;
  cost_usd: number | null;
  error_message: string | null;
}

interface SkillRow {
  skill_id: string;
  score: number | null;
  executed: number;
}

/**
 * Tool 健康度评级：
 *   - 任何 sandbox_blocked → red（产品事故级别）
 *   - 成功率 < 90% → red
 *   - 成功率 < 99% → yellow
 *   - 否则 green
 */
function gradeTool(row: Omit<ToolHealthRow, "healthGrade">): "green" | "yellow" | "red" {
  if (row.sandboxBlockedCount > 0) return "red";
  if (row.totalCalls === 0) return "green";
  if (row.successRate < 0.9) return "red";
  if (row.successRate < 0.99) return "yellow";
  return "green";
}

/**
 * MCP 健康度评级：
 *   - circuit_state=open 出现 → red（熔断 = 服务异常）
 *   - failed/timeout 比例 > 15% → red
 *   - failed/timeout 比例 > 5% → yellow
 *   - 否则 green
 */
function gradeMcp(row: Omit<McpHealthRow, "healthGrade">): "green" | "yellow" | "red" {
  if (row.circuitOpenCount > 0) return "red";
  if (row.sandboxBlockedCount > 0) return "red";
  if (row.totalCalls === 0) return "green";
  const badRate = (row.failedCount + row.timeoutCount) / row.totalCalls;
  if (badRate > 0.15) return "red";
  if (badRate > 0.05) return "yellow";
  return "green";
}

/** 简单 p95（值数组就地排序后取索引）。空数组返回 null。 */
function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, idx)] ?? null;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 归一化错误消息（聚合 top errors 时用）：把动态 token（UUID / 时间戳 / 长 hash /
 * 数字）替换成 `<X>` 占位符，相同模式的错误能 group 起来。
 */
export function normalizeErrorMessage(msg: string): string {
  return msg
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "<UUID>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<TS>")
    .replace(/\b[0-9a-f]{32,}\b/g, "<HASH>")
    .replace(/\b\d{4,}\b/g, "<N>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** SQLite 占位符工具：返回 `(?,?,?...)` 字符串 */
function placeholders(n: number): string {
  return `(${new Array(n).fill("?").join(",")})`;
}

/**
 * 主聚合入口：传入一组 workflow_run_id，对 4 张日志表做 SQL 汇总。
 * 不传或空数组 → 抛错（防御性，避免误把"全库扫"当成"评测范围"）。
 */
export function aggregateHealth(
  sqlite: SqliteLike,
  workflowRunIds: string[]
): HealthReport {
  if (!Array.isArray(workflowRunIds) || workflowRunIds.length === 0) {
    throw new Error(
      "[health-aggregator] workflowRunIds must be non-empty (refuse to scan full DB)"
    );
  }
  const ph = placeholders(workflowRunIds.length);

  // ── Tools (tool_call_log) ─────────────────────────────────────────
  const toolRows = sqlite
    .prepare(
      `SELECT tool_name, tool_kind, status, latency_ms, error_message
       FROM tool_call_log
       WHERE workflow_run_id IN ${ph}`
    )
    .all(...workflowRunIds) as ToolRow[];

  const toolGroups = new Map<string, ToolRow[]>();
  for (const r of toolRows) {
    const key = `${r.tool_kind}::${r.tool_name}`;
    const arr = toolGroups.get(key) ?? [];
    arr.push(r);
    toolGroups.set(key, arr);
  }
  const tools: ToolHealthRow[] = [];
  for (const [key, rows] of toolGroups) {
    const [toolKind, toolName] = key.split("::");
    const total = rows.length;
    const successCount = rows.filter((r) => r.status === "success").length;
    const errorCount = rows.filter((r) => r.status === "error").length;
    const timeoutCount = rows.filter((r) => r.status === "timeout").length;
    const sandboxBlockedCount = rows.filter((r) => r.status === "sandbox_blocked").length;
    const lat = rows
      .map((r) => r.latency_ms)
      .filter((v): v is number => typeof v === "number");

    const errMap = new Map<string, number>();
    for (const r of rows) {
      if (r.error_message) {
        const norm = normalizeErrorMessage(r.error_message);
        errMap.set(norm, (errMap.get(norm) ?? 0) + 1);
      }
    }
    const topErrors = Array.from(errMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([message, count]) => ({ message, count }));

    const baseRow = {
      toolName: toolName ?? key,
      toolKind: toolKind ?? "unknown",
      totalCalls: total,
      successCount,
      errorCount,
      timeoutCount,
      sandboxBlockedCount,
      successRate: total === 0 ? 0 : successCount / total,
      avgLatencyMs: avg(lat),
      p95LatencyMs: p95(lat),
      topErrors,
    };
    tools.push({ ...baseRow, healthGrade: gradeTool(baseRow) });
  }
  tools.sort((a, b) => b.totalCalls - a.totalCalls);

  // ── MCP (mcp_call_log) ────────────────────────────────────────────
  const mcpRows = sqlite
    .prepare(
      `SELECT server_name, status, circuit_state, transport, latency_ms, error_code
       FROM mcp_call_log
       WHERE workflow_run_id IN ${ph}`
    )
    .all(...workflowRunIds) as McpRow[];

  const mcpGroups = new Map<string, McpRow[]>();
  for (const r of mcpRows) {
    const arr = mcpGroups.get(r.server_name) ?? [];
    arr.push(r);
    mcpGroups.set(r.server_name, arr);
  }
  const mcp: McpHealthRow[] = [];
  for (const [serverName, rows] of mcpGroups) {
    const total = rows.length;
    const successCount = rows.filter((r) => r.status === "success").length;
    const timeoutCount = rows.filter((r) => r.status === "timeout").length;
    const failedCount = rows.filter((r) => r.status === "failed").length;
    const sandboxBlockedCount = rows.filter((r) => r.status === "sandbox_blocked").length;
    const circuitOpenCount = rows.filter((r) => r.circuit_state === "open").length;
    const lat = rows
      .map((r) => r.latency_ms)
      .filter((v): v is number => typeof v === "number");
    const transports = Array.from(
      new Set(rows.map((r) => r.transport).filter((v): v is string => !!v))
    );
    const baseRow = {
      serverName,
      totalCalls: total,
      successCount,
      timeoutCount,
      failedCount,
      sandboxBlockedCount,
      circuitOpenCount,
      avgLatencyMs: avg(lat),
      transports,
    };
    mcp.push({ ...baseRow, healthGrade: gradeMcp(baseRow) });
  }
  mcp.sort((a, b) => b.totalCalls - a.totalCalls);

  // ── LLM Cost (llm_call_log) ───────────────────────────────────────
  const llmRows = sqlite
    .prepare(
      `SELECT provider, model, status, prompt_tokens, completion_tokens, total_tokens,
              finish_reason, cost_usd, error_message
       FROM llm_call_log
       WHERE workflow_run_id IN ${ph}`
    )
    .all(...workflowRunIds) as LlmRow[];

  const llmGroups = new Map<string, LlmRow[]>();
  for (const r of llmRows) {
    const key = `${r.provider}::${r.model}`;
    const arr = llmGroups.get(key) ?? [];
    arr.push(r);
    llmGroups.set(key, arr);
  }
  const llm: LlmCostRow[] = [];
  for (const [key, rows] of llmGroups) {
    const [provider, model] = key.split("::");
    const total = rows.length;
    const successCount = rows.filter((r) => r.status === "success").length;
    const fallbackCount = rows.filter((r) => r.status === "fallback").length;
    const errorCount = rows.filter((r) => r.status === "error" || r.status === "timeout").length;
    const promptTokens = rows.reduce((s, r) => s + (r.prompt_tokens ?? 0), 0);
    const completionTokens = rows.reduce((s, r) => s + (r.completion_tokens ?? 0), 0);
    const totalTokens = rows.reduce((s, r) => s + (r.total_tokens ?? 0), 0);
    const totalCostUsd = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
    const perCallTokens = rows
      .map((r) => r.total_tokens)
      .filter((v): v is number => typeof v === "number");
    const truncationCount = rows.filter((r) => r.finish_reason === "length").length;
    llm.push({
      provider: provider ?? "unknown",
      model: model ?? "unknown",
      totalCalls: total,
      successCount,
      fallbackCount,
      errorCount,
      totalPromptTokens: promptTokens,
      totalCompletionTokens: completionTokens,
      totalTokens,
      totalCostUsd,
      avgTokensPerCall: avg(perCallTokens),
      p95TokensPerCall: p95(perCallTokens),
      truncationCount,
      truncationRate: total === 0 ? 0 : truncationCount / total,
    });
  }
  llm.sort((a, b) => b.totalTokens - a.totalTokens);

  // ── Skill Recall (skill_recall_log) ───────────────────────────────
  const skillRows = sqlite
    .prepare(
      `SELECT skill_id, score, executed
       FROM skill_recall_log
       WHERE workflow_run_id IN ${ph}`
    )
    .all(...workflowRunIds) as SkillRow[];

  const skillGroups = new Map<string, SkillRow[]>();
  for (const r of skillRows) {
    const arr = skillGroups.get(r.skill_id) ?? [];
    arr.push(r);
    skillGroups.set(r.skill_id, arr);
  }
  const skills: SkillRecallRow[] = [];
  for (const [skillId, rows] of skillGroups) {
    const recallCount = rows.length;
    const executedCount = rows.filter((r) => r.executed === 1).length;
    const scores = rows
      .map((r) => r.score)
      .filter((v): v is number => typeof v === "number");
    skills.push({
      skillId,
      recallCount,
      executedCount,
      executedRate: recallCount === 0 ? 0 : executedCount / recallCount,
      avgScore: avg(scores),
    });
  }
  skills.sort((a, b) => b.recallCount - a.recallCount);

  // ── Errors（聚合所有 error 来源的 top patterns）─────────────────────
  const errMap = new Map<string, { count: number; examples: string[]; source: "tool" | "mcp" | "llm" }>();
  const bumpErr = (
    raw: string | null | undefined,
    source: "tool" | "mcp" | "llm"
  ) => {
    if (!raw) return;
    const norm = normalizeErrorMessage(raw);
    if (!norm) return;
    const key = `${source}::${norm}`;
    const cur = errMap.get(key);
    if (cur) {
      cur.count += 1;
      if (cur.examples.length < 3 && !cur.examples.includes(raw)) cur.examples.push(raw);
    } else {
      errMap.set(key, { count: 1, examples: [raw], source });
    }
  };
  for (const r of toolRows) {
    if (r.status !== "success") bumpErr(r.error_message, "tool");
  }
  for (const r of mcpRows) {
    if (r.status !== "success") bumpErr(r.error_code, "mcp");
  }
  for (const r of llmRows) {
    if (r.status !== "success" && r.status !== "fallback") bumpErr(r.error_message, "llm");
  }
  const errors: ErrorAggRow[] = Array.from(errMap.entries())
    .map(([key, v]) => {
      const [, pattern] = key.split("::");
      return { source: v.source, pattern: pattern ?? "", count: v.count, examples: v.examples };
    })
    .filter((r) => r.pattern.length > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // ── MCP Adoption（Wave-1）─────────────────────────────────────────
  /**
   * 查全局 enabled 的 MCP server 名（projectId IS NULL）作为 "configured"。
   * 失败 / 表缺失（极端 dev 环境）→ configuredServers 退化为 mcpCallLog 出现过的
   * server 集合，adoptionRate=1.0 兜底，不阻塞主报告生成。
   */
  let configuredServers: string[] = [];
  try {
    const cfgRows = sqlite
      .prepare(
        `SELECT name FROM mcp_server_config WHERE enabled = 1 AND project_id IS NULL`
      )
      .all() as Array<{ name: string }>;
    configuredServers = cfgRows.map((r) => r.name).filter((n): n is string => !!n);
  } catch {
    configuredServers = [...new Set(mcpRows.map((r) => r.server_name))];
  }
  const usedServers = [...new Set(mcpRows.map((r) => r.server_name))].filter(
    (n): n is string => !!n
  );
  const usedSet = new Set(usedServers);
  const unusedServers = configuredServers.filter((n) => !usedSet.has(n));
  const adoptionRate =
    configuredServers.length === 0 ? 0 : usedServers.length / configuredServers.length;

  return {
    generatedAt: new Date().toISOString(),
    workflowRunIds: [...workflowRunIds],
    tools,
    mcp,
    llm,
    skills,
    errors,
    mcpAdoption: {
      configuredServers,
      usedServers,
      unusedServers,
      adoptionRate,
    },
    summary: {
      totalToolCalls: toolRows.length,
      totalMcpCalls: mcpRows.length,
      totalLlmCalls: llmRows.length,
      totalTokens: llm.reduce((s, r) => s + r.totalTokens, 0),
      totalCostUsd: llm.reduce((s, r) => s + r.totalCostUsd, 0),
      redToolCount: tools.filter((r) => r.healthGrade === "red").length,
      redMcpCount: mcp.filter((r) => r.healthGrade === "red").length,
    },
  };
}

/** 渲染 markdown 报告（给非 canvas 用户兜底）。 */
export function renderHealthMarkdown(report: HealthReport, opts?: { roundLabel?: string }): string {
  const lines: string[] = [];
  const round = opts?.roundLabel ?? "agent-readiness";
  lines.push(`# Agent 健康度报告 · ${round}`);
  lines.push("");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 覆盖 workflow：${report.workflowRunIds.length} 个`);
  lines.push(
    `- 总览：tool ${report.summary.totalToolCalls} · mcp ${report.summary.totalMcpCalls} · llm ${report.summary.totalLlmCalls} · token ${(report.summary.totalTokens / 1000).toFixed(0)}k · $${report.summary.totalCostUsd.toFixed(4)}`
  );
  lines.push(
    `- 红灯：tool=${report.summary.redToolCount} · mcp=${report.summary.redMcpCount}`
  );
  lines.push("");

  lines.push("## H-Tools · 工具调用矩阵（按调用次数倒序）");
  lines.push("");
  lines.push("| 健康 | 工具 | kind | 调用 | 成功率 | avg lat | p95 lat | sandbox_blocked | top error |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const t of report.tools) {
    lines.push(
      `| ${gradeIcon(t.healthGrade)} | ${t.toolName} | ${t.toolKind} | ${t.totalCalls} | ${(t.successRate * 100).toFixed(0)}% | ${fmtMs(t.avgLatencyMs)} | ${fmtMs(t.p95LatencyMs)} | ${t.sandboxBlockedCount} | ${t.topErrors[0]?.message ?? "—"} |`
    );
  }
  lines.push("");

  lines.push("## H-MCP · MCP server 健康度");
  lines.push("");
  lines.push(
    "| 健康 | server | 调用 | 成功 | 失败 | 超时 | sandbox | circuit_open | avg lat |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const m of report.mcp) {
    lines.push(
      `| ${gradeIcon(m.healthGrade)} | ${m.serverName} | ${m.totalCalls} | ${m.successCount} | ${m.failedCount} | ${m.timeoutCount} | ${m.sandboxBlockedCount} | ${m.circuitOpenCount} | ${fmtMs(m.avgLatencyMs)} |`
    );
  }
  lines.push("");

  // ── H-MCP-Adoption（Wave-1 新加）─────────────────────────────────
  lines.push("## H-MCP-Adoption · MCP 采纳率");
  lines.push("");
  const ad = report.mcpAdoption;
  lines.push(
    `- 已 enable 的 MCP server：${ad.configuredServers.length} 个 → ${ad.configuredServers.join(", ") || "（无）"}`
  );
  lines.push(
    `- 本轮 evaluation 调用过的 server：${ad.usedServers.length} 个 → ${ad.usedServers.join(", ") || "（无）"}`
  );
  lines.push(
    `- 采纳率：**${(ad.adoptionRate * 100).toFixed(0)}%** ${ad.adoptionRate < 0.3 ? "🔴 LLM 大量绕开 MCP，建议查 prompt 是否过度警告 / def.mcp_servers_json 是否注入" : ad.adoptionRate < 0.7 ? "🟡 多数 server 未被调用" : "🟢"}`
  );
  if (ad.unusedServers.length > 0) {
    lines.push(`- ⚠ 未被使用的 server：${ad.unusedServers.join(", ")}`);
  }
  lines.push("");

  lines.push("## H-LLM · Token 消耗与成本");
  lines.push("");
  lines.push(
    "| provider/model | 调用 | success | fallback | error | prompt | completion | total | cost USD | avg/call | p95/call | 截断率 |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const l of report.llm) {
    lines.push(
      `| ${l.provider}/${l.model} | ${l.totalCalls} | ${l.successCount} | ${l.fallbackCount} | ${l.errorCount} | ${(l.totalPromptTokens / 1000).toFixed(0)}k | ${(l.totalCompletionTokens / 1000).toFixed(0)}k | ${(l.totalTokens / 1000).toFixed(0)}k | $${l.totalCostUsd.toFixed(4)} | ${fmtTokens(l.avgTokensPerCall)} | ${fmtTokens(l.p95TokensPerCall)} | ${(l.truncationRate * 100).toFixed(1)}% |`
    );
  }
  lines.push("");

  lines.push("## H-Skill · Skill 召回与执行率");
  lines.push("");
  if (report.skills.length === 0) {
    lines.push("> （本轮评测未触发 skill 召回）");
  } else {
    lines.push("| skill | 召回 | 执行 | 执行率 | 平均 score |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const s of report.skills) {
      lines.push(
        `| ${s.skillId} | ${s.recallCount} | ${s.executedCount} | ${(s.executedRate * 100).toFixed(0)}% | ${s.avgScore !== null ? s.avgScore.toFixed(2) : "—"} |`
      );
    }
  }
  lines.push("");

  lines.push("## H-Errors · 错误聚合（top 10）");
  lines.push("");
  if (report.errors.length === 0) {
    lines.push("> （本轮评测未发现需要聚合的错误）");
  } else {
    lines.push("| 来源 | 出现次数 | pattern | 示例 |");
    lines.push("| --- | --- | --- | --- |");
    for (const e of report.errors) {
      lines.push(
        `| ${e.source} | ${e.count} | ${truncate(e.pattern, 80)} | ${truncate(e.examples[0] ?? "", 60)} |`
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

function gradeIcon(g: "green" | "yellow" | "red"): string {
  return g === "green" ? "🟢" : g === "yellow" ? "🟡" : "🔴";
}

function fmtMs(v: number | null): string {
  if (v === null) return "—";
  if (v < 1000) return `${v.toFixed(0)}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

function fmtTokens(v: number | null): string {
  if (v === null) return "—";
  if (v < 1000) return v.toFixed(0);
  return `${(v / 1000).toFixed(1)}k`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
