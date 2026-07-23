import { getDb } from "../db/sqlite/client";
import { sandboxPolicy, sandboxViolationLog } from "../db/sqlite/schema";
import type { RuntimeAgentDefinition } from "./types";
import { eq } from "drizzle-orm";
import { isAgentControlPlaneTool } from "./agent-control-mode";
import { resolveConnectorForTool } from "./tools/tool-routes";

type SandboxViolationType =
  | "tool_not_allowed"
  | "mcp_not_allowed"
  | "network_blocked"
  | "fs_blocked"
  | "timeout"
  | "iteration_exceeded";

export interface LoadedSandboxPolicy {
  id: string;
  allowedTools: Set<string>;
  allowedMcpServers: Set<string>;
  allowedConnectors: Set<string>;
  allowedHosts: Set<string>;
  allowedFsPaths: string[];
  maxToolCallMs: number;
  maxIterationsPerRun: number;
}

/**
 * 授权判定单一事实源（治理 #3）。
 *
 * 原先这三条规则被复制在 4 处：filterAuthorizedTools（reason 前移裁剪）+
 * checkToolCall / checkConnectorCall / checkMcpCall（act 阶段兜底）。filter 与
 * check 物理分离、靠注释「必须同构」人肉维持一致 —— 改一处忘改另一处就会出现
 * 「prompt 说可用、act 又拒」的漂移。现在收口到这三个纯函数，filter 与 check
 * 全部委托给它们，规则只有一份定义。
 *
 * 注意：connector 工具的判定需要先 resolveConnectorForTool(name) 拿到 connector，
 * 这一步由调用方（filterAuthorizedTools / act 的 connectorTarget 分支）完成，
 * 这里只接收已 resolve 出的 connector 名。
 */
export function isToolAuthorized(policy: LoadedSandboxPolicy, toolName: string): boolean {
  // update_plan 等 harness 控制面能力只写当前 workflow 内部状态，不应被业务白名单误杀。
  return isAgentControlPlaneTool(toolName) || policy.allowedTools.has(toolName);
}

export function isConnectorAuthorized(policy: LoadedSandboxPolicy, connectorName: string): boolean {
  // 空集 = 不限制 connector（放行全部）；非空 = 白名单
  return policy.allowedConnectors.size === 0 || policy.allowedConnectors.has(connectorName);
}

export function isMcpAuthorized(policy: LoadedSandboxPolicy, serverName: string): boolean {
  return policy.allowedMcpServers.has(serverName);
}

export interface SandboxCheckInput {
  runId: string;
  workflowId: string;
  traceId: string;
  agentInstanceId: string;
  toolName: string;
  payload: Record<string, unknown>;
  definition: RuntimeAgentDefinition;
}

export interface SandboxCheckResult {
  allowed: boolean;
  violationType?: SandboxViolationType;
  reason?: string;
  policySnapshot?: Record<string, unknown>;
}

export interface SandboxBaseCheckInput {
  runId: string;
  workflowId: string;
  traceId: string;
  agentInstanceId: string;
  definition: RuntimeAgentDefinition;
  payload?: Record<string, unknown>;
}

export class SandboxExecutor {
  async loadPolicy(definition: RuntimeAgentDefinition): Promise<LoadedSandboxPolicy> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(sandboxPolicy)
      .where(eq(sandboxPolicy.id, definition.sandboxPolicyId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      // Missing policy should fail closed.
      return {
        id: definition.sandboxPolicyId,
        allowedTools: new Set<string>(),
        allowedMcpServers: new Set<string>(),
        allowedConnectors: new Set<string>(),
        allowedHosts: new Set<string>(),
        allowedFsPaths: [],
        maxToolCallMs: 30_000,
        maxIterationsPerRun: Math.max(1, definition.maxIterations),
      };
    }

    return {
      id: row.id,
      allowedTools: new Set(
        this.parseStringArray(row.allowedToolsJson).length > 0
          ? this.parseStringArray(row.allowedToolsJson)
          : definition.tools
      ),
      allowedMcpServers: new Set(
        this.parseStringArray(row.allowedMcpServersJson).length > 0
          ? this.parseStringArray(row.allowedMcpServersJson)
          : definition.mcpServers
      ),
      allowedConnectors: new Set(this.parseStringArray(row.allowedConnectorsJson)),
      allowedHosts: new Set(this.parseStringArray(row.allowedHostsJson)),
      allowedFsPaths: this.parseStringArray(row.allowedFsPathsJson),
      maxToolCallMs: row.maxToolCallMs ?? 30_000,
      maxIterationsPerRun: row.maxIterationsPerRun ?? definition.maxIterations,
    };
  }

