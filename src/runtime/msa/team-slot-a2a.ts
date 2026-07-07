/**
 * 研究团队 analyst slot 的 A2A 传输层。
 *
 * 把「orchestrator → analyst → orchestrator」这一步从进程内函数调用（历史
 * `runAnalystTeam` 的 `Promise.allSettled(runResearchTeamSlotReact)`）改成 A2A
 * 总线上的真实往返：
 *
 *   - {@link spawnTeamSlotRuntimes}：为本 workflow 的每个 analyst 专属实例起一个
 *     `AgentRuntime`（instanceId 绑定、instanceOnlyRouting）。这样发给该实例
 *     UUID 的 `TASK_ASSIGN` 才有 runtime 接收（pool 每个 role 只有一个常驻
 *     runtime，绑在 pool workflow 上，收不到专属实例的消息）。
 *   - {@link createTeamSlotHandler}：runtime 收到 `analyst_team_slot_a2a` 任务时调
 *     `runResearchTeamSlotReact`（分析师的实际 ReAct 行为完全复用、不变），把结果
 *     序列化进 `TASK_RESULT` 回给 sender（orchestrator 实例）。
 *   - {@link dispatchSlotsViaA2A}：orchestrator 侧——先用 gather 登记 taskId、再
 *     `a2aRouter.send` 把整 wave 的 TASK_ASSIGN 发出、await 回包，按实例还原成与
 *     `runResearchTeamSlotReact` 完全一致的返回形状给上层处理。
 *
 * 行为风险低：分析师怎么跑没变，只是改了「派单/回包」的传输方式，并因此让
 * `a2a_message` 表 + 拓扑视图出现真实的 orchestrator↔analyst 连线。
 */

