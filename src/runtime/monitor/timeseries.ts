/**
 * 监控 V3 P0 — 统一 timeseries 查询。
 *
 * 设计目标（详见 docs/MONITORING_V2_DESIGN.md §扩展讨论 + 本期 timeseries 演进）：
 *   - 之前所有 /monitor/* 端点都只返回"窗口内合计"标量；前端画不了时间趋势图。
 *   - 本端点统一回答："过去 X 时间，按 Y 维度切分，每个时间桶（5m/1h/1d）的 Z 指标是多少"。
 *
 * 输出契约严格固定为：
 *
 *   {
 *     interval: '1m' | '5m' | '15m' | '1h' | '1d',
 *     from: ISO, to: ISO,
 *     buckets: ISO[],              // 完整桶时间戳列表（连续，便于前端画 X 轴）
 *     series: Array<{ name: string, points: number[] }>,  // points.length === buckets.length
 *   }
 *
 *   - 空桶补 0（前端画线不会断）。
 *   - groupBy 为空时返回单一 series（name='total'）。
 *   - groupBy=agentDefinitionId / definitionId 时 name=definitionId（前端自己映射成 role/name）。
 *
 * 注意：
 *   - 本文件不做 P50/P95（SQLite 无原生 percentile_cont），那两个指标走 in-memory 计算路径；
 *     本期只支持 count / errorCount / tokens / cost / avgLatency 五种数值聚合。
 *   - SQL 分桶用 `strftime`，避免引入 JS 端遍历百万行。
 *
 * 写入侧前置：本端点需要的列冗余已由迁移 0064 (monitoring_v3_timeseries) 落地。
 */
import { type SQL, and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  llmCallLog,
  mcpCallLog,
  skillRecallLog,
  toolCallLog,
  workflowRun,
} from "../../db/sqlite/schema";

// ───────────────────────────── 入参契约 ─────────────────────────────

export const TIMESERIES_SOURCES = [
  "llm_call_log",
  "tool_call_log",
  "mcp_call_log",
  "skill_recall_log",
] as const;
export type TimeseriesSource = (typeof TIMESERIES_SOURCES)[number];

export const TIMESERIES_METRICS = ["count", "errorCount", "tokens", "cost", "avgLatency"] as const;
export type TimeseriesMetric = (typeof TIMESERIES_METRICS)[number];

export const TIMESERIES_INTERVALS = ["1m", "5m", "15m", "1h", "1d"] as const;
export type TimeseriesInterval = (typeof TIMESERIES_INTERVALS)[number];

export const TIMESERIES_GROUP_BYS = [
  "provider",
  "model",
  "agentDefinitionId",
  "definitionId",
  "serverName",
  "toolName",
  "toolKind",
  "transport",
  "circuitState",
  "status",
  "executed",
] as const;
export type TimeseriesGroupBy = (typeof TIMESERIES_GROUP_BYS)[number];

export interface TimeseriesQueryInput {
  source: TimeseriesSource;
  metric: TimeseriesMetric;
  interval: TimeseriesInterval;
  from: string; // ISO
  to: string; // ISO（不含）
  groupBy?: TimeseriesGroupBy | undefined;
  /** 可选 session 过滤（leftJoin workflow_run） */
  sessionId?: string | undefined;
  /** 上限：series 数 + 桶数太多直接拒，防止前端 OOM。默认 50 series / 1000 桶。 */
  maxSeries?: number;
  maxBuckets?: number;
}

export interface TimeseriesQueryResult {
  source: TimeseriesSource;
  metric: TimeseriesMetric;
  interval: TimeseriesInterval;
  from: string;
  to: string;
  buckets: string[];
  series: Array<{ name: string; points: number[] }>;
}

// ───────────────────────────── 公开纯函数（便于单测） ─────────────────────────────

const INTERVAL_SECONDS: Record<TimeseriesInterval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "1d": 86400,
};

/**
 * 把"任意时间点"对齐到 interval 起点（UTC）。
 * 返回 ISO 字符串，与 SQL 端的 strftime 结果完全一致（含末尾 'Z'）。
 *
 * 注意：本函数不依赖本地时区——所有桶都在 UTC 上对齐，跨时区运行结果一致。
 */
export function floorToBucket(date: Date, interval: TimeseriesInterval): string {
  const sec = INTERVAL_SECONDS[interval];
  const epoch = Math.floor(date.getTime() / 1000);
  const aligned = Math.floor(epoch / sec) * sec;
  return new Date(aligned * 1000).toISOString().slice(0, 19) + "Z";
}

