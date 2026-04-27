import { getDb } from "../db/sqlite/client";
import { sandboxPolicy, sandboxViolationLog } from "../db/sqlite/schema";
import type { RuntimeAgentDefinition } from "./types";
import { eq } from "drizzle-orm";

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

  async checkToolCall(input: SandboxCheckInput): Promise<SandboxCheckResult> {
    const policy = await this.loadPolicy(input.definition);
    const allowed = policy.allowedTools.has(input.toolName);
    if (allowed) {
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
    const allowed = policy.allowedMcpServers.has(input.serverName);
    if (allowed) return { allowed: true, policySnapshot: { sandboxPolicyId: policy.id } };

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
    const allowed =
      policy.allowedConnectors.size === 0 || policy.allowedConnectors.has(input.connectorName);
    if (allowed) return { allowed: true, policySnapshot: { sandboxPolicyId: policy.id } };

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

