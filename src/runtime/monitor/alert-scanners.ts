/**
 * 监控 V2 P2 — 新增两类告警扫描器：
 *
 *   1) `mcp_circuit_open`：某 MCP server 处于 'open' 且 openedAt > X 分钟（默认 5）未自愈
 *   2) `token_anomaly`：24h 内某 provider 用量比上周同窗涨 ≥ N× 触发（默认 2×）
 *
 * 设计要点（详见 docs/MONITORING_V2_DESIGN.md §6.9 / §7.5）：
 *   - 与现有 alert-service.ts 的开窗 alert（workflow_failed / workflow_stuck）
 *     行为一致：scope_type/scope_id/alert_type 唯一活跃；重复 scan 不复制；
 *   - 触发条件全部可通过参数 override，便于单测；
 *   - 纯函数 `evaluateMcpCircuitOpenAlert` / `evaluateTokenAnomalyAlert` 抽出，
 *     方便单测覆盖各分支不依赖 sqlite。
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { alertEvent, llmCallLog, mcpServerHealth } from "../../db/sqlite/schema";

/** 告警类型字符串常量（alertEvent.alert_type 是 free text，不在 enum 内） */
export const ALERT_TYPE_MCP_CIRCUIT_OPEN = "mcp_circuit_open";
export const ALERT_TYPE_TOKEN_ANOMALY = "token_anomaly";

// ───────────────────────── mcp_circuit_open ─────────────────────────

export type McpCircuitOpenInput = {
  /** 扫描时间，默认 now；测试时用以注入 */
  now?: Date;
  /** 持续 open 多少分钟才触发（默认 5）；< 该阈值视为短抖动不告警 */
  stuckMinutes?: number;
};

export type McpCircuitOpenDecision = {
  shouldAlert: boolean;
  stuckMs: number;
  reason: string;
};

/**
 * 纯函数：根据 health 行决定是否对该 server 起 alert。
 * 暴露为纯函数便于单测覆盖以下 case：
 *   - circuitState != 'open' → 不告警
 *   - openedAt 缺失 → 不告警（不可信）
 *   - open 但 < stuckMinutes → 不告警（短抖动）
 *   - open 且 ≥ stuckMinutes → 告警
 */
export function evaluateMcpCircuitOpenAlert(
  health: {
    circuitState: "closed" | "open" | "half_open";
    openedAt: string | null;
  },
  now: Date,
  stuckMinutes: number
): McpCircuitOpenDecision {
  if (health.circuitState !== "open") {
    return { shouldAlert: false, stuckMs: 0, reason: "not open" };
  }
  if (!health.openedAt) {
    return { shouldAlert: false, stuckMs: 0, reason: "openedAt missing" };
  }
  const openedAt = Date.parse(health.openedAt);
  if (!Number.isFinite(openedAt)) {
    return { shouldAlert: false, stuckMs: 0, reason: "openedAt unparsable" };
  }
  const stuckMs = now.getTime() - openedAt;
  const thresholdMs = stuckMinutes * 60 * 1000;
  if (stuckMs < thresholdMs) {
    return { shouldAlert: false, stuckMs, reason: `stuck only ${Math.round(stuckMs / 1000)}s` };
  }
  return {
    shouldAlert: true,
    stuckMs,
    reason: `stuck ${Math.round(stuckMs / 60_000)} minutes`,
  };
}

