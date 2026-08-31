/**
 * Connector 健康自检 —— 把 connectorRegistry 中的每个 connector 跑一次
 * `healthcheck()`，结果聚合给 EnvironmentManager 的 status 顶层。
 *
 * 设计要点（DESIGN §6.4）：
 *   - 每个 probe 限时 5s（避免卡死的 connector 拖崩 status API）
 *   - degraded / unhealthy 都不阻断 ok 判定（status 顶层在 status.ts 里
 *     单独决策：connector 不 healthy 不视为致命，因为 connector 健康度
 *     的 SoT 是 monitor_v2，env-mgr 这里只是顺手汇总）
 *   - 不并行所有 connectors —— Promise.all 失败传染会让局部错变全局错；
 *     用 allSettled 做容错（任何一个 connector throw 都仍能拿到其它的）
 */

import { connectorRegistry } from "../../connectors/registry";
import type { HealthStatus } from "../../types/connector";
import { recordConnectorCall } from "../monitor/connector-call-log";

export interface ConnectorProbe {
  name: string;
  type: string;
  status: HealthStatus | "error";
  latencyMs: number | null;
  message: string;
  checkedAt: string;
}

const PROBE_TIMEOUT_MS = 5_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race<T>([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`connector probe timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export async function listConnectorProbes(): Promise<ConnectorProbe[]> {
  const all = connectorRegistry.getAll();
  const tasks: Array<Promise<ConnectorProbe>> = [];
  for (const [name, connector] of all) {
    tasks.push(
      (async () => {
        const startedAt = Date.now();
        try {
          const r = await withTimeout(connector.healthcheck(), PROBE_TIMEOUT_MS);
          void recordConnectorCall({
            connectorName: name,
            operation: "healthcheck",
            request: { probeTimeoutMs: PROBE_TIMEOUT_MS },
            response: { status: r.status, message: r.message ?? null },
            latencyMs: r.latencyMs ?? Date.now() - startedAt,
            status: r.status === "healthy" ? "success" : "error",
            ...(r.message ? { errorMessage: r.message } : {}),
          }).catch((error) => {
            console.warn(`[connector-monitor] failed to record probe: ${String(error)}`);
          });
          return {
            name,
            type: connector.meta.connectorType,
            status: r.status,
            latencyMs: r.latencyMs ?? Date.now() - startedAt,
            message: r.message ?? "",
            checkedAt: r.checkedAt,
          };
        } catch (e) {
          const message = (e as Error).message;
          void recordConnectorCall({
            connectorName: name,
            operation: "healthcheck",
            request: { probeTimeoutMs: PROBE_TIMEOUT_MS },
            latencyMs: Date.now() - startedAt,
            status: /timed?\s*out|timeout/i.test(message) ? "timeout" : "error",
            errorMessage: message,
          }).catch((error) => {
            console.warn(`[connector-monitor] failed to record probe error: ${String(error)}`);
          });
          return {
            name,
            type: connector.meta.connectorType,
            status: "error" as const,
            latencyMs: null,
            message,
            checkedAt: new Date().toISOString(),
          };
        }
      })()
    );
  }
  return await Promise.all(tasks);
}