  /**
   * 授权前移（治理 #1）：在 reason 组装 prompt 之前，把候选工具/MCP server 列表
   * 按 sandbox policy 裁剪到「真正可调用」的子集，只把它们注入 prompt。
   *
   * 动机：原先 allow-list 只在 act 阶段（LLM 已生成 tool_call 之后）才校验，
   * 被拒的工具仍会出现在 prompt「可用工具」块里，LLM 反复挑被禁工具 → 每次
   * 浪费一整轮 reason + 一条 sandbox_blocked 日志。前移后 LLM 根本看不到禁用工具。
   *
   * **与 check*Call 的判定完全同构**（治理 #3：现已物理共享 isToolAuthorized /
   * isConnectorAuthorized / isMcpAuthorized 三个纯函数，不再靠人肉维持一致）：
   *   - builtin / 自定义 tool 名：isToolAuthorized（对应 checkToolCall）
   *   - connector 路由的 tool 名：isConnectorAuthorized（对应 checkConnectorCall）
   *   - MCP server：isMcpAuthorized（对应 checkMcpCall）
   *
   * act 阶段的 check*Call 仍然保留，作为 deny-by-default 的防御性兜底
   * （prompt 注入与实际执行之间策略可能热更新 / LLM 仍可能瞎喊未列出名）。
   */
  async filterAuthorizedTools(
    definition: RuntimeAgentDefinition,
    candidateTools: string[],
    candidateMcpServers: string[]
  ): Promise<{ tools: string[]; mcpServers: string[] }> {
    const policy = await this.loadPolicy(definition);
    const tools = candidateTools.filter((name) => {
      const connector = resolveConnectorForTool(name);
      // connector 路由工具走 connector 判定；其余走 builtin/自定义判定。
      // 二者与 act 的 check*Call 共用同一组纯函数（治理 #3）。
      return connector ? isConnectorAuthorized(policy, connector) : isToolAuthorized(policy, name);
    });
    const mcpServers = candidateMcpServers.filter((name) => isMcpAuthorized(policy, name));
    return { tools, mcpServers };
  }

  async checkToolCall(input: SandboxCheckInput): Promise<SandboxCheckResult> {
    const policy = await this.loadPolicy(input.definition);
    if (isToolAuthorized(policy, input.toolName)) {
      return {
        allowed: true,
        policySnapshot: { sandboxPolicyId: policy.id, maxToolCallMs: policy.maxToolCallMs },
      };
    }

    await this.logViolation({
      workflowId: input.workflowId,
      agentInstanceId: input.agentInstanceId,
      sandboxPolicyId: policy.id,
      violationType: "tool_not_allowed",
      attemptedAction: {
        runId: input.runId,
        traceId: input.traceId,
        toolName: input.toolName,
        payload: input.payload,
      },
    });

    return {
      allowed: false,
      violationType: "tool_not_allowed",
      reason: `tool "${input.toolName}" is not allowed by sandbox policy`,
      policySnapshot: { sandboxPolicyId: policy.id },
    };
  }

  async checkMcpCall(
    input: SandboxBaseCheckInput & {
      serverName: string;
    }
  ): Promise<SandboxCheckResult> {
    const policy = await this.loadPolicy(input.definition);
    if (isMcpAuthorized(policy, input.serverName))
      return { allowed: true, policySnapshot: { sandboxPolicyId: policy.id } };

    await this.logViolation({
      workflowId: input.workflowId,
      agentInstanceId: input.agentInstanceId,
      sandboxPolicyId: policy.id,
      violationType: "mcp_not_allowed",
      attemptedAction: {
        runId: input.runId,
        traceId: input.traceId,
        serverName: input.serverName,
        payload: input.payload ?? {},
      },
    });
    return {
      allowed: false,
      violationType: "mcp_not_allowed",
      reason: `mcp server "${input.serverName}" is not allowed by sandbox policy`,
      policySnapshot: { sandboxPolicyId: policy.id },
    };
  }

  async checkConnectorCall(
    input: SandboxBaseCheckInput & {
      connectorName: string;
    }
  ): Promise<SandboxCheckResult> {
    const policy = await this.loadPolicy(input.definition);
    if (isConnectorAuthorized(policy, input.connectorName))
      return { allowed: true, policySnapshot: { sandboxPolicyId: policy.id } };

    await this.logViolation({
      workflowId: input.workflowId,
      agentInstanceId: input.agentInstanceId,
      sandboxPolicyId: policy.id,
      violationType: "mcp_not_allowed",
      attemptedAction: {
        runId: input.runId,
        traceId: input.traceId,
        connectorName: input.connectorName,
        payload: input.payload ?? {},
      },
    });
    return {
      allowed: false,
      violationType: "mcp_not_allowed",
      reason: `connector "${input.connectorName}" is not allowed by sandbox policy`,
      policySnapshot: { sandboxPolicyId: policy.id },
    };
  }