export async function scanMcpCircuitOpenAlerts(input?: McpCircuitOpenInput) {
  const db = await getDb();
  const now = input?.now ?? new Date();
  const stuckMinutes = clampInt(input?.stuckMinutes ?? 5, 1, 24 * 60);
  const rows = await db.select().from(mcpServerHealth);

  const createdIds: string[] = [];
  let scanned = 0;
  for (const h of rows) {
    scanned += 1;
    const decision = evaluateMcpCircuitOpenAlert(
      { circuitState: h.circuitState, openedAt: h.openedAt },
      now,
      stuckMinutes
    );
    if (!decision.shouldAlert) continue;

    // 查重：同 scope + 同 alert_type 已 open 不重复创建（行为与现有 stuck workflow 一致）
    const existing = await db
      .select()
      .from(alertEvent)
      .where(
        and(
          eq(alertEvent.scopeType, "system"),
          eq(alertEvent.scopeId, h.serverName),
          eq(alertEvent.alertType, ALERT_TYPE_MCP_CIRCUIT_OPEN),
          eq(alertEvent.status, "open")
        )
      )
      .limit(1);
    if (existing[0]) continue;

    const id = randomUUID();
    await db.insert(alertEvent).values({
      id,
      scopeType: "system",
      scopeId: h.serverName,
      alertType: ALERT_TYPE_MCP_CIRCUIT_OPEN,
      severity: "error",
      title: `MCP server "${h.serverName}" 熔断 ≥ ${stuckMinutes} 分钟`,
      detailsJson: {
        serverName: h.serverName,
        openedAt: h.openedAt,
        stuckMs: decision.stuckMs,
        failureCount: h.failureCount,
        lastErrorMessage: h.lastErrorMessage,
        cooldownMs: h.cooldownMs,
      },
      status: "open",
    });
    createdIds.push(id);
  }
  return { scanned, created: createdIds.length, alertIds: createdIds };
}

// ───────────────────────── token_anomaly ─────────────────────────

export type TokenAnomalyInput = {
  /** 扫描时间，默认 now；测试用 */
  now?: Date;
  /** 比上周同窗涨 ≥ ratioThreshold × 触发，默认 2.0 */
  ratioThreshold?: number;
  /** 当前窗口分钟数（默认 1440=24h） */
  windowMinutes?: number;
  /**
   * 历史基线最小 token 数（默认 1000）：低于此值的基线视为"不稳定基线"，
   * 不告警，避免「上周用了 100 个 token，本周用了 300」这种伪异常。
   */
  baselineMinTokens?: number;
};

export type TokenAnomalyDecision = {
  shouldAlert: boolean;
  ratio: number;
  reason: string;
};

/**
 * 纯函数：根据当前窗口 token 与基线 token 决定是否告警。
 *   - baseline < baselineMinTokens → 不告警（基线不稳定）
 *   - current / baseline < ratioThreshold → 不告警
 *   - current / baseline ≥ ratioThreshold → 告警
 */
export function evaluateTokenAnomalyAlert(
  currentTokens: number,
  baselineTokens: number,
  ratioThreshold: number,
  baselineMinTokens: number
): TokenAnomalyDecision {
  if (baselineTokens < baselineMinTokens) {
    return {
      shouldAlert: false,
      ratio: 0,
      reason: `baseline ${baselineTokens} < min ${baselineMinTokens}`,
    };
  }
  const ratio = currentTokens / baselineTokens;
  if (ratio < ratioThreshold) {
    return {
      shouldAlert: false,
      ratio,
      reason: `ratio ${ratio.toFixed(2)} < ${ratioThreshold.toFixed(2)}`,
    };
  }
  return {
    shouldAlert: true,
    ratio,
    reason: `current ${currentTokens} / baseline ${baselineTokens} = ${ratio.toFixed(2)}× ≥ ${ratioThreshold.toFixed(2)}×`,
  };
}

/**
 * 扫描入口：按 provider 维度比对本周窗口与上周同窗口的 totalTokens。
 *
 * 实现策略（最小可用）：
 *   - 当前窗口：[now - windowMinutes, now]
 *   - 上周同窗：[now - 7d - windowMinutes, now - 7d]
 *   - 跨 model 合并到 provider 一行（细到 model 会噪声太多）
 */
