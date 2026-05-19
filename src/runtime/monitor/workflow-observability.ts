import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentInstance,
  agentStep,
  mcpCallLog,
  toolCallLog,
} from "../../db/sqlite/schema";

export type WorkflowObservability = {
  workflowRunId: string;
  llm: {
    reasonSteps: number;
    totalTokenCount: number | null;
    totalReasonLatencyMs: number | null;
  };
  tools: {
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    topTools: Array<{ name: string; count: number }>;
  };
  mcp: {
    total: number;
    byStatus: Record<string, number>;
    byServer: Array<{ server: string; count: number; success: number; failed: number }>;
  };
  byAgentRole: Array<{
    role: string;
    reasonSteps: number;
    toolCalls: number;
    mcpCalls: number;
    tokens: number | null;
  }>;
};

export async function getWorkflowObservability(workflowRunId: string): Promise<WorkflowObservability> {
  const db = await getDb();

  const [steps, instances, mcpRows] = await Promise.all([
    db.select().from(agentStep).where(eq(agentStep.workflowRunId, workflowRunId)),
    db.select().from(agentInstance).where(eq(agentInstance.workflowRunId, workflowRunId)),
    db.select().from(mcpCallLog).where(eq(mcpCallLog.workflowRunId, workflowRunId)),
  ]);

  const defIds = [...new Set(instances.map((i) => i.definitionId))];
  const defs =
    defIds.length > 0
      ? await db.select().from(agentDefinition).where(inArray(agentDefinition.id, defIds))
      : [];
  const roleByInst = new Map<string, string>();
  for (const inst of instances) {
    const role = defs.find((d) => d.id === inst.definitionId)?.role ?? "unknown";
    roleByInst.set(inst.id, role);
  }

  const stepIds = steps.map((s) => s.id);
  const toolRows =
    stepIds.length > 0
      ? await db.select().from(toolCallLog).where(inArray(toolCallLog.agentStepId, stepIds))
      : [];

  const reasonSteps = steps.filter((s) => s.phase === "reason");
  const totalTokenCount = reasonSteps.reduce((acc, s) => acc + (s.tokenCount ?? 0), 0) || null;
  const totalReasonLatencyMs = reasonSteps.reduce((acc, s) => acc + (s.latencyMs ?? 0), 0) || null;

  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const toolNameCount = new Map<string, number>();
  for (const t of toolRows) {
    byKind[t.toolKind] = (byKind[t.toolKind] ?? 0) + 1;
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    toolNameCount.set(t.toolName, (toolNameCount.get(t.toolName) ?? 0) + 1);
  }

  const mcpByStatus: Record<string, number> = {};
  const mcpServerAgg = new Map<string, { count: number; success: number; failed: number }>();
  for (const m of mcpRows) {
    mcpByStatus[m.status] = (mcpByStatus[m.status] ?? 0) + 1;
    const cur = mcpServerAgg.get(m.serverName) ?? { count: 0, success: 0, failed: 0 };
    cur.count += 1;
    if (m.status === "success") cur.success += 1;
    else cur.failed += 1;
    mcpServerAgg.set(m.serverName, cur);
  }

  const stepByInst = new Map<string, typeof steps>();
  for (const s of steps) {
    const arr = stepByInst.get(s.agentInstanceId) ?? [];
    arr.push(s);
    stepByInst.set(s.agentInstanceId, arr);
  }

  const toolByStep = new Map(toolRows.map((t) => [t.agentStepId, t]));
  const rolesSeen = new Set<string>();
  const byAgentRole: WorkflowObservability["byAgentRole"] = [];

  for (const inst of instances) {
    const role = roleByInst.get(inst.id) ?? "unknown";
    if (rolesSeen.has(role)) continue;
    rolesSeen.add(role);
    const instIds = instances.filter((i) => roleByInst.get(i.id) === role).map((i) => i.id);
    const roleSteps = instIds.flatMap((id) => stepByInst.get(id) ?? []);
    const roleReason = roleSteps.filter((s) => s.phase === "reason");
    const roleStepIds = new Set(roleSteps.map((s) => s.id));
    const roleTools = toolRows.filter((t) => roleStepIds.has(t.agentStepId));
    const roleMcp = mcpRows.filter((m) => {
      const st = steps.find((s) => s.id === m.agentStepId);
      return st && roleStepIds.has(st.id);
    });
    byAgentRole.push({
      role,
      reasonSteps: roleReason.length,
      toolCalls: roleTools.length,
      mcpCalls: roleMcp.length,
      tokens: roleReason.reduce((a, s) => a + (s.tokenCount ?? 0), 0) || null,
    });
  }

  return {
    workflowRunId,
    llm: {
      reasonSteps: reasonSteps.length,
      totalTokenCount,
      totalReasonLatencyMs,
    },
    tools: {
      total: toolRows.length,
      byKind,
      byStatus,
      topTools: [...toolNameCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([name, count]) => ({ name, count })),
    },
    mcp: {
      total: mcpRows.length,
      byStatus: mcpByStatus,
      byServer: [...mcpServerAgg.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([server, v]) => ({ server, ...v })),
    },
    byAgentRole: byAgentRole.sort((a, b) => a.role.localeCompare(b.role)),
  };
}
