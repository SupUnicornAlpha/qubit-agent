import { and, eq, isNull, or } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { mcpServerConfig, mcpToolBinding } from "../../db/sqlite/schema";
import { executeWithPolicy } from "../external-call/policy";
import { assertMcpServerNotOpen, recordMcpCallResult } from "../monitor/mcp-health-tracker";
import { callMcpHttpTool, httpEndpointFromServer, httpHeadersFromCaps } from "./http-transport";
import { resolveMcpStdioArgv } from "./package-manager";
import { callMcpStdioTool, stdioArgvFromServer } from "./stdio-session";
import { callMcpWsTool } from "./ws-transport";

export interface McpDispatchInput {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  projectId?: string;
  /** When set, prefers `mcp_tool_binding` rows scoped to this agent definition; falls back to rows with null definition_id. */
  definitionId?: string;
}

export interface McpDispatchResult {
  serverName: string;
  toolName: string;
  transport: "stdio" | "http" | "ws";
  accepted: boolean;
  output: Record<string, unknown>;
}

type McpBindingRow = typeof mcpToolBinding.$inferSelect;

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function stringifyResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result))
    return result as Record<string, unknown>;
  return { value: result as string | number | boolean | null };
}

/** Higher = more specific for dispatch (definition → project → exact tool name). */
function bindingSpecificityScore(
  row: McpBindingRow,
  toolName: string,
  projectId: string | undefined,
  definitionId: string | undefined
): number {
  let defS = 0;
  if (definitionId) {
    if (row.definitionId === definitionId) defS = 3;
    else if (row.definitionId == null) defS = 1;
    else return -1;
  } else {
    if (row.definitionId != null) return -1;
    defS = 1;
  }

  let projS = 0;
  if (projectId) {
    if (row.projectId === projectId) projS = 3;
    else if (row.projectId == null) projS = 1;
    else return -1;
  } else {
    if (row.projectId != null) return -1;
    projS = 1;
  }

  let toolS = 0;
  if (row.toolName === toolName) toolS = 3;
  else if (row.toolName === "*") toolS = 1;
  else return -1;

  return defS * 100 + projS * 10 + toolS;
}

function pickBestBindingRow(
  rows: McpBindingRow[],
  toolName: string,
  projectId: string | undefined,
  definitionId: string | undefined,
  requireEnabled: boolean
): McpBindingRow | undefined {
  const candidates = rows
    .map((row) => ({ row, score: bindingSpecificityScore(row, toolName, projectId, definitionId) }))
    .filter((x) => x.score >= 0 && (!requireEnabled || x.row.enabled));
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.row.enabled !== b.row.enabled) return a.row.enabled ? -1 : 1;
    return 0;
  });
  return candidates[0]!.row;
}

/**
 * P0-4：从 `mcp_tool_binding.timeoutMs` + `mcp_tool_binding.retryPolicyJson` 一次性
 * 取出最特定 binding 行的执行策略；同时返回 row 让 caller 不必再查一次。
 */
interface ResolvedMcpPolicy {
  timeoutMs: number;
  retry: { maxAttempts: number; backoffMs: number; backoffMultiplier: number };
}

const DEFAULT_MCP_POLICY: ResolvedMcpPolicy = {
  timeoutMs: 60_000,
  retry: { maxAttempts: 2, backoffMs: 150, backoffMultiplier: 2 },
};

function parseRetryPolicy(raw: unknown): ResolvedMcpPolicy["retry"] {
  if (!raw || typeof raw !== "object") return DEFAULT_MCP_POLICY.retry;
  const o = raw as Record<string, unknown>;
  const max = Number(o["maxAttempts"]);
  const backoff = Number(o["backoffMs"]);
  const mult = Number(o["backoffMultiplier"]);
  return {
    maxAttempts:
      Number.isFinite(max) && max >= 1
        ? Math.min(Math.floor(max), 10)
        : DEFAULT_MCP_POLICY.retry.maxAttempts,
    backoffMs:
      Number.isFinite(backoff) && backoff >= 0
        ? Math.min(Math.floor(backoff), 10_000)
        : DEFAULT_MCP_POLICY.retry.backoffMs,
    backoffMultiplier:
      Number.isFinite(mult) && mult >= 1
        ? Math.min(mult, 5)
        : DEFAULT_MCP_POLICY.retry.backoffMultiplier,
  };
}

async function resolveMcpPolicy(
  serverName: string,
  toolName: string,
  projectId?: string,
  definitionId?: string
): Promise<ResolvedMcpPolicy> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        eq(mcpToolBinding.serverName, serverName),
        eq(mcpToolBinding.enabled, true),
        or(eq(mcpToolBinding.toolName, toolName), eq(mcpToolBinding.toolName, "*")),
        projectId
          ? or(eq(mcpToolBinding.projectId, projectId), isNull(mcpToolBinding.projectId))
          : undefined
      )
    );
  const exact = pickBestBindingRow(rows, toolName, projectId, definitionId, true);
  if (!exact) return DEFAULT_MCP_POLICY;
  return {
    timeoutMs: exact.timeoutMs ?? DEFAULT_MCP_POLICY.timeoutMs,
    retry: parseRetryPolicy(exact.retryPolicyJson),
  };
}

