/**
 * 团队 slot 传输层抽象（Runtime 4.5 第二批 · A2A / inprocess 收敛）。
 *
 * 分析师 wave 与 aux 后置角色共用同一 executor 接口；ReAct 内核仍是
 * `runResearchTeamSlotReact`，仅 transport 不同。
 */

import { getA2APool } from "../a2a/a2a-pool";
import { config } from "../../config";
import type { RawAnalystSignal } from "./signal-fusion";
import { runResearchTeamSlotReact } from "./analyst-team-slot-react";
import {
  dispatchSlotsViaA2A,
  type SlotDispatchResult,
  type SlotReactOut,
  type TeamSlotDispatchSpec,
} from "./team-slot-a2a";

export const DEFAULT_TEAM_SLOT_TIMEOUT_MS = 1_200_000;

/** wave 处理统一的 slot 结果（analyst JSON / markdown 降级）。 */
export type SlotResult =
  | { kind: "analyst"; payload: RawAnalystSignal & { agentInstanceId?: string } }
  | { kind: "missing_signal"; agentInstanceId?: string; body: string };

export interface TeamSlotExecutor {
  readonly transport: "a2a" | "inprocess";
  dispatchWave(specs: TeamSlotDispatchSpec[]): Promise<Map<string, SlotDispatchResult>>;
}

export function slotReactOutToSlotResult(reactOut: SlotReactOut): SlotResult {
  if (reactOut.kind === "analyst") {
    return { kind: "analyst", payload: reactOut.payload };
  }
  return {
    kind: "missing_signal",
    ...(reactOut.agentInstanceId !== undefined ? { agentInstanceId: reactOut.agentInstanceId } : {}),
    body: reactOut.body,
  };
}

export function mapDispatchResultsToWaveResults(
  orderedSpecs: Array<{ instanceId: string }>,
  dispatchResults: Map<string, SlotDispatchResult>
): PromiseSettledResult<SlotResult>[] {
  return orderedSpecs.map((spec): PromiseSettledResult<SlotResult> => {
    const r = dispatchResults.get(spec.instanceId);
    if (r?.ok) {
      return { status: "fulfilled", value: slotReactOutToSlotResult(r.reactOut) };
    }
    return { status: "rejected", reason: new Error(r?.error ?? "slot_dispatch_failed") };
  });
}

class InProcessTeamSlotExecutor implements TeamSlotExecutor {
  readonly transport = "inprocess" as const;

  async dispatchWave(specs: TeamSlotDispatchSpec[]): Promise<Map<string, SlotDispatchResult>> {
    const out = new Map<string, SlotDispatchResult>();
    await Promise.all(
      specs.map(async (spec) => {
        try {
          const reactOut = await runResearchTeamSlotReact({
            workflowRunId: spec.workflowRunId ?? "",
            definitionId: spec.definitionId,
            role: spec.role,
            systemPrompt: spec.systemPrompt,
            ticker: spec.ticker,
            ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
            context: spec.context,
            agentInstanceId: spec.instanceId,
            expectJsonSignal: spec.expectJsonSignal,
            reactDepth: spec.reactDepth,
            ...(spec.groupConstraintHint !== undefined
              ? { groupConstraintHint: spec.groupConstraintHint }
              : {}),
          });
          out.set(spec.instanceId, { ok: true, reactOut });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          out.set(spec.instanceId, { ok: false, error: message });
        }
      })
    );
    return out;
  }
}

class A2ATeamSlotExecutor implements TeamSlotExecutor {
  readonly transport = "a2a" as const;

  constructor(
    private readonly workflowRunId: string,
    private readonly traceId: string,
    private readonly orchestratorInstanceId: string,
    private readonly timeoutMs: number
  ) {}

  async dispatchWave(specs: TeamSlotDispatchSpec[]): Promise<Map<string, SlotDispatchResult>> {
    return dispatchSlotsViaA2A({
      workflowRunId: this.workflowRunId,
      traceId: this.traceId,
      orchestratorInstanceId: this.orchestratorInstanceId,
      slots: specs,
      timeoutMs: this.timeoutMs,
    });
  }
}

