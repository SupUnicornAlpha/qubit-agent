/**
 * external.http_decision — 可跑的外部决策引擎 HTTP 适配样例。
 *
 * ProviderRef.config：
 * ```json
 * {
 *   "baseUrl": "https://decision.example.com/v1",
 *   "apiKey": "optional",
 *   "timeoutMs": 8000
 * }
 * ```
 *
 * 约定 REST（JSON）：
 * - GET  /strategies → `{ items: [{ id, name, relPath? }] }` 或数组
 * - GET  /factors    → 同上
 * - POST /sync       body `{ projectId }` → `{ factorCount, strategyCount, factors?, strategies? }`
 *   若返回 factors/strategies 带 `relPath`+`content`，会写入当前 Workspace FS。
 *
 * `external.decision_stub` 仍注册为同一实现别名（兼容旧 manifest）。
 */
import type { ProviderRef } from "../types";
import type { WorkspaceFs } from "../workspace-fs";
import { type HttpProviderConfig, httpJson, readHttpProviderConfig } from "./http-client";
import type { DecisionEngineProvider } from "./provider-types";

export const EXTERNAL_HTTP_DECISION_KIND = "external.http_decision";
/** @deprecated 请改用 external.http_decision；仍指向同一工厂 */
export const EXTERNAL_DECISION_STUB_KIND = "external.decision_stub";

type AssetRow = { id: string; name: string; relPath?: string; content?: string };

function requireConfig(ref: ProviderRef): HttpProviderConfig {
  const cfg = readHttpProviderConfig(ref);
  if (!cfg) {
    throw new Error(
      `${EXTERNAL_HTTP_DECISION_KIND} requires providers.decision.config.baseUrl. ` +
        `Example: { "kind": "external.http_decision", "config": { "baseUrl": "http://127.0.0.1:8098" } }`
    );
  }
  return cfg;
}

function asItems(data: unknown): AssetRow[] {
  if (Array.isArray(data)) return data as AssetRow[];
  if (data && typeof data === "object") {
    const items = (data as { items?: unknown }).items;
    if (Array.isArray(items)) return items as AssetRow[];
  }
  return [];
}

async function mirrorAssets(
  ws: WorkspaceFs,
  rows: AssetRow[],
  kind: "factor" | "strategy"
): Promise<number> {
  let n = 0;
  for (const row of rows) {
    if (!row?.relPath || typeof row.content !== "string") continue;
    const rel =
      row.relPath.startsWith("research/") || row.relPath.startsWith("decision/")
        ? row.relPath
        : kind === "factor"
          ? `research/factors/${row.relPath.replace(/^\/+/, "")}`
          : `decision/strategies/${row.relPath.replace(/^\/+/, "")}`;
    await ws.writeText(rel, row.content);
    n += 1;
  }
  return n;
}

export function createExternalHttpDecisionProvider(ref: ProviderRef): DecisionEngineProvider {
  const cfg = () => requireConfig(ref);
  return {
    kind: ref.kind?.trim() || EXTERNAL_HTTP_DECISION_KIND,

    async listStrategies(_ws) {
      const data = await httpJson<unknown>(cfg(), "/strategies");
      return asItems(data).map((r) => ({
        id: String(r.id),
        name: String(r.name ?? r.id),
        relPath: r.relPath,
      }));
    },

    async listFactors(_ws) {
      const data = await httpJson<unknown>(cfg(), "/factors");
      return asItems(data).map((r) => ({
        id: String(r.id),
        name: String(r.name ?? r.id),
        relPath: r.relPath,
      }));
    },

    async syncIntoWorkspace(ws, opts) {
      const data = await httpJson<{
        factorCount?: number;
        strategyCount?: number;
        factors?: AssetRow[];
        strategies?: AssetRow[];
      }>(cfg(), "/sync", {
        method: "POST",
        body: { projectId: opts.projectId },
      });
      const mirroredFactors = await mirrorAssets(ws, data.factors ?? [], "factor");
      const mirroredStrategies = await mirrorAssets(ws, data.strategies ?? [], "strategy");
      return {
        factorCount: data.factorCount ?? mirroredFactors,
        strategyCount: data.strategyCount ?? mirroredStrategies,
      };
    },
  };
}

/** @deprecated 使用 createExternalHttpDecisionProvider */
export function createExternalDecisionStub(ref?: ProviderRef): DecisionEngineProvider {
  return createExternalHttpDecisionProvider(ref ?? { kind: EXTERNAL_DECISION_STUB_KIND });
}
