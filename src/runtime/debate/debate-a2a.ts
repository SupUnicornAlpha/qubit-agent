/**
 * Bull/Bear 辩论的 A2A 传输层。
 *
 * 历史上 bull/bear 不是被配置的 agent——既无 `agent_definition`、也无 `agent_instance`，
 * 只是 `debate-engine` 里两段裸 LLM prompt。要让它们成为 A2A 总线上的真实参与方
 * （`a2a_message` / 拓扑出现真实 orchestrator↔bull/bear 边），必须先有 def（因为
 * `agent_instance.definition_id` 是 NOT NULL FK）。
 *
 * 本模块的做法（低 blast radius、可回退）：
 *   - {@link ensureDebateAgentDefs}：幂等插入 `def-researcher-bull/bear`，**enabled=false**
 *     —— pool（只加载 enabled def）不会为它们起常驻 runtime、智能体目录也不收录；
 *     sandbox_policy / llm_provider 从现有 def 取模板，保证 FK 合法、跨库可用。
 *   - {@link setupDebateA2A}：为本 workflow 建 bull/bear 专属实例 + 起临时 runtime，
 *     返回一个 `runTurn`（派 `debate_turn` TASK_ASSIGN 给对应实例、gather 等回包）注入
 *     `runDebateSession`。评分 / debate_session / turn / verdict 持久化仍全在 debate-engine 内。
 */

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentInstance } from "../../db/sqlite/schema";
import { a2aRouter } from "../../messaging/a2a";
import type { TaskAssignPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import { getA2AGather } from "../a2a/a2a-gather";
import { buildTaskResult } from "../a2a/task-result";
import { AgentRuntime } from "../agent-runtime";
import type { RuntimeAgentDefinition, RuntimeRoleHandler } from "../types";
import { type DebateTurnRunner, runDebateRoleTurn } from "./debate-engine";

export const DEBATE_TURN_TASK_TYPE = "debate_turn_a2a";

const BULL_DEF_ID = "def-researcher-bull";
const BEAR_DEF_ID = "def-researcher-bear";

const BULL_PROMPT =
  "你是多方研究员（researcher_bull）。请提出支持买入的论据，重点强调上行空间、催化剂和风险补偿。";
const BEAR_PROMPT =
  "你是空方研究员（researcher_bear）。请提出反对买入的论据，重点强调下行风险、估值泡沫和不确定性。";

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * 幂等确保 bull/bear 的 agent_definition 存在（enabled=false）。sandbox_policy_id /
 * llm_provider 从任意一个现有 def 取模板，避免硬编码、保证 FK 合法。
 */
export async function ensureDebateAgentDefs(db: Db): Promise<void> {
  const existing = await db
    .select({ id: agentDefinition.id })
    .from(agentDefinition)
    .where(inArray(agentDefinition.id, [BULL_DEF_ID, BEAR_DEF_ID]));
  const have = new Set(existing.map((e) => e.id));
  if (have.has(BULL_DEF_ID) && have.has(BEAR_DEF_ID)) return;

  const tmpl = (
    await db
      .select({
        llmProvider: agentDefinition.llmProvider,
        sandboxPolicyId: agentDefinition.sandboxPolicyId,
      })
      .from(agentDefinition)
      .where(eq(agentDefinition.enabled, true))
      .limit(1)
  )[0];
  if (!tmpl) {
    throw new Error("ensureDebateAgentDefs: no existing agent_definition to template from");
  }

  const row = (id: string, role: AgentRole, name: string, systemPrompt: string) => ({
    id,
    role,
    name,
    version: "debate-a2a",
    systemPrompt,
    toolsJson: [],
    mcpServersJson: [],
    skillsJson: [],
    subscriptionsJson: ["TASK_ASSIGN"],
    llmProvider: tmpl.llmProvider,
    llmConfigJson: {},
    outputsJson: [],
    maxIterations: 4,
    sandboxPolicyId: tmpl.sandboxPolicyId,
    // 关键：enabled=false → pool 不起常驻 runtime、目录不收录。仅作 FK 锚点。
    enabled: false,
  });

  if (!have.has(BULL_DEF_ID)) {
    await db
      .insert(agentDefinition)
      .values(row(BULL_DEF_ID, "researcher_bull", "多方研究员", BULL_PROMPT))
      .onConflictDoNothing();
  }
  if (!have.has(BEAR_DEF_ID)) {
    await db
      .insert(agentDefinition)
      .values(row(BEAR_DEF_ID, "researcher_bear", "空方研究员", BEAR_PROMPT))
      .onConflictDoNothing();
  }
}

function debateRuntimeDef(definitionId: string, role: AgentRole): RuntimeAgentDefinition {
  return {
    id: definitionId,
    role,
    name: `debate-${role}`,
    version: "debate-a2a",
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
 * 辩论 slot handler：收到 `debate_turn_a2a` → 跑 `runDebateRoleTurn`（与进程内同一套
 * prompt）→ 把 {statement, confidence} 装进 TASK_RESULT 回给 sender。
 */
export function createDebateSlotHandler(): RuntimeRoleHandler {
  return {
    onMessage: async (ctx, msg) => {
      if (msg.messageType !== "TASK_ASSIGN") return;
      const payload = msg.payload as TaskAssignPayload;
      if (payload.taskType !== DEBATE_TURN_TASK_TYPE) return;
      const p = payload.params as unknown as {
        stance: "bull" | "bear";
        topic: string;
        summary: string;
      };
      const reply = (success: boolean, result: Record<string, unknown>, errorMessage?: string) =>
        ctx.send({
          workflowId: msg.workflowId,
          traceId: msg.traceId,
          receiverAgent: msg.senderAgent,
          messageType: "TASK_RESULT",
          payload: buildTaskResult(payload.taskId, ctx.definition.role, {
            success,
            result,
            ...(errorMessage !== undefined ? { errorMessage } : {}),
          }),
          priority: msg.priority,
        });
      try {
        const turn = await runDebateRoleTurn(p.stance, p.topic, p.summary);
        await reply(true, { statement: turn.statement, confidence: turn.confidence });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await reply(false, { message }, message);
      }
    },
  };
}

export interface DebateA2ASetup {
  /** 注入 runDebateSession 的单回合执行器（派单给 bull/bear 实例并等回包）。 */
  runTurn: DebateTurnRunner;
  /** 辩论结束后停掉 bull/bear runtime 并把实例标 stopped。 */
  cleanup: () => Promise<void>;
}

/**
 * 为本 workflow 准备 A2A 辩论：建 bull/bear 专属实例 + 起临时 runtime，返回注入用的
 * `runTurn` 与 `cleanup`。orchestratorInstanceId 作为派单 sender（拓扑 sender 归属）。
 */
export async function setupDebateA2A(input: {
  workflowRunId: string;
  traceId: string;
  orchestratorInstanceId: string;
  timeoutMs: number;
}): Promise<DebateA2ASetup> {
  const db = await getDb();
  await ensureDebateAgentDefs(db);

  const bullInstanceId = randomUUID();
  const bearInstanceId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(agentInstance).values([
    {
      id: bullInstanceId,
      definitionId: BULL_DEF_ID,
      workflowRunId: input.workflowRunId,
      status: "running",
      currentIteration: 0,
      startedAt: now,
    },
    {
      id: bearInstanceId,
      definitionId: BEAR_DEF_ID,
      workflowRunId: input.workflowRunId,
      status: "running",
      currentIteration: 0,
      startedAt: now,
    },
  ]);

  const handler = createDebateSlotHandler();
  const bullRuntime = new AgentRuntime(debateRuntimeDef(BULL_DEF_ID, "researcher_bull"), handler, {
    instanceId: bullInstanceId,
    instanceOnlyRouting: true,
  });
  const bearRuntime = new AgentRuntime(debateRuntimeDef(BEAR_DEF_ID, "researcher_bear"), handler, {
    instanceId: bearInstanceId,
    instanceOnlyRouting: true,
  });
  await bullRuntime.start();
  await bearRuntime.start();

  const gather = getA2AGather();
  const runTurn: DebateTurnRunner = async (stance, topic, summary) => {
    const instanceId = stance === "bull" ? bullInstanceId : bearInstanceId;
    const taskId = randomUUID();
    const pending = gather.expect([taskId], { timeoutMs: input.timeoutMs });
    await a2aRouter.send({
      workflowId: input.workflowRunId,
      traceId: input.traceId,
      senderAgent: input.orchestratorInstanceId,
      receiverAgent: instanceId,
      messageType: "TASK_ASSIGN",
      payload: {
        taskId,
        taskType: DEBATE_TURN_TASK_TYPE,
        assignedRole: stance === "bull" ? "researcher_bull" : "researcher_bear",
        params: { stance, topic, summary },
      },
      priority: 50,
    });
    const g = (await pending).get(taskId);
    if (!g || !g.success) {
      throw new Error(g?.errorMessage ?? `debate ${stance} turn failed (no result)`);
    }
    const r = g.result as { statement?: string; confidence?: number } | null;
    return {
      statement: typeof r?.statement === "string" ? r.statement : "",
      confidence: typeof r?.confidence === "number" ? r.confidence : 0.6,
    };
  };

  const cleanup = async () => {
    await bullRuntime.stop().catch(() => {});
    await bearRuntime.stop().catch(() => {});
    await db
      .update(agentInstance)
      .set({ status: "stopped", endedAt: new Date().toISOString() })
      .where(inArray(agentInstance.id, [bullInstanceId, bearInstanceId]));
  };

  return { runTurn, cleanup };
}