export async function scanTokenAnomalyAlerts(input?: TokenAnomalyInput) {
  const db = await getDb();
  const now = input?.now ?? new Date();
  const windowMinutes = clampInt(input?.windowMinutes ?? 24 * 60, 60, 7 * 24 * 60);
  const ratioThreshold = Math.max(1.1, input?.ratioThreshold ?? 2);
  const baselineMinTokens = Math.max(1, input?.baselineMinTokens ?? 1000);

  const winMs = windowMinutes * 60 * 1000;
  const currentSince = new Date(now.getTime() - winMs).toISOString();
  const baselineFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000 - winMs).toISOString();
  const baselineTo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  /**
   * 单次拉两个窗口的原始日志再 group by provider；
   * 数据量级（24h × 多 provider 一般 < 10k 行）下扫表足够，不需要 SQL group by。
   */
  const currentRows = await db
    .select({
      provider: llmCallLog.provider,
      totalTokens: llmCallLog.totalTokens,
    })
    .from(llmCallLog)
    .where(gte(llmCallLog.createdAt, currentSince));

  const baselineRows = await db
    .select({
      provider: llmCallLog.provider,
      totalTokens: llmCallLog.totalTokens,
      createdAt: llmCallLog.createdAt,
    })
    .from(llmCallLog)
    .where(
      and(
        gte(llmCallLog.createdAt, baselineFrom),
        // 排除晚于 baselineTo 的行（上周窗口内）—— 用 gte+前置过滤 + 后面用 JS 再过滤
      )
    );

  const currentByProvider = new Map<string, number>();
  for (const r of currentRows) {
    const cur = currentByProvider.get(r.provider) ?? 0;
    currentByProvider.set(r.provider, cur + (r.totalTokens ?? 0));
  }
  const baselineByProvider = new Map<string, number>();
  for (const r of baselineRows) {
    if (r.createdAt > baselineTo) continue;
    const cur = baselineByProvider.get(r.provider) ?? 0;
    baselineByProvider.set(r.provider, cur + (r.totalTokens ?? 0));
  }

  const createdIds: string[] = [];
  let scanned = 0;
  for (const [provider, current] of currentByProvider.entries()) {
    scanned += 1;
    const baseline = baselineByProvider.get(provider) ?? 0;
    const decision = evaluateTokenAnomalyAlert(
      current,
      baseline,
      ratioThreshold,
      baselineMinTokens
    );
    if (!decision.shouldAlert) continue;

    const existing = await db
      .select()
      .from(alertEvent)
      .where(
        and(
          eq(alertEvent.scopeType, "system"),
          eq(alertEvent.scopeId, provider),
          eq(alertEvent.alertType, ALERT_TYPE_TOKEN_ANOMALY),
          eq(alertEvent.status, "open")
        )
      )
      .limit(1);
    if (existing[0]) continue;

    const id = randomUUID();
    await db.insert(alertEvent).values({
      id,
      scopeType: "system",
      scopeId: provider,
      alertType: ALERT_TYPE_TOKEN_ANOMALY,
      severity: "warn",
      title: `LLM provider "${provider}" 用量异常（${decision.ratio.toFixed(2)}×）`,
      detailsJson: {
        provider,
        currentWindowMinutes: windowMinutes,
        currentTokens: current,
        baselineTokens: baseline,
        ratio: decision.ratio,
        threshold: ratioThreshold,
      },
      status: "open",
    });
    createdIds.push(id);
  }
  return { scanned, created: createdIds.length, alertIds: createdIds };
}

// ───────────────────────── unified scan ─────────────────────────

/**
 * 统一入口：一次跑全部扫描器（mcp_circuit_open + token_anomaly + stuck workflow），
 * 用于 cron / scheduled job。
 *
 * stuck workflow 由 alert-service.ts 的 `createStuckWorkflowAlerts` 提供；
 * 这里只做编排不重新实现。
 */
export type AllAlertScanResult = {
  mcp: Awaited<ReturnType<typeof scanMcpCircuitOpenAlerts>>;
  token: Awaited<ReturnType<typeof scanTokenAnomalyAlerts>>;
};

export async function scanAllSystemAlerts(input?: {
  mcpStuckMinutes?: number;
  tokenRatioThreshold?: number;
  tokenWindowMinutes?: number;
}): Promise<AllAlertScanResult> {
  const mcpInput: McpCircuitOpenInput =
    input?.mcpStuckMinutes !== undefined ? { stuckMinutes: input.mcpStuckMinutes } : {};
  const tokenInput: TokenAnomalyInput = {};
  if (input?.tokenRatioThreshold !== undefined) {
    tokenInput.ratioThreshold = input.tokenRatioThreshold;
  }
  if (input?.tokenWindowMinutes !== undefined) {
    tokenInput.windowMinutes = input.tokenWindowMinutes;
  }
  const [mcp, token] = await Promise.all([
    scanMcpCircuitOpenAlerts(mcpInput),
    scanTokenAnomalyAlerts(tokenInput),
  ]);
  return { mcp, token };
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