async function assertToolBindingNotDisabled(
  serverName: string,
  toolName: string,
  projectId?: string,
  definitionId?: string
) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        eq(mcpToolBinding.serverName, serverName),
        projectId
          ? or(eq(mcpToolBinding.projectId, projectId), isNull(mcpToolBinding.projectId))
          : undefined
      )
    );
  const best = pickBestBindingRow(rows, toolName, projectId, definitionId, false);
  if (best && !best.enabled) {
    throw new Error(`mcp tool binding disabled: ${serverName}/${toolName}`);
  }
}

export async function dispatchMcpToolCall(input: McpDispatchInput): Promise<McpDispatchResult> {
  /**
   * P0-4：retry 不再硬编码 —— 真正读 `mcp_tool_binding.retryPolicyJson` 让用户在 UI
   * 改的策略生效。binding 没行 / 字段缺失就退回 DEFAULT_MCP_POLICY.retry。
   *
   * 在进 executeWithPolicy 之前就要查 binding，让 retry 策略和 timeoutMs 同步生效。
   */
  const policy = await resolveMcpPolicy(
    input.serverName,
    input.toolName,
    input.projectId,
    input.definitionId
  );
  /**
   * 监控 V2 P1：在内存熔断器之前再加一层 DB-层 fail-fast。
   *
   * 为什么两层都要：
   *   - 内存熔断（executeWithPolicy）：高频 / 低延迟，进程内反应敏捷；
   *   - DB 熔断（assertMcpServerNotOpen）：跨进程持久；前端能看到熔断态；
   *     重启后不会"假装健康"再被打到上游 RST。
   *
   * DB 异常时 assert 内部会自己 warn 并放行，所以不会因为监控故障误伤业务。
   */
  await assertMcpServerNotOpen(input.serverName);
  try {
    const dispatchResult = await executeWithPolicy(
      {
        scopeKey: `mcp:${input.serverName}:${input.toolName}`,
        retry: policy.retry,
        circuitBreaker: { failureThreshold: 3, cooldownMs: 30_000 },
        idempotency: {
          enabled: true,
          key: `mcp:${input.serverName}:${input.toolName}:${JSON.stringify(input.arguments ?? {})}`,
          ttlMs: 10_000,
        },
      },
      async () => {
        const db = await getDb();
        /**
         * 2026-05-27 P1 修复：之前 `eq(mcpServerConfig.projectId, null)` 在 SQL
         * 里展开成 `project_id = NULL`（NULL 三值逻辑下永远不为 true），导致
         * project-scoped workflow 调用 **global**（projectId IS NULL）的 mcp
         * server 时永远查不到 → 报 `not found or disabled`。
         * WF 9adf5d91 实测：def-analyst-fundamental 通过 call_mcp 调
         * mcp-financex 时被这条 bug 拦住，agent 误判"该 server 不可用"。
         * 改用 drizzle 的 `isNull()` 帮手生成正确的 `project_id IS NULL`.
         */
        const rows = await db
          .select()
          .from(mcpServerConfig)
          .where(
            and(
              eq(mcpServerConfig.name, input.serverName),
              eq(mcpServerConfig.enabled, true),
              input.projectId
                ? or(
                    eq(mcpServerConfig.projectId, input.projectId),
                    isNull(mcpServerConfig.projectId)
                  )
                : undefined
            )
          );
        const server =
          rows.find((row) => row.projectId === input.projectId) ??
          rows.find((row) => row.projectId == null);
        if (!server) {
          throw new Error(`mcp server "${input.serverName}" not found or disabled`);
        }

        await assertToolBindingNotDisabled(
          input.serverName,
          input.toolName,
          input.projectId,
          input.definitionId
        );
        const timeoutMs = policy.timeoutMs;
        const caps = server.capabilitiesJson;

        let result: unknown;
        if (server.transport === "stdio") {
          const rawArgv = stdioArgvFromServer(server.command, caps);
          /*
           * 把 `npx -y pkg@ver` 替换成绝对路径的 .bin。首次会触发 npm install 到
           * <dataDir>/mcp-bin，后续直接秒级启动。失败时 fallback 原 argv，让旧的
           * npx 行为继续可用（package-manager 内部已 console.warn 给运维定位）。
           */
          const resolved = await resolveMcpStdioArgv(rawArgv);
          const envObj = asRecord(asRecord(caps).env);
          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(envObj)) {
            if (typeof v === "string") env[k] = v;
          }
          /**
           * cwd 解析优先级（F-P0-07 fix，2026-06-04）：
           *   1) capabilities_json.cwd（用户显式声明，最高优先级）
           *   2) resolved.installDir（npx → .bin rewrite 时 package-manager 给出
           *      `<mcp-bin>/node_modules/<pkg>` —— 让相对 require / __dirname-relative
           *      file IO 工作目录与手动 `npx -y pkg` 行为一致）
           *   3) undefined（继承 backend cwd，老行为，仅用于非 npx 的纯绝对路径 argv）
           */
          const capsCwd =
            typeof asRecord(caps).cwd === "string" ? (asRecord(caps).cwd as string) : undefined;
          const cwd = capsCwd ?? resolved.installDir;
          result = await callMcpStdioTool({
            serverKey: input.serverName,
            argv: resolved.argv,
            env,
            cwd,
            requestTimeoutMs: timeoutMs,
            toolName: input.toolName,
            arguments: input.arguments ?? {},
          });
        } else if (server.transport === "http") {
          const url = httpEndpointFromServer(server.url, caps);
          const headers = httpHeadersFromCaps(caps);
          result = await callMcpHttpTool({
            postUrl: url,
            toolName: input.toolName,
            arguments: input.arguments ?? {},
            headers,
            timeoutMs,
          });
        } else if (server.transport === "ws") {
          if (!server.url) throw new Error("MCP ws: mcp_server_config.url is required");
          result = await callMcpWsTool({
            wsUrl: server.url,
            toolName: input.toolName,
            arguments: input.arguments ?? {},
            timeoutMs,
          });
        } else {
          throw new Error(`unsupported mcp transport: ${server.transport}`);
        }

        return {
          serverName: input.serverName,
          toolName: input.toolName,
          transport: server.transport,
          accepted: true,
          output: stringifyResult(result),
        };
      }
    );
    // 调用成功（含 idempotency cache 命中）：刷新 health 行为 closed + 累计 success
    await recordMcpCallResult(input.serverName, "success");
    return dispatchResult;
  } catch (err) {
    /**
     * 失败分类：
     *   - timeout：错误消息含 'timeout'（http-transport / stdio-session 抛错惯例）
     *   - 其他：failed
     * sandbox_blocked / 二级业务错误目前在 act.ts 那一层做更细分类，dispatcher 只看
     * 「请求是否打通」即可。
     */
    const msg = (err as Error)?.message ?? String(err);
    const status: "failed" | "timeout" = /timeout/i.test(msg) ? "timeout" : "failed";
    // assertMcpServerNotOpen 抛的"mcp circuit breaker open"不该再次记录（它本来就因为
    // health 是 open；再 recordMcpCallResult 会让 failureCount 二次膨胀）。
    if (!msg.startsWith("mcp circuit breaker open")) {
      await recordMcpCallResult(input.serverName, status, msg);
    }
    /**
     * E1 错误增强：当 MCP server 抛 `Unknown tool: <X>` 时，
     * 把 capabilities_json.tools 真实工具清单拼进错误消息，让 LLM 下一轮自纠正。
     * 不阻塞错误链路（即便查 DB 失败也保留原始 error）。
     */
    const enrichedErr = await tryEnrichUnknownToolError(err, input.serverName);
    throw enrichedErr ?? err;
  }
}