/**
 * 生成 [from, to) 内所有桶起点（已 floor 到 interval 边界）。
 * - from 自身先 floor；到 to 之前的最后一个完整桶为止。
 * - to 不含（与 SQL 的 < to 一致）。
 */
export function buildBucketStarts(from: Date, to: Date, interval: TimeseriesInterval): string[] {
  if (to.getTime() <= from.getTime()) return [];
  const sec = INTERVAL_SECONDS[interval];
  const firstAligned = Math.floor(from.getTime() / 1000 / sec) * sec;
  const lastAlignedExclusive = Math.floor((to.getTime() - 1) / 1000 / sec) * sec;
  const out: string[] = [];
  for (let t = firstAligned; t <= lastAlignedExclusive; t += sec) {
    out.push(new Date(t * 1000).toISOString().slice(0, 19) + "Z");
  }
  return out;
}

/**
 * 把稀疏的 DB 行（{ts, series, value}）填充成密集矩阵：
 *   - 行：series（按字典序稳定排序，便于前端图例稳定）
 *   - 列：bucketStarts（已是完整桶列表）
 *   - 缺失值补 0；负值原样保留（cost 不会出现负，但 avgLatency 在异常数据下可能为负，留给前端展示）
 */
export function fillMissingBuckets(
  bucketStarts: string[],
  rows: Array<{ ts: string; series: string; value: number }>
): Array<{ name: string; points: number[] }> {
  const seriesIndex = new Map<string, number[]>();
  const bucketIdx = new Map<string, number>();
  bucketStarts.forEach((ts, i) => bucketIdx.set(ts, i));

  for (const r of rows) {
    if (!seriesIndex.has(r.series)) {
      seriesIndex.set(r.series, new Array(bucketStarts.length).fill(0));
    }
    const idx = bucketIdx.get(r.ts);
    if (idx === undefined) continue; // 边界外，理论不应出现
    const arr = seriesIndex.get(r.series)!;
    arr[idx] = r.value;
  }

  return [...seriesIndex.keys()].sort().map((name) => ({ name, points: seriesIndex.get(name)! }));
}

// ───────────────────────────── 内部：SQL 分桶表达式 ─────────────────────────────

/**
 * 构造按 interval 分桶的 SQL 表达式，返回值与 floorToBucket 一致（ISO + 'Z'）。
 *
 * SQLite 没有 date_trunc，所以：
 *   - 分钟级：先 strftime('%Y-%m-%dT%H:', t)，再拼接对齐后的分钟段。
 *   - 小时/天级：直接 strftime，零字符串拼接。
 *
 * 注意：所有 created_at 都假定 'YYYY-MM-DDTHH:MM:SS.sssZ' 格式（schema.ts 内 createdAt 默认）。
 */
function bucketExpr(createdAtColumn: SQL, interval: TimeseriesInterval): SQL<string> {
  switch (interval) {
    case "1m":
      return sql<string>`strftime('%Y-%m-%dT%H:%M:00Z', ${createdAtColumn})`;
    case "5m":
      return sql<string>`strftime('%Y-%m-%dT%H:', ${createdAtColumn}) || printf('%02d:00Z', (CAST(strftime('%M', ${createdAtColumn}) AS INTEGER) / 5) * 5)`;
    case "15m":
      return sql<string>`strftime('%Y-%m-%dT%H:', ${createdAtColumn}) || printf('%02d:00Z', (CAST(strftime('%M', ${createdAtColumn}) AS INTEGER) / 15) * 15)`;
    case "1h":
      return sql<string>`strftime('%Y-%m-%dT%H:00:00Z', ${createdAtColumn})`;
    case "1d":
      return sql<string>`strftime('%Y-%m-%dT00:00:00Z', ${createdAtColumn})`;
  }
}

// ───────────────────────────── 内部：每张表的字段映射 ─────────────────────────────

/**
 * 给定 source，返回：
 *  - 表的"created_at"列（用于 where / 分桶）
 *  - 该表"成功"枚举值（用于 errorCount = total - success-like）
 *  - 该表支持的 groupBy → 实际列映射
 *  - latency 列、token 列、cost 列（用于不同 metric）
 */
