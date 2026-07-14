import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  backtestRun,
  factorDefinition,
  llmCallLog,
  orderIntent,
  recommendationSnapshot,
  strategyComposition,
  strategyEvalRun,
  strategyVersion,
  toolCallLog,
  workflowRun,
} from "../../db/sqlite/schema";

export interface WorkflowLineageNode {
  id: string;
  kind: string;
  label: string;
  createdAt: string | null;
  asof: string | null;
  provider: string | null;
  freshness: string | null;
  metadata: Record<string, unknown>;
}

export interface WorkflowLineageEdge {
  from: string;
  to: string;
  relation: string;
}

function nodeId(kind: string, id: string) {
  return `${kind}:${id}`;
}

export async function buildWorkflowLineage(db: DbClient, workflowRunId: string) {
  const [workflowRows, factors, versions, compositions, backtests, evaluations, recommendations, orders, tools, llms] =
    await Promise.all([
      db.select().from(workflowRun).where(eq(workflowRun.id, workflowRunId)).limit(1),
      db.select().from(factorDefinition).where(eq(factorDefinition.workflowRunId, workflowRunId)),
      db.select().from(strategyVersion).where(eq(strategyVersion.workflowRunId, workflowRunId)),
      db.select().from(strategyComposition).where(eq(strategyComposition.workflowRunId, workflowRunId)),
      db.select().from(backtestRun).where(eq(backtestRun.workflowRunId, workflowRunId)),
      db.select().from(strategyEvalRun).where(eq(strategyEvalRun.workflowRunId, workflowRunId)),
      db.select().from(recommendationSnapshot).where(eq(recommendationSnapshot.workflowRunId, workflowRunId)),
      db.select().from(orderIntent).where(eq(orderIntent.workflowRunId, workflowRunId)),
      db.select().from(toolCallLog).where(eq(toolCallLog.workflowRunId, workflowRunId)),
      db.select().from(llmCallLog).where(eq(llmCallLog.workflowRunId, workflowRunId)),
    ]);
  const workflow = workflowRows[0];
  if (!workflow) return null;

  const rootId = nodeId("workflow", workflow.id);
  const nodes: WorkflowLineageNode[] = [{
    id: rootId,
    kind: "workflow",
    label: workflow.goal,
    createdAt: workflow.startedAt,
    asof: workflow.endedAt ?? workflow.startedAt,
    provider: null,
    freshness: workflow.status,
    metadata: { projectId: workflow.projectId, mode: workflow.mode, status: workflow.status },
  }];
  const edges: WorkflowLineageEdge[] = [];
  const add = (node: WorkflowLineageNode, parent = rootId, relation = "produced") => {
    nodes.push(node);
    edges.push({ from: parent, to: node.id, relation });
  };

  for (const factor of factors) add({
    id: nodeId("factor", factor.id), kind: "factor", label: factor.name,
    createdAt: factor.createdAt, asof: null, provider: factor.providerKey,
    freshness: null, metadata: { status: factor.status, horizon: factor.horizon, universe: factor.universe },
  });
  for (const version of versions) add({
    id: nodeId("strategy_version", version.id), kind: "strategy_version", label: version.versionTag,
    createdAt: version.createdAt, asof: null, provider: null, freshness: null,
    metadata: { strategyId: version.strategyId, logicHash: version.logicHash },
  });
  for (const composition of compositions) add({
    id: nodeId("strategy_composition", composition.id), kind: "strategy_composition",
    label: composition.name || composition.kind, createdAt: composition.createdAt, asof: null,
    provider: null, freshness: null, metadata: { kind: composition.kind, universe: composition.universe },
  }, nodeId("strategy_version", composition.strategyVersionId), "composed_as");
  for (const backtest of backtests) add({
    id: nodeId("backtest", backtest.id), kind: "backtest", label: backtest.status,
    createdAt: backtest.startedAt, asof: backtest.endedAt, provider: backtest.providerId ?? backtest.engineKey,
    freshness: backtest.status, metadata: { datasetSnapshotId: backtest.datasetSnapshotId, engineKey: backtest.engineKey },
  }, nodeId("strategy_version", backtest.strategyVersionId), "evaluated_by");
  for (const evaluation of evaluations) add({
    id: nodeId("evaluation", evaluation.id), kind: "evaluation", label: evaluation.evalKind,
    createdAt: evaluation.createdAt, asof: evaluation.periodEnd, provider: null,
    freshness: evaluation.pass == null ? "pending" : evaluation.pass ? "passed" : "failed",
    metadata: { qualityScore: evaluation.qualityScore, metrics: evaluation.metricsJson },
  }, evaluation.backtestRunId ? nodeId("backtest", evaluation.backtestRunId) : rootId, "scored_by");
  for (const recommendation of recommendations) add({
    id: nodeId("recommendation", recommendation.id), kind: "recommendation",
    label: `${recommendation.symbol} ${recommendation.side}`, createdAt: recommendation.createdAt,
    asof: recommendation.dataAsof ?? recommendation.asof, provider: null, freshness: recommendation.status,
    metadata: { confidence: recommendation.confidence, horizonDays: recommendation.horizonDays, evidence: recommendation.evidenceJson },
  }, recommendation.sourceArtifactId && recommendation.sourceArtifactKind
    ? nodeId(recommendation.sourceArtifactKind, recommendation.sourceArtifactId)
    : rootId, "supports_decision");
  for (const order of orders) add({
    id: nodeId("order_intent", order.id), kind: "order_intent", label: `${order.symbol ?? ""} ${order.side}`.trim(),
    createdAt: order.intentTime, asof: order.lifecycleUpdatedAt, provider: null,
    freshness: order.lifecycleStatus, metadata: { orderType: order.orderType, qty: order.qty, market: order.market },
  }, nodeId("strategy_version", order.strategyVersionId), "executed_as");
  for (const tool of tools) add({
    id: nodeId("tool_call", tool.id), kind: "tool_call", label: tool.toolName,
    createdAt: tool.createdAt, asof: tool.createdAt, provider: tool.toolKind,
    freshness: tool.status, metadata: { agentDefinitionId: tool.agentDefinitionId, latencyMs: tool.latencyMs },
  }, rootId, "used_tool");
  for (const llm of llms) add({
    id: nodeId("llm_call", llm.id), kind: "llm_call", label: llm.model,
    createdAt: null, asof: null, provider: llm.provider, freshness: null,
    metadata: { agentDefinitionId: llm.agentDefinitionId, latencyMs: llm.latencyMs, totalTokens: llm.totalTokens },
  }, rootId, "used_model");

  const knownIds = new Set(nodes.map((node) => node.id));
  const unresolvedEdges = edges.filter((edge) => !knownIds.has(edge.from));
  return {
    workflowRunId,
    nodes,
    edges,
    coverage: {
      totalNodes: nodes.length,
      nodesWithAsof: nodes.filter((node) => node.asof).length,
      nodesWithProvider: nodes.filter((node) => node.provider).length,
      unresolvedEdges: unresolvedEdges.length,
    },
    warnings: unresolvedEdges.map((edge) => `missing_parent:${edge.from}`),
  };
}