/**
 * 检测 MCP server 返回的 `Unknown tool` / UNKNOWN_TOOL 错误，
 * 把该 server 在 mcp_server_config.capabilities_json.tools 里登记的
 * 真实工具列表（如果有）追加到 error message 末尾，作为 LLM 下一轮的纠正线索。
 */
async function tryEnrichUnknownToolError(err: unknown, serverName: string): Promise<Error | null> {
  const msg = (err as Error)?.message ?? String(err);
  if (!/Unknown tool|UNKNOWN_TOOL/i.test(msg)) return null;
  try {
    const db = await getDb();
    const rows = await db
      .select({ capabilitiesJson: mcpServerConfig.capabilitiesJson })
      .from(mcpServerConfig)
      .where(and(eq(mcpServerConfig.name, serverName), isNull(mcpServerConfig.projectId)))
      .limit(1);
    const caps = rows[0]?.capabilitiesJson;
    if (!caps || typeof caps !== "object" || Array.isArray(caps)) return null;
    const toolsRaw = (caps as Record<string, unknown>)["tools"];
    if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) return null;
    const names: string[] = [];
    for (const item of toolsRaw) {
      if (item && typeof item === "object") {
        const name = (item as Record<string, unknown>)["name"];
        if (typeof name === "string" && name.trim()) names.push(name.trim());
      }
    }
    if (names.length === 0) return null;
    const enriched = new Error(
      `${msg}\n\n[mcp ${serverName} 真实工具清单] ${names.join(", ")}\n请从上述清单里选一个最匹配的 mcpTool 重试，不要再喊未列出的工具名。`
    );
    return enriched;
  } catch {
    return null;
  }
}