type TableBinding = {
  table: typeof llmCallLog | typeof toolCallLog | typeof mcpCallLog | typeof skillRecallLog;
  createdAt: SQL;
  workflowRunId?: SQL; // 用于 sessionId 过滤
  groupByMap: Partial<Record<TimeseriesGroupBy, SQL>>;
  /**
   * 给定本表的 row，认为"成功"返回 1，否则 0；用于 errorCount = total - success-like。
   * 注意 fallback 也计成功（仍然给到了 LLM 输出）。
   */
  isSuccessExpr: SQL<number> | null; // null = 该表没有 status（如 skill_recall_log），errorCount 不支持
  latency: SQL | null;
  tokens: SQL | null;
  cost: SQL | null;
};

function getTableBinding(source: TimeseriesSource): TableBinding {
  switch (source) {
    case "llm_call_log":
      return {
        table: llmCallLog,
        createdAt: sql`${llmCallLog.createdAt}`,
        workflowRunId: sql`${llmCallLog.workflowRunId}`,
        groupByMap: {
          provider: sql`${llmCallLog.provider}`,
          model: sql`${llmCallLog.model}`,
          agentDefinitionId: sql`${llmCallLog.agentDefinitionId}`,
          status: sql`${llmCallLog.status}`,
        },
        isSuccessExpr: sql<number>`CASE WHEN ${llmCallLog.status} IN ('success','fallback') THEN 1 ELSE 0 END`,
        latency: sql`${llmCallLog.latencyMs}`,
        tokens: sql`${llmCallLog.totalTokens}`,
        cost: sql`${llmCallLog.costUsd}`,
      };
    case "tool_call_log":
      return {
        table: toolCallLog,
        createdAt: sql`${toolCallLog.createdAt}`,
        workflowRunId: sql`${toolCallLog.workflowRunId}`,
        groupByMap: {
          toolKind: sql`${toolCallLog.toolKind}`,
          toolName: sql`${toolCallLog.toolName}`,
          status: sql`${toolCallLog.status}`,
          agentDefinitionId: sql`${toolCallLog.agentDefinitionId}`,
        },
        isSuccessExpr: sql<number>`CASE WHEN ${toolCallLog.status} = 'success' THEN 1 ELSE 0 END`,
        latency: sql`${toolCallLog.latencyMs}`,
        tokens: null,
        cost: null,
      };
    case "mcp_call_log":
      return {
        table: mcpCallLog,
        createdAt: sql`${mcpCallLog.createdAt}`,
        workflowRunId: sql`${mcpCallLog.workflowRunId}`,
        groupByMap: {
          serverName: sql`${mcpCallLog.serverName}`,
          toolName: sql`${mcpCallLog.toolName}`,
          status: sql`${mcpCallLog.status}`,
          transport: sql`${mcpCallLog.transport}`,
          circuitState: sql`${mcpCallLog.circuitState}`,
          agentDefinitionId: sql`${mcpCallLog.agentDefinitionId}`,
        },
        isSuccessExpr: sql<number>`CASE WHEN ${mcpCallLog.status} = 'success' THEN 1 ELSE 0 END`,
        latency: sql`${mcpCallLog.latencyMs}`,
        tokens: null,
        cost: null,
      };
    case "skill_recall_log":
      return {
        table: skillRecallLog,
        createdAt: sql`${skillRecallLog.createdAt}`,
        workflowRunId: sql`${skillRecallLog.workflowRunId}`,
        groupByMap: {
          definitionId: sql`${skillRecallLog.definitionId}`,
          executed: sql`${skillRecallLog.executed}`,
        },
        isSuccessExpr: null,
        latency: null,
        tokens: null,
        cost: null,
      };
  }
}

// ───────────────────────────── 主查询 ─────────────────────────────

const DEFAULT_MAX_BUCKETS = 1000;
const DEFAULT_MAX_SERIES = 50;

