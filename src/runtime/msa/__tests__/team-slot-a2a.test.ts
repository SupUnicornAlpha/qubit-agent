/**
 * 团队 slot A2A 传输层路由 + 关联往返测试（不触 LLM / 不依赖真实 analyst handler）。
 *
 * 用一个 stub handler 模拟 analyst 侧回 TASK_RESULT，验证：
 *   1. dispatchSlotsViaA2A 发的 TASK_ASSIGN 能按 instanceId 投递到对应 runtime；
 *   2. 回包经 gather 关联还原成 SlotDispatchResult（analyst payload 解码正确）；
 *   3. instanceOnlyRouting：按 role 名寻址的消息不会命中这个临时实例 runtime。
 */
import { describe, expect, test } from "bun:test";
import { a2aRouter } from "../../../messaging/a2a";
import type { TaskAssignPayload } from "../../../types/a2a";
import { AgentRuntime } from "../../agent-runtime";
import type { RuntimeAgentDefinition, RuntimeRoleHandler } from "../../types";
import { TEAM_SLOT_A2A_TASK_TYPE, dispatchSlotsViaA2A } from "../team-slot-a2a";

function minimalDef(definitionId: string, role: string): RuntimeAgentDefinition {
  return {
    id: definitionId,
    role: role as RuntimeAgentDefinition["role"],
    name: `stub-${role}`,
    version: "test",
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

describe("dispatchSlotsViaA2A round-trip", () => {
  test("按 instanceId 投递 → stub 回包 → 解码成 analyst SlotDispatchResult", async () => {
    const instanceId = crypto.randomUUID();
    const seenTaskTypes: string[] = [];

    // stub handler：模拟 analyst 侧——收到 team-slot 任务就回一个 analyst 信号回执。
    const handler: RuntimeRoleHandler = {
      onMessage: async (ctx, msg) => {
        if (msg.messageType !== "TASK_ASSIGN") return;
        const payload = msg.payload as TaskAssignPayload;
        seenTaskTypes.push(payload.taskType);
        if (payload.taskType !== TEAM_SLOT_A2A_TASK_TYPE) return;
        await ctx.send({
          workflowId: msg.workflowId,
          traceId: msg.traceId,
          receiverAgent: msg.senderAgent,
          messageType: "TASK_RESULT",
          payload: {
            taskId: payload.taskId,
            success: true,
            result: {
              reactOut: {
                kind: "analyst",
                payload: {
                  definitionId: "def-x",
                  analystRole: payload.assignedRole,
                  ticker: "AAPL",
                  signal: "buy",
                  confidence: 0.71,
                  reasoning: "stubbed",
                },
              },
            },
            durationMs: 0,
          },
          priority: msg.priority,
        });
      },
    };

    const runtime = new AgentRuntime(minimalDef("def-x", "analyst_fundamental"), handler, {
      instanceId,
      instanceOnlyRouting: true,
    });
    await runtime.start();

    try {
      const results = await dispatchSlotsViaA2A({
        workflowRunId: "wf-dispatch",
        traceId: "tr-dispatch",
        orchestratorInstanceId: "orch-test",
        slots: [
          {
            instanceId,
            definitionId: "def-x",
            role: "analyst_fundamental",
            systemPrompt: "",
            ticker: "AAPL",
            context: "",
            expectJsonSignal: true,
            reactDepth: "standard",
          },
        ],
        timeoutMs: 5000,
      });

      const r = results.get(instanceId);
      expect(r?.ok).toBe(true);
      if (r?.ok) {
        expect(r.reactOut.kind).toBe("analyst");
        if (r.reactOut.kind === "analyst") {
          expect(r.reactOut.payload.signal).toBe("buy");
          expect(r.reactOut.payload.confidence).toBeCloseTo(0.71);
        }
      }
      expect(seenTaskTypes).toContain(TEAM_SLOT_A2A_TASK_TYPE);
    } finally {
      await runtime.stop();
    }
  });

  test("instanceOnlyRouting：按 role 名寻址不命中临时实例 runtime", async () => {
    const instanceId = crypto.randomUUID();
    let handled = 0;
    const handler: RuntimeRoleHandler = {
      onMessage: async () => {
        handled += 1;
      },
    };
    const runtime = new AgentRuntime(minimalDef("def-y", "analyst_macro"), handler, {
      instanceId,
      instanceOnlyRouting: true,
    });
    await runtime.start();
    try {
      // 按 role 名寻址：instanceOnlyRouting=true 时不应命中。
      await a2aRouter.send({
        workflowId: "wf-route",
        traceId: "tr-route",
        senderAgent: "orch-test",
        receiverAgent: "analyst_macro",
        messageType: "TASK_ASSIGN",
        payload: {
          taskId: crypto.randomUUID(),
          taskType: "noop",
          params: {},
          assignedRole: "analyst_macro",
        },
        priority: 50,
      });
      expect(handled).toBe(0);
    } finally {
      await runtime.stop();
    }
  });
});