/** 解析团队 slot 是否走 A2A 传输（与 analyst-team 历史逻辑等价）。 */
export function resolveTeamSlotTransport(input: {
  slotCount: number;
  teamExecutionPath?: string;
}): { useA2a: boolean; orchestratorInstanceId: string | null } {
  const path = input.teamExecutionPath ?? config.teamExecutionPath;
  const teamA2aEnabled = path === "a2a" && input.slotCount > 0;
  if (!teamA2aEnabled) {
    return { useA2a: false, orchestratorInstanceId: null };
  }
  try {
    const orchestratorInstanceId = getA2APool().getInstanceIdForRole("orchestrator");
    return { useA2a: true, orchestratorInstanceId };
  } catch {
    return { useA2a: false, orchestratorInstanceId: null };
  }
}

export function createTeamSlotExecutor(input: {
  workflowRunId: string;
  traceId: string;
  useA2a: boolean;
  orchestratorInstanceId: string | null;
  timeoutMs?: number;
}): TeamSlotExecutor {
  if (input.useA2a && input.orchestratorInstanceId) {
    return new A2ATeamSlotExecutor(
      input.workflowRunId,
      input.traceId,
      input.orchestratorInstanceId,
      input.timeoutMs ?? DEFAULT_TEAM_SLOT_TIMEOUT_MS
    );
  }
  return new InProcessTeamSlotExecutor();
}

/** 把 wave 上下文 + slot 元数据展平为 dispatch spec（两条 transport 共用）。 */
export function buildTeamSlotDispatchSpecs(input: {
  workflowRunId: string;
  ticker: string;
  scope?: TeamSlotDispatchSpec["scope"];
  reactDepth: TeamSlotDispatchSpec["reactDepth"];
  waveSpecs: Array<{
    slot: {
      definitionId: string;
      role: TeamSlotDispatchSpec["role"];
      systemPrompt: string;
    };
    ctx: string;
    preInstanceId?: string;
    groupConstraintHint?: string;
  }>;
}): TeamSlotDispatchSpec[] {
  return input.waveSpecs.map((ws) => ({
    instanceId: ws.preInstanceId as string,
    definitionId: ws.slot.definitionId,
    role: ws.slot.role,
    systemPrompt: ws.slot.systemPrompt,
    ticker: input.ticker,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    context: ws.ctx,
    expectJsonSignal: true,
    reactDepth: input.reactDepth,
    workflowRunId: input.workflowRunId,
    ...(ws.groupConstraintHint !== undefined ? { groupConstraintHint: ws.groupConstraintHint } : {}),
  }));
}

/** aux / 单 slot markdown 路径的 dispatch spec 构建。 */
export function buildAuxSlotDispatchSpec(input: {
  workflowRunId: string;
  instanceId: string;
  definitionId: string;
  role: TeamSlotDispatchSpec["role"];
  systemPrompt: string;
  ticker: string;
  scope?: TeamSlotDispatchSpec["scope"];
  context: string;
  reactDepth: TeamSlotDispatchSpec["reactDepth"];
  groupConstraintHint?: string;
}): TeamSlotDispatchSpec {
  return {
    instanceId: input.instanceId,
    definitionId: input.definitionId,
    role: input.role,
    systemPrompt: input.systemPrompt,
    ticker: input.ticker,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    context: input.context,
    expectJsonSignal: false,
    reactDepth: input.reactDepth,
    workflowRunId: input.workflowRunId,
    ...(input.groupConstraintHint !== undefined
      ? { groupConstraintHint: input.groupConstraintHint }
      : {}),
  };
}

export async function dispatchAuxSlotMarkdown(
  executor: TeamSlotExecutor,
  spec: TeamSlotDispatchSpec
): Promise<string> {
  const results = await executor.dispatchWave([spec]);
  const r = results.get(spec.instanceId);
  if (r?.ok && r.reactOut.kind === "markdown") return r.reactOut.body;
  return "";
}
