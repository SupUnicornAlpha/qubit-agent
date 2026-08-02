/**
 * ToolAdmission owns every pre-execution decision. It may read policy/config
 * and write audit logs, but it never dispatches a tool. This keeps actNode as
 * a narrow coordinator: Plan → Admission → dedup → sandbox → Executor.
 */
import { isToolAllowedInAgentControlMode } from "../../agent-control-mode";
import { authorizeCapability, isCapabilityGateEnabled } from "../../tools/capability-gate";
import {
  buildRuntimeCapabilityManifestForRuntime,
  isToolBlockedByRuntimeCapability,
} from "../../tools/data-capability-manifest";
import { buildToolCallFingerprint } from "../../tools/tool-call-dedup";
import {
  recordToolCallError,
  recordToolCallSandboxBlocked,
  recordToolCallStart,
} from "../../tools/tool-call-log-service";
import { applyToolContract, isToolContractEnabled } from "../../tools/tool-contract";
import { getToolContract } from "../../tools/tool-contract-registry";
import { evaluateToolGovernance } from "../../tools/tool-governance-policy";
import { recordWorkflowDataGap } from "../../tools/workflow-artifact-ledger";
import type { AgentGraphState, StepStreamEvent } from "../state";
import type { ToolPlan } from "./tool-plan";

type AllowedAdmission = {
  ok: true;
  params: Record<string, unknown>;
  gateTimeoutMs: number | undefined;
  capabilityGateAllowed: boolean;
  toolContractName: string | undefined;
};

type DeniedAdmission = { ok: false; patch: Partial<AgentGraphState> };

export type ToolAdmission = AllowedAdmission | DeniedAdmission;

