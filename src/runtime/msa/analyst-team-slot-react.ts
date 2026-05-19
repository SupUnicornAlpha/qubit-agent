import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentInstance } from "../../db/sqlite/schema";
import type { AgentRole, AnalystSignalValue } from "../../types/entities";
import { executeAgentReact } from "../langgraph/execute-agent-react";
import type { RuntimeAgentDefinition } from "../types";
import type { RawAnalystSignal } from "./signal-fusion";
import { validateFsiRoleOutput } from "../fsi/fsi-output-validator";

const TEAM_SLOT_MAX_ITERATIONS = 6;

async function loadRuntimeDefinition(definitionId: string): Promise<RuntimeAgentDefinition> {
  const db = await getDb();
  const row = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!row[0]) throw new Error(`Agent definition not found: ${definitionId}`);
  const d = row[0];
  return {
    id: d.id,
    role: d.role as AgentRole,
    name: d.name,
    version: d.version,
    systemPrompt: d.systemPrompt,
    tools: (d.toolsJson as string[]) ?? [],
    mcpServers: (d.mcpServersJson as string[]) ?? [],
    skills: (d.skillsJson as string[]) ?? [],
    subscriptions: (d.subscriptionsJson as RuntimeAgentDefinition["subscriptions"]) ?? ["TASK_ASSIGN"],
    llmProvider: d.llmProvider,
    maxIterations: Math.min(d.maxIterations ?? TEAM_SLOT_MAX_ITERATIONS, TEAM_SLOT_MAX_ITERATIONS),
    sandboxPolicyId: d.sandboxPolicyId,
    enabled: Boolean(d.enabled),
  };
}

function parseJsonSignalFromText(
  role: AgentRole,
  definitionId: string,
  ticker: string,
  text: string
): Promise<RawAnalystSignal> {
  return (async () => {
    let parsed: Record<string, unknown> = {};
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    } catch {
      parsed = {};
    }
    const validated = await validateFsiRoleOutput(role, parsed);
    const p = validated.sanitized;
    const signal = (["buy", "sell", "hold"].includes(p["signal"] as string)
      ? p["signal"]
      : "hold") as AnalystSignalValue;
    const confidence =
      typeof p["confidence"] === "number" ? Math.max(0, Math.min(1, p["confidence"])) : 0.4;
    const reasoning =
      typeof p["reasoning"] === "string" ? p["reasoning"] : text.slice(0, 500);
    return {
      definitionId,
      analystRole: role,
      ticker,
      signal,
      confidence,
      reasoning,
      dataSnapshot: { rawResponse: text },
    };
  })();
}

/**
 * 研究团队槽位：走 LangGraph ReAct（reason→act→工具），写入 tool_call_log / research_team_interaction。
 */
export async function runResearchTeamSlotReact(params: {
  workflowRunId: string;
  definitionId: string;
  role: AgentRole;
  systemPrompt: string;
  ticker: string;
  context: string;
  /** 与 analyst-team 预创建的 instance 对齐，便于 tool_call_log 关联 */
  agentInstanceId?: string;
  /** analyst_* 需解析 JSON 信号 */
  expectJsonSignal?: boolean;
}): Promise<
  | { kind: "analyst"; payload: RawAnalystSignal & { agentInstanceId?: string } }
  | { kind: "markdown"; body: string; agentInstanceId?: string }
> {
  const def = await loadRuntimeDefinition(params.definitionId);
  def.systemPrompt = params.systemPrompt;

  const runId = randomUUID();
  const traceId = randomUUID();

  const userGoal = params.expectJsonSignal
    ? `分析标的 ${params.ticker}，先使用授权工具拉取数据/指标，再输出一段 JSON 信号（buy/sell/hold + confidence + reasoning）。`
    : `分析标的 ${params.ticker}，使用授权工具完成本子任务，最后用 Markdown 小结（不要 JSON）。`;

  const result = await executeAgentReact({
    runId,
    workflowId: params.workflowRunId,
    traceId,
    def,
    agentInstanceId: params.agentInstanceId,
    receiverAgent: `team-slot-${params.role}`,
    payload: {
      taskId: runId,
      taskType: "analyst_team_slot",
      assignedRole: params.role,
      params: {
        goal: userGoal,
        ticker: params.ticker,
        context: params.context,
        forceLoop: true,
        teamSlot: true,
      },
    },
    streamLoopKind: "native",
    streamSource: "native",
    updateWorkflowStatus: false,
  });

  const text =
    String(result.finalState.reasonText ?? "").trim() ||
    JSON.stringify(result.finalResponse ?? {});

  const db = await getDb();
  const inst = await db
    .select({ id: agentInstance.id })
    .from(agentInstance)
    .where(
      and(
        eq(agentInstance.workflowRunId, params.workflowRunId),
        eq(agentInstance.definitionId, params.definitionId)
      )
    )
    .orderBy(desc(agentInstance.startedAt))
    .limit(1);
  const agentInstanceId = inst[0]?.id;

  if (params.expectJsonSignal) {
    const signal = await parseJsonSignalFromText(
      params.role,
      params.definitionId,
      params.ticker,
      text
    );
    return { kind: "analyst", payload: { ...signal, agentInstanceId } };
  }

  return { kind: "markdown", body: text || "（模型未返回内容）", agentInstanceId };
}
