/**
 * MCP 健康/熔断状态持久化（监控 V2 P1）。
 *
 * 设计要点（详见 docs/MONITORING_V2_DESIGN.md §4.1.3 / §7.2 / §7.4）：
 *
 * 现状（探索发现）：
 *   - `src/runtime/external-call/policy.ts` 内有一个 in-memory `circuitByKey: Map`，
 *     scope key 是 `mcp:<server>:<tool>:<threshold>:<cooldown>:<maxAttempts>`；
 *   - 进程重启会丢；多 worker 各自维持；
 *   - 前端**看不到** datadog server 当前是否熔断中。
 *
 * 本模块的契约（非闯入式 wrapper）：
 *   - 调用前调 `assertMcpServerNotOpen(serverName)` — 若 DB 显示 'open' 且未冷却到 →
 *     直接 throw `Error("mcp circuit breaker open: <server>")`；
 *   - 调用后无论成败，调 `recordMcpCallResult(serverName, status, errorMessage?)`
 *     更新 `mcp_server_health` 行（UPSERT）；
 *   - DB 即为真相，前端读 `/mcp/summary` 时能看到所有 server 的 circuit state；
 *   - 失败兜底：所有 DB 操作 try/catch，监控失败 ≠ 业务失败。
 *
 * 熔断阈值：复用 dispatcher.ts 现有 `failureThreshold: 3, cooldownMs: 30_000`。
 * 注意保持与 `executeWithPolicy` 内存阈值一致 —— 两条防线生效条件相同。
 *
 * 这是一个「观察 + 持久化」层，不替换内存熔断（内存仍负责短期反应敏捷度），
 * 但提供「DB 优先 fail-fast + 跨进程一致」的兜底。
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { mcpServerHealth } from "../../db/sqlite/schema";

/** 与 dispatcher.ts 现有 circuitBreaker 配置保持同步；改时两边一起改 */
export const MCP_HEALTH_FAIL_THRESHOLD = 3;
export const MCP_HEALTH_COOLDOWN_MS = 30_000;

export type McpCallStatus = "success" | "failed" | "timeout" | "sandbox_blocked";

/**
 * 当前持久化 health 行（DB 视角的一个子集，单测可直接构造）。
 */
export type CurrentHealthState = {
  circuitState: "closed" | "open" | "half_open";
  failureCount: number;
  successCount: number;
  openedAt: string | null;
  cooldownMs: number;
};

export type HealthDecision = {
  nextState: "closed" | "open" | "half_open";
  /** 触发熔断（首次进入 open / half_open 再失败而 reopen） */
  reopen: boolean;
  /** 接下来要写回 DB 的 failure_count（success 后归 0；open 后归 0 备下一轮 half_open） */
  nextFailureCount: number;
  /** 接下来要写回 DB 的 success_count（success 时 +1，其它不变） */
  nextSuccessCount: number;
};

/**
 * 纯函数：根据当前 health 与本次结果计算下一状态。
 *
 * 与 docs/MONITORING_V2_DESIGN.md §4.1.3 状态机一致：
 *   success → closed (failure_count=0, success_count+1)
 *   非 success && wasHalfOpen → open (reopen=true)
 *   非 success && failure_count+1 >= threshold → open (reopen=true)
 *   非 success 其它情况 → 维持当前状态，failure_count++
 *
 * 暴露为纯函数是为了 unit test 可以单独覆盖所有分支，
 * 而不必依赖 sqlite / drizzle / 真实 DB。
 */
export function computeNextHealthDecision(
  current: CurrentHealthState,
  status: McpCallStatus,
  failureThreshold = MCP_HEALTH_FAIL_THRESHOLD
): HealthDecision {
  if (status === "success") {
    return {
      nextState: "closed",
      reopen: false,
      nextFailureCount: 0,
      nextSuccessCount: current.successCount + 1,
    };
  }
  const wasHalfOpen = current.circuitState === "half_open";
  const incremented = current.failureCount + 1;
  const shouldOpen = wasHalfOpen || incremented >= failureThreshold;
  if (shouldOpen) {
    return {
      nextState: "open",
      reopen: true,
      // open 后归零，让下一轮 half_open 探测能从 0 重新计数；
      // 与设计文档 §4.1.3 状态机一致。
      nextFailureCount: 0,
      nextSuccessCount: current.successCount,
    };
  }
  return {
    nextState: current.circuitState,
    reopen: false,
    nextFailureCount: incremented,
    nextSuccessCount: current.successCount,
  };
}

/**
 * 调用前检查：DB 显示 server 在 cooldown 期内 → 直接 throw（fail-fast）。
 * 过冷却时间后自动重置（半开试探一次）。
 *
 * 不抛错 → server 状态可调用；具体调用结果由 `recordMcpCallResult` 收尾。
 */