export async function queryTimeseries(input: TimeseriesQueryInput): Promise<TimeseriesQueryResult> {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error(`invalid from/to: ${input.from} / ${input.to}`);
  }
  if (to.getTime() <= from.getTime()) {
    throw new Error("to must be > from");
  }

  const maxBuckets = input.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  const maxSeries = input.maxSeries ?? DEFAULT_MAX_SERIES;

  const bucketStarts = buildBucketStarts(from, to, input.interval);
  if (bucketStarts.length > maxBuckets) {
    throw new Error(
      `too many buckets: ${bucketStarts.length} > ${maxBuckets}; tune interval / shorten range`
    );
  }

  const binding = getTableBinding(input.source);

  // metric → aggregate expression
  const valueExpr = buildValueExpr(input.metric, binding);
  if (!valueExpr) {
    throw new Error(`metric '${input.metric}' is not supported by source '${input.source}'`);
  }

  // groupBy → series 列；undefined 时统一占位为 'total'
  const seriesExpr = input.groupBy ? binding.groupByMap[input.groupBy] : sql<string>`'total'`;
  if (input.groupBy && !seriesExpr) {
    throw new Error(`groupBy '${input.groupBy}' is not supported by source '${input.source}'`);
  }

  const tsExpr = bucketExpr(binding.createdAt, input.interval);
  /** 把 null（如 agentDefinitionId 列旧行没回填）展示成显式 '(null)'，不至于在 X 轴上消失 */
  const seriesExpr2 = sql<string>`COALESCE(CAST(${seriesExpr} AS TEXT), '(null)')`;

  const db = await getDb();

  const whereClauses: SQL[] = [
    gte(binding.createdAt as unknown as SQL<string>, input.from),
    lt(binding.createdAt as unknown as SQL<string>, input.to),
  ];

  /**
   * 用 $dynamic + 分支条件链路构建查询；用 `as any` 单点抑制 union table 的 TS 抱怨，
   * 避免对每张表写 5 份重复 select。运行期是同一套 SELECT / LEFT JOIN / WHERE / GROUP BY 模板。
   *
   * 注意：`.groupBy()` 只接受裸 SQL（不接受 SQL.Aliased），所以这里用 tsExpr / seriesExpr2
   * 的原始表达式，而 select 输出仍走 `.as("ts" / "series" / "value")` 命名以便结果好读。
   */
  // biome-ignore lint/suspicious/noExplicitAny: union of 4 sqlite tables defeats drizzle types; covered by integration tests
  const baseQuery = db
    .select({
      ts: tsExpr.as("ts"),
      series: seriesExpr2.as("series"),
      value: valueExpr.as("value"),
    })
    .from(binding.table as any)
    .$dynamic();

  const filteredQuery =
    input.sessionId && binding.workflowRunId
      ? baseQuery
          .leftJoin(
            workflowRun,
            eq(workflowRun.id, binding.workflowRunId as unknown as SQL<string>)
          )
          .where(and(...whereClauses, eq(workflowRun.sessionId, input.sessionId)))
      : baseQuery.where(and(...whereClauses));

  const rows = (await filteredQuery.groupBy(tsExpr, seriesExpr2).all()) as Array<{
    ts: string;
    series: string;
    value: number | null;
  }>;

  const normalized = rows.map((r) => ({
    ts: r.ts,
    series: r.series ?? "(null)",
    value: typeof r.value === "number" && Number.isFinite(r.value) ? r.value : 0,
  }));

  // 限制 series 数量（按总量降序保留 top maxSeries，剩余合并成 "(others)"）
  const seriesTotals = new Map<string, number>();
  for (const r of normalized) {
    seriesTotals.set(r.series, (seriesTotals.get(r.series) ?? 0) + r.value);
  }
  const keepSet = new Set(
    [...seriesTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxSeries)
      .map(([k]) => k)
  );
  let collapsedRows = normalized;
  if (seriesTotals.size > maxSeries) {
    collapsedRows = normalized.map((r) =>
      keepSet.has(r.series) ? r : { ...r, series: "(others)" }
    );
  }

  const series = fillMissingBuckets(bucketStarts, collapsedRows);

  return {
    source: input.source,
    metric: input.metric,
    interval: input.interval,
    from: input.from,
    to: input.to,
    buckets: bucketStarts,
    series,
  };
}

function buildValueExpr(metric: TimeseriesMetric, binding: TableBinding): SQL<number> | null {
  switch (metric) {
    case "count":
      return sql<number>`COUNT(*)`;
    case "errorCount":
      if (!binding.isSuccessExpr) return null;
      return sql<number>`SUM(1 - ${binding.isSuccessExpr})`;
    case "tokens":
      if (!binding.tokens) return null;
      return sql<number>`COALESCE(SUM(${binding.tokens}), 0)`;
    case "cost":
      if (!binding.cost) return null;
      return sql<number>`COALESCE(SUM(${binding.cost}), 0)`;
    case "avgLatency":
      if (!binding.latency) return null;
      return sql<number>`COALESCE(AVG(${binding.latency}), 0)`;
  }
}