  async checkNetworkHost(
    input: SandboxBaseCheckInput & {
      host: string;
    }
  ): Promise<SandboxCheckResult> {
    const policy = await this.loadPolicy(input.definition);
    const allowed = policy.allowedHosts.size === 0 || policy.allowedHosts.has(input.host);
    if (allowed) return { allowed: true, policySnapshot: { sandboxPolicyId: policy.id } };

    await this.logViolation({
      workflowId: input.workflowId,
      agentInstanceId: input.agentInstanceId,
      sandboxPolicyId: policy.id,
      violationType: "network_blocked",
      attemptedAction: {
        runId: input.runId,
        traceId: input.traceId,
        host: input.host,
        payload: input.payload ?? {},
      },
    });
    return {
      allowed: false,
      violationType: "network_blocked",
      reason: `host "${input.host}" is blocked by sandbox policy`,
      policySnapshot: { sandboxPolicyId: policy.id },
    };
  }

  async checkFsPath(
    input: SandboxBaseCheckInput & {
      fsPath: string;
    }
  ): Promise<SandboxCheckResult> {
    const policy = await this.loadPolicy(input.definition);
    const allowed =
      policy.allowedFsPaths.length === 0 ||
      policy.allowedFsPaths.some(
      (prefix) => input.fsPath === prefix || input.fsPath.startsWith(`${prefix}/`)
      );
    if (allowed) return { allowed: true, policySnapshot: { sandboxPolicyId: policy.id } };

    await this.logViolation({
      workflowId: input.workflowId,
      agentInstanceId: input.agentInstanceId,
      sandboxPolicyId: policy.id,
      violationType: "fs_blocked",
      attemptedAction: {
        runId: input.runId,
        traceId: input.traceId,
        fsPath: input.fsPath,
        payload: input.payload ?? {},
      },
    });
    return {
      allowed: false,
      violationType: "fs_blocked",
      reason: `fs path "${input.fsPath}" is blocked by sandbox policy`,
      policySnapshot: { sandboxPolicyId: policy.id },
    };
  }

  async checkIterationLimit(
    input: SandboxBaseCheckInput & {
      currentIteration: number;
    }
  ): Promise<SandboxCheckResult> {
    const policy = await this.loadPolicy(input.definition);
    if (input.currentIteration <= policy.maxIterationsPerRun) {
      return {
        allowed: true,
        policySnapshot: {
          sandboxPolicyId: policy.id,
          maxIterationsPerRun: policy.maxIterationsPerRun,
        },
      };
    }

    await this.logViolation({
      workflowId: input.workflowId,
      agentInstanceId: input.agentInstanceId,
      sandboxPolicyId: policy.id,
      violationType: "iteration_exceeded",
      attemptedAction: {
        runId: input.runId,
        traceId: input.traceId,
        currentIteration: input.currentIteration,
        maxIterationsPerRun: policy.maxIterationsPerRun,
      },
    });
    return {
      allowed: false,
      violationType: "iteration_exceeded",
      reason: `iteration ${input.currentIteration} exceeded sandbox max ${policy.maxIterationsPerRun}`,
      policySnapshot: {
        sandboxPolicyId: policy.id,
        maxIterationsPerRun: policy.maxIterationsPerRun,
      },
    };
  }

  async enforceToolTimeout<T>(
    input: SandboxBaseCheckInput & {
      timeoutMs?: number;
      action: () => Promise<T>;
      meta?: Record<string, unknown>;
    }
  ): Promise<{ ok: true; value: T } | { ok: false; result: SandboxCheckResult }> {
    const policy = await this.loadPolicy(input.definition);
    const timeoutMs = input.timeoutMs ?? policy.maxToolCallMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("SANDBOX_TOOL_TIMEOUT")), timeoutMs);
      });
      const value = await Promise.race([input.action(), timeoutPromise]);
      return { ok: true, value: value as T };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "SANDBOX_TOOL_TIMEOUT") {
        throw error;
      }
      await this.logViolation({
        workflowId: input.workflowId,
        agentInstanceId: input.agentInstanceId,
        sandboxPolicyId: policy.id,
        violationType: "timeout",
        attemptedAction: {
          runId: input.runId,
          traceId: input.traceId,
          timeoutMs,
          meta: input.meta ?? {},
        },
      });
      return {
        ok: false,
        result: {
          allowed: false,
          violationType: "timeout",
          reason: `tool call exceeded timeout ${timeoutMs}ms`,
          policySnapshot: { sandboxPolicyId: policy.id, timeoutMs },
        },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async logViolation(params: {
    workflowId: string;
    agentInstanceId: string;
    sandboxPolicyId: string;
    violationType: SandboxViolationType;
    attemptedAction: Record<string, unknown>;
  }): Promise<void> {
    const db = await getDb();
    await db.insert(sandboxViolationLog).values({
      id: crypto.randomUUID(),
      workflowRunId: params.workflowId,
      agentInstanceId: params.agentInstanceId,
      sandboxPolicyId: params.sandboxPolicyId,
      violationType: params.violationType,
      attemptedAction: params.attemptedAction,
    });
  }

  private parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.filter((item): item is string => typeof item === "string");
        }
      } catch {
        return [];
      }
    }
    return [];
  }
}

export const sandboxExecutor = new SandboxExecutor();