export async function assertMcpServerNotOpen(serverName: string): Promise<void> {
  try {
    const db = await getDb();
    const rows = await db
      .select()
      .from(mcpServerHealth)
      .where(eq(mcpServerHealth.serverName, serverName))
      .limit(1);
    const row = rows[0];
    if (!row) return;
    if (row.circuitState !== "open") return;
    const openedAt = row.openedAt ? Date.parse(row.openedAt) : 0;
    const now = Date.now();
    if (openedAt > 0 && now - openedAt < row.cooldownMs) {
      const remainSec = Math.ceil((row.cooldownMs - (now - openedAt)) / 1000);
      throw new Error(`mcp circuit breaker open: ${serverName} (retry after ~${remainSec}s)`);
    }
    // 过了 cooldown：状态转 half_open，让下一次调用作为探测
    await db
      .update(mcpServerHealth)
      .set({
        circuitState: "half_open",
        updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      })
      .where(eq(mcpServerHealth.id, row.id));
  } catch (err) {
    // 如果是熔断 throw，往上抛；DB 异常（表不存在 / sqlite busy 等）打 warn 但**放行**
    if (err instanceof Error && err.message.startsWith("mcp circuit breaker open")) {
      throw err;
    }
    console.warn(
      `[mcpHealth] assertMcpServerNotOpen DB error (allow-through): ${(err as Error).message}`
    );
  }
}

/** Read-only prompt-time check. Unlike assertMcpServerNotOpen this never mutates half-open state. */
export async function isMcpServerInCooldown(serverName: string): Promise<boolean> {
  try {
    const db = await getDb();
    const rows = await db
      .select()
      .from(mcpServerHealth)
      .where(eq(mcpServerHealth.serverName, serverName))
      .limit(1);
    const row = rows[0];
    if (!row || row.circuitState !== "open") return false;
    const openedAt = row.openedAt ? Date.parse(row.openedAt) : 0;
    return openedAt > 0 && Date.now() - openedAt < row.cooldownMs;
  } catch (err) {
    console.warn(`[mcpHealth] cooldown read failed (allow-through): ${(err as Error).message}`);
    return false;
  }
}

/**
 * 调用后回写状态。
 *
 * 状态转移（与 §4.1.3 设计文档一致）：
 *   - success：清零 failureCount，状态回 'closed'，更新 lastSuccessAt
 *   - 任意非 success：failureCount++，达阈值 → 'open' 并写 openedAt；
 *     若先前是 'half_open' 失败 → 直接 'open' 并刷新 openedAt
 */
export async function recordMcpCallResult(
  serverName: string,
  status: McpCallStatus,
  errorMessage?: string
): Promise<void> {
  try {
    const db = await getDb();
    const rows = await db
      .select()
      .from(mcpServerHealth)
      .where(eq(mcpServerHealth.serverName, serverName))
      .limit(1);
    const row = rows[0];
    const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
    const truncatedErr = errorMessage ? errorMessage.slice(0, 500) : null;

    if (!row) {
      const isOK = status === "success";
      await db.insert(mcpServerHealth).values({
        id: randomUUID(),
        serverName,
        circuitState: "closed",
        failureCount: isOK ? 0 : 1,
        successCount: isOK ? 1 : 0,
        lastSuccessAt: isOK ? new Date().toISOString() : null,
        lastFailureAt: isOK ? null : new Date().toISOString(),
        lastErrorMessage: isOK ? null : truncatedErr,
        cooldownMs: MCP_HEALTH_COOLDOWN_MS,
      });
      return;
    }

    // 状态转移走纯函数 computeNextHealthDecision，便于单测覆盖
    const decision = computeNextHealthDecision(
      {
        circuitState: row.circuitState,
        failureCount: row.failureCount,
        successCount: row.successCount,
        openedAt: row.openedAt,
        cooldownMs: row.cooldownMs,
      },
      status
    );

    if (status === "success") {
      await db
        .update(mcpServerHealth)
        .set({
          circuitState: decision.nextState,
          failureCount: decision.nextFailureCount,
          successCount: decision.nextSuccessCount,
          lastSuccessAt: new Date().toISOString(),
          openedAt: null,
          lastCheckAt: now,
          updatedAt: now,
        })
        .where(eq(mcpServerHealth.id, row.id));
      return;
    }

    await db
      .update(mcpServerHealth)
      .set({
        circuitState: decision.nextState,
        failureCount: decision.nextFailureCount,
        successCount: decision.nextSuccessCount,
        lastFailureAt: new Date().toISOString(),
        lastErrorMessage: truncatedErr,
        openedAt: decision.reopen ? new Date().toISOString() : row.openedAt,
        lastCheckAt: now,
        updatedAt: now,
      })
      .where(eq(mcpServerHealth.id, row.id));
  } catch (err) {
    console.warn(
      `[mcpHealth] recordMcpCallResult DB error (server=${serverName} status=${status}): ${(err as Error).message}`
    );
  }
}

/** 仅测试用：清理某 server 的 health 行（让单测能反复构造场景） */
export async function __resetMcpHealthForTest(serverName: string): Promise<void> {
  const db = await getDb();
  await db.delete(mcpServerHealth).where(eq(mcpServerHealth.serverName, serverName));
}