export async function admitTool(input: {
  state: AgentGraphState;
  emit: (event: StepStreamEvent) => void;
  plan: ToolPlan;
  projectId: string | undefined;
  agentMode: import("../../../types/loop").AgentControlMode;
  agentStepId: string;
  toolCallId: string;
}): Promise<ToolAdmission> {
  const { state, emit, plan } = input;
  let params = plan.params;
  const inboundPayload = state.inboundMessage.payload as Record<string, unknown>;
  const runtimeCapabilityManifest = await buildRuntimeCapabilityManifestForRuntime({
    tools: [plan.targetName],
    goal:
      typeof inboundPayload.goal === "string"
        ? inboundPayload.goal
        : typeof params.goal === "string"
          ? params.goal
          : null,
    ticker:
      typeof params.ticker === "string"
        ? params.ticker
        : typeof params.symbol === "string"
          ? params.symbol
          : null,
    symbol: typeof params.symbol === "string" ? params.symbol : null,
    exchange: typeof params.exchange === "string" ? params.exchange : null,
  });
  const capabilityUnavailable = isToolBlockedByRuntimeCapability(
    runtimeCapabilityManifest,
    plan.targetName
  );
  if (capabilityUnavailable) {
    const gap = {
      kind: capabilityUnavailable.status === "unconfigured" ? "unconfigured" : "no_coverage",
      market: runtimeCapabilityManifest.market,
      capability: plan.targetName,
      provider: plan.targetName.includes("/") ? (plan.targetName.split("/", 1)[0] ?? null) : null,
      reason: capabilityUnavailable.reason,
      retryable: false,
    } as const;
    const fingerprint = buildToolCallFingerprint({
      targetName: plan.targetName,
      params: mcpParamsOr(plan, params),
    });
    void recordWorkflowDataGap({
      workflowRunId: state.workflowId,
      fingerprint,
      toolName: plan.targetName,
      gap,
      producerTaskId: typeof inboundPayload.taskId === "string" ? inboundPayload.taskId : null,
    }).catch(() => {});
    return deny(state, emit, input.toolCallId, plan, {
      reason: capabilityUnavailable.reason,
      observation: {
        level: "warn",
        toolGovernance: true,
        capabilityManifest: true,
        code: capabilityUnavailable.code,
        dataGap: gap,
        message: capabilityUnavailable.reason,
        recovery: {
          nextAction: "switch_tool",
          allowSameToolRetry: false,
          guidance: "请改用已展示的可用工具，或明确配置该市场的实时数据 provider。",
        },
      },
    });
  }

  let gateTimeoutMs: number | undefined;
  let capabilityGateAllowed = false;
  if (isCapabilityGateEnabled()) {
    const gate = await authorizeCapability({
      name: plan.effectiveToolName,
      agentDefinition: state.agentDefinition,
      workflowId: state.workflowId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      agentMode: input.agentMode,
      ...(plan.mcp
        ? { isMcp: true, serverName: plan.mcp.serverName, mcpTool: plan.mcp.toolName }
        : {}),
    });
    if (!gate.ok) {
      const allowHint =
        gate.allowlist && gate.allowlist.length > 0
          ? ` allowed=[${gate.allowlist.join(", ")}]`
          : "";
      const reason = `${gate.message}.${allowHint} ${gate.hint}`.trim();
      const observation = {
        level: "warn" as const,
        toolGovernance: true,
        capabilityGate: true,
        code: gate.code,
        message: reason,
        recovery: {
          nextAction: "switch_tool" as const,
          allowSameToolRetry: false,
          ...(gate.allowlist ? { alternatives: gate.allowlist } : {}),
          guidance: gate.hint,
        },
      };
      await recordToolCallStart({
        toolCallId: input.toolCallId,
        agentStepId: input.agentStepId,
        workflowRunId: state.workflowId,
        traceId: state.traceId,
        agentDefinitionId: state.agentDefinition.id,
        targetName: plan.targetName,
        toolKind: plan.toolKind,
        targetKind: plan.targetKind,
        ...(plan.mcp ? { mcp: plan.mcp } : {}),
        reasonText: state.reasonText ?? "",
        contextMemory: state.contextMemory,
        governance: { capabilityGate: "denied" },
      });
      await recordToolCallSandboxBlocked({
        toolCallId: input.toolCallId,
        hasMcp: Boolean(plan.mcp),
        reason,
        violationType: gate.code,
        capabilityGate: true,
      });
      emitToolEnd(state, emit, input.toolCallId, plan, reason, {
        capabilityGate: true,
        code: gate.code,
      });
      return deny(state, emit, input.toolCallId, plan, { reason, observation });
    }
    gateTimeoutMs = gate.timeoutMs;
    capabilityGateAllowed = true;
  }

  let toolContractName: string | undefined;
  if (isToolContractEnabled() && !plan.mcp) {
    const contract = getToolContract(plan.effectiveToolName);
    if (contract) {
      toolContractName = contract.name;
      try {
        params = applyToolContract(contract, params);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const observation = {
          level: "warn" as const,
          toolGovernance: true,
          toolContract: true,
          code: "TOOL_CONTRACT_VALIDATION_FAILED",
          message: reason,
          recovery: {
            nextAction: "switch_tool" as const,
            allowSameToolRetry: false,
            guidance: "请按工具契约修正参数（例如使用 symbol 或 symbols[]），不要原样重试。",
          },
        };
        await recordToolCallStart({
          toolCallId: input.toolCallId,
          agentStepId: input.agentStepId,
          workflowRunId: state.workflowId,
          traceId: state.traceId,
          agentDefinitionId: state.agentDefinition.id,
          targetName: plan.targetName,
          toolKind: plan.toolKind,
          targetKind: plan.targetKind,
          reasonText: state.reasonText ?? "",
          contextMemory: state.contextMemory,
          governance: {
            ...(capabilityGateAllowed ? { capabilityGate: "allowed" } : {}),
            contractName: contract.name,
            contractRejected: true,
          },
        });
        await recordToolCallError({
          toolCallId: input.toolCallId,
          hasMcp: false,
          latencyMs: 0,
          errorSource: plan.connectorTarget ? "connector" : "builtin",
          errorMessage: reason,
          contractCode: reason.split(":", 1)[0] ?? "contract_validation_failed",
          contractRejected: true,
        });
        emitToolEnd(state, emit, input.toolCallId, plan, reason, {
          toolContract: true,
          status: "error",
        });
        return deny(state, emit, input.toolCallId, plan, { reason, observation });
      }
    }
  }

  if (!isToolAllowedInAgentControlMode(input.agentMode, plan.effectiveToolName)) {
    const reason = `Plan 模式只允许 update_plan；工具 ${plan.targetName} 已被运行时拦截。请先形成计划，不要执行任务。`;
    return deny(state, emit, input.toolCallId, plan, {
      reason,
      observation: {
        level: "warn",
        toolGovernance: true,
        controlModeGate: true,
        code: "PLAN_MODE_EXECUTION_BLOCKED",
        agentMode: input.agentMode,
        message: reason,
        recovery: {
          nextAction: "switch_tool",
          allowSameToolRetry: false,
          alternatives: ["update_plan"],
          guidance: "改用 update_plan 保存计划；随后用 tool=none 返回计划说明。",
        },
      },
    });
  }

  const governance = evaluateToolGovernance({
    workflowId: state.workflowId,
    targetName: plan.targetName,
    params: mcpParamsOr(plan, params),
  });
  if (!governance.allowed) {
    return deny(state, emit, input.toolCallId, plan, {
      reason: governance.reason,
      observation: {
        level: "warn",
        toolGovernance: true,
        code: governance.code,
        market: governance.market,
        message: governance.reason,
        recovery: {
          nextAction: "switch_tool",
          allowSameToolRetry: false,
          guidance: governance.reason,
        },
      },
    });
  }

  return { ok: true, params, gateTimeoutMs, capabilityGateAllowed, toolContractName };
}

function mcpParamsOr(plan: ToolPlan, params: Record<string, unknown>): Record<string, unknown> {
  return plan.mcp?.arguments ?? params;
}

function emitToolEnd(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  toolCallId: string,
  plan: ToolPlan,
  reason: string,
  extra: Record<string, unknown>
): void {
  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "tool_call_end",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: {
      toolCallId,
      status: "blocked_by_sandbox",
      reason,
      targetKind: plan.targetKind,
      targetName: plan.targetName,
      ...extra,
    },
  });
}

function deny(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  toolCallId: string,
  plan: ToolPlan,
  input: { reason?: string; observation: Record<string, unknown> }
): DeniedAdmission {
  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "observe",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: input.observation,
  });
  return {
    ok: false,
    patch: {
      toolCalls: [
        ...state.toolCalls,
        {
          toolCallId,
          toolName: plan.targetName,
          status: "governance_blocked",
          ...(input.reason ? { reason: input.reason } : {}),
        },
      ],
      observations: [...state.observations, input.observation],
    },
  };
}