import { randomUUID } from "node:crypto";
import { a2aRouter } from "../../messaging/a2a";
import type { TaskAssignPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import type { NormalizedResearchScope } from "../../types/research-scope";
import { getA2AGather } from "../a2a/a2a-gather";
import { buildTaskResult } from "../a2a/task-result";
import { AgentRuntime } from "../agent-runtime";
import type { RuntimeAgentDefinition, RuntimeRoleHandler } from "../types";
import { type AnalystReactDepth, runResearchTeamSlotReact } from "./analyst-team-slot-react";
import type { RawAnalystSignal } from "./signal-fusion";

/** A2A 团队 slot 任务类型（区别于 executeAgentReact 内部 payload 的 "analyst_team_slot"）。 */
export const TEAM_SLOT_A2A_TASK_TYPE = "analyst_team_slot_a2a";

/** `runResearchTeamSlotReact` 的返回形状（A2A 往返两端共用）。 */
export type SlotReactOut =
  | { kind: "analyst"; payload: RawAnalystSignal & { agentInstanceId?: string } }
  | { kind: "markdown"; body: string; agentInstanceId?: string };

/** 单 slot 派单所需的全部入参（orchestrator 侧 → analyst 侧透传）。 */
export interface TeamSlotDispatchSpec {
  /** 本 workflow 为该 slot 预创建的 agent_instance.id（消息寻址 + step 归属）。 */
  instanceId: string;
  definitionId: string;
  role: AgentRole;
  systemPrompt: string;
  ticker: string;
  scope?: NormalizedResearchScope;
  /** 已拼好前置成员结论 appendix 的完整上下文。 */
  context: string;
  expectJsonSignal: boolean;
  reactDepth: AnalystReactDepth;
  groupConstraintHint?: string;
  /** inprocess 传输使用；A2A 路径由 dispatch 入参 workflowRunId 提供 */
  workflowRunId?: string;
}

/** dispatch 结果：ok=true 带 reactOut；ok=false 等价于历史 Promise.allSettled 的 rejected。 */
export type SlotDispatchResult =
  | { ok: true; reactOut: SlotReactOut }
  | { ok: false; error: string };

interface TeamSlotParams {
  definitionId: string;
  role: AgentRole;
  systemPrompt: string;
  ticker: string;
  scope?: NormalizedResearchScope;
  context: string;
  expectJsonSignal: boolean;
  reactDepth: AnalystReactDepth;
  groupConstraintHint?: string;
}

// ─── analyst 侧：runtime + handler ───────────────────────────────────────────

/** 给临时 analyst runtime 用的最小 def——只需订阅 TASK_ASSIGN + 绑 role/instanceId。 */
function minimalSlotDefinition(definitionId: string, role: AgentRole): RuntimeAgentDefinition {
  return {
    id: definitionId,
    role,
    name: `team-slot-${role}`,
    version: "team-a2a",
    systemPrompt: "",
    tools: [],
    mcpServers: [],
    skills: [],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "",
    maxIterations: 8,
    sandboxPolicyId: "",
    enabled: true,
  };
}

/**
 * 团队 slot handler：收到 `analyst_team_slot_a2a` 任务 → 跑 `runResearchTeamSlotReact`
 * → 把 SlotReactOut 装进 TASK_RESULT 回给 sender。
 *
 * 失败不抛：序列化成 `success=false` 回执，让 orchestrator 侧 gather 收得到（抛出去
 * 只会被 bus 的 error 事件吞掉、上层永远等到超时）。
 */
export function createTeamSlotHandler(): RuntimeRoleHandler {
  return {
    onMessage: async (ctx, msg) => {
      if (msg.messageType !== "TASK_ASSIGN") return;
      const payload = msg.payload as TaskAssignPayload;
      if (payload.taskType !== TEAM_SLOT_A2A_TASK_TYPE) return;
      const p = payload.params as unknown as TeamSlotParams;

      const reply = (success: boolean, result: Record<string, unknown>, errorMessage?: string) =>
        ctx.send({
          workflowId: msg.workflowId,
          traceId: msg.traceId,
          receiverAgent: msg.senderAgent,
          messageType: "TASK_RESULT",
          payload: buildTaskResult(payload.taskId, p.role, {
            success,
            result,
            ...(errorMessage !== undefined ? { errorMessage } : {}),
          }),
          priority: msg.priority,
        });

      try {
        const reactOut = await runResearchTeamSlotReact({
          workflowRunId: msg.workflowId,
          definitionId: p.definitionId,
          role: p.role,
          systemPrompt: p.systemPrompt,
          ticker: p.ticker,
          ...(p.scope !== undefined ? { scope: p.scope } : {}),
          context: p.context,
          // runtime 的 instance 就是本 workflow 预创建的 analyst 专属实例 → step 正确归属
          agentInstanceId: ctx.instance.instanceId,
          expectJsonSignal: p.expectJsonSignal,
          reactDepth: p.reactDepth,
          ...(p.groupConstraintHint !== undefined
            ? { groupConstraintHint: p.groupConstraintHint }
            : {}),
        });
        await reply(true, { reactOut: reactOut as unknown as Record<string, unknown> });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await reply(false, { slotError: true, message }, message);
      }
    },
  };
}

export interface TeamSlotScope {
  /** 停掉本 workflow 起的所有临时 analyst runtime（解订阅）。 */
  stopAll: () => Promise<void>;
}

/**
 * 为本 workflow 的每个 analyst 专属实例起一个临时 `AgentRuntime`，使其能在 A2A 总线上
 * 按 instanceId 收到 `TASK_ASSIGN`。返回的 scope.stopAll() 必须在团队跑完后调用。
 */
export async function spawnTeamSlotRuntimes(
  slots: Array<{ instanceId: string; definitionId: string; role: AgentRole }>
): Promise<TeamSlotScope> {
  const handler = createTeamSlotHandler();
  const runtimes: AgentRuntime[] = [];
  for (const slot of slots) {
    const runtime = new AgentRuntime(minimalSlotDefinition(slot.definitionId, slot.role), handler, {
      instanceId: slot.instanceId,
      instanceOnlyRouting: true,
    });
    await runtime.start();
    runtimes.push(runtime);
  }
  return {
    stopAll: async () => {
      for (const rt of runtimes) {
        await rt.stop().catch(() => {});
      }
    },
  };
}

// ─── orchestrator 侧：派单 + gather ──────────────────────────────────────────

/**
 * 把一整个 wave 的 slot 经 A2A 总线派给各自的 analyst 实例并 await 全部回包。
 *
 * 必须「先 gather.expect 登记 taskId，再 send」——总线是进程内同步派发，回包可能
 * 在 send 返回前就到。返回 `Map<instanceId, SlotDispatchResult>`，顺序无关、按实例对齐。
 */
export async function dispatchSlotsViaA2A(input: {
  workflowRunId: string;
  traceId: string;
  /** TASK_ASSIGN 的 sender——orchestrator 实例 id（a2a_message / 拓扑 sender 归属）。 */
  orchestratorInstanceId: string;
  slots: TeamSlotDispatchSpec[];
  timeoutMs: number;
}): Promise<Map<string, SlotDispatchResult>> {
  const gather = getA2AGather();
  const taskIdByInstance = new Map<string, string>();
  const instanceByTaskId = new Map<string, string>();
  for (const slot of input.slots) {
    const taskId = randomUUID();
    taskIdByInstance.set(slot.instanceId, taskId);
    instanceByTaskId.set(taskId, slot.instanceId);
  }

  // 1) 先登记，规避「回包早于登记」竞态。
  const pending = gather.expect([...instanceByTaskId.keys()], {
    timeoutMs: input.timeoutMs,
  });

  // 2) 派单（并发 send；handler 异步执行，send 不阻塞）。
  await Promise.all(
    input.slots.map((slot) => {
      const taskId = taskIdByInstance.get(slot.instanceId) as string;
      const params: TeamSlotParams = {
        definitionId: slot.definitionId,
        role: slot.role,
        systemPrompt: slot.systemPrompt,
        ticker: slot.ticker,
        ...(slot.scope !== undefined ? { scope: slot.scope } : {}),
        context: slot.context,
        expectJsonSignal: slot.expectJsonSignal,
        reactDepth: slot.reactDepth,
        ...(slot.groupConstraintHint !== undefined
          ? { groupConstraintHint: slot.groupConstraintHint }
          : {}),
      };
      return a2aRouter.send({
        workflowId: input.workflowRunId,
        traceId: input.traceId,
        senderAgent: input.orchestratorInstanceId,
        receiverAgent: slot.instanceId,
        messageType: "TASK_ASSIGN",
        payload: {
          taskId,
          taskType: TEAM_SLOT_A2A_TASK_TYPE,
          assignedRole: slot.role,
          params: params as unknown as Record<string, unknown>,
        },
        priority: 50,
      });
    })
  );

  // 3) 等回包，还原成上层期望的 SlotDispatchResult。
  const gathered = await pending;
  const out = new Map<string, SlotDispatchResult>();
  for (const [taskId, instanceId] of instanceByTaskId.entries()) {
    const g = gathered.get(taskId);
    if (!g || !g.success) {
      out.set(instanceId, {
        ok: false,
        error: g?.errorMessage ?? (g?.timedOut ? "a2a_gather_timeout" : "no_result"),
      });
      continue;
    }
    const reactOut = (g.result as { reactOut?: SlotReactOut } | null)?.reactOut;
    if (!reactOut) {
      out.set(instanceId, { ok: false, error: "malformed_task_result" });
      continue;
    }
    out.set(instanceId, { ok: true, reactOut });
  }
  return out;
}
