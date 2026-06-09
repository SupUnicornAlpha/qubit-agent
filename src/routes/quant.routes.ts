/**
 * /api/v1/quant — 量化工作台聚合查询
 *
 * 主要面向前端「量化工作台」4 个 tab 的横向需求：
 *   - lineage 解析：把 factor / rule / composition / discovery_job / backtest_run
 *     的 createdBy / workflowRunId / agentInstanceId / sourceJobId 等冗余
 *     字段在后端 join 一次，给前端一个统一的 LineageBundle，
 *     避免前端为每个产物再发 3 ~ 5 个独立请求拼数据。
 *
 *   - lineage tree：递归展开 backtest_run → composition → factors / rules → ...，
 *     供「回测详情面板」一次性渲染整条溯源链。
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6 + migration 0080。
 */

import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import {
  factorDefinition as factorTable,
  ruleDefinition as ruleTable,
  strategyComposition as compositionTable,
  discoveryJob as discoveryJobTable,
  backtestRun as backtestRunTable,
  agentInstance as agentInstanceTable,
  agentDefinition as agentDefinitionTable,
  workflowRun as workflowRunTable,
  indicatorStrategyScript as scriptTable,
  chatSession as chatSessionTable,
} from "../db/sqlite/schema";

export const quantRouter = new Hono();

export type LineageKind =
  | "factor"
  | "rule"
  | "composition"
  | "discovery_job"
  | "backtest_run";

interface AgentSummary {
  instanceId: string;
  definitionId: string;
  role: string;
  name: string;
}

interface WorkflowSummary {
  id: string;
  goal: string;
  mode: string;
  status: string;
  startedAt: string;
}

interface LineageNode {
  kind: LineageKind;
  id: string;
  /** 简短标题（factor name / composition kind / backtest engine 等） */
  label: string;
  createdBy: string;
  agent: AgentSummary | null;
  workflow: WorkflowSummary | null;
  /** 上游产物（discovery 提升 / 克隆来源 / 引用的 composition 等） */
  parent: LineageNode | null;
  /** 子产物（composition 的 factors/rules / backtest 的 composition + factors） */
  children: LineageNode[];
  /** 任意额外字段（status / category / metrics 等） */
  meta: Record<string, unknown>;
}

async function fetchAgentSummary(
  instanceId: string | null
): Promise<AgentSummary | null> {
  if (!instanceId) return null;
  const db = await getDb();
  const rows = await db
    .select({
      instanceId: agentInstanceTable.id,
      definitionId: agentInstanceTable.definitionId,
      role: agentDefinitionTable.role,
      name: agentDefinitionTable.name,
    })
    .from(agentInstanceTable)
    .leftJoin(
      agentDefinitionTable,
      eq(agentInstanceTable.definitionId, agentDefinitionTable.id)
    )
    .where(eq(agentInstanceTable.id, instanceId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    instanceId: r.instanceId,
    definitionId: r.definitionId,
    role: r.role ?? "agent",
    name: r.name ?? "Agent",
  };
}

async function fetchWorkflowSummary(
  workflowRunId: string | null
): Promise<WorkflowSummary | null> {
  if (!workflowRunId) return null;
  const db = await getDb();
  const rows = await db
    .select({
      id: workflowRunTable.id,
      goal: workflowRunTable.goal,
      mode: workflowRunTable.mode,
      status: workflowRunTable.status,
      startedAt: workflowRunTable.startedAt,
    })
    .from(workflowRunTable)
    .where(eq(workflowRunTable.id, workflowRunId))
    .limit(1);
  return rows[0] ?? null;
}

async function buildFactorNode(id: string): Promise<LineageNode | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(factorTable)
    .where(eq(factorTable.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const [agent, workflow] = await Promise.all([
    fetchAgentSummary(r.agentInstanceId ?? null),
    fetchWorkflowSummary(r.workflowRunId ?? null),
  ]);
  // 上游：discovery_promote 路径下指向 sourceJobId
  let parent: LineageNode | null = null;
  if (r.sourceJobId) {
    parent = await buildDiscoveryNode(r.sourceJobId);
  }
  return {
    kind: "factor",
    id: r.id,
    label: r.name,
    createdBy: r.createdBy ?? "user",
    agent,
    workflow,
    parent,
    children: [],
    meta: {
      category: r.category,
      lang: r.lang,
      status: r.status,
      universe: r.universe,
      horizon: r.horizon,
      providerKey: r.providerKey,
    },
  };
}

async function buildRuleNode(id: string): Promise<LineageNode | null> {
  const db = await getDb();
  const rows = await db.select().from(ruleTable).where(eq(ruleTable.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  const [agent, workflow] = await Promise.all([
    fetchAgentSummary(r.agentInstanceId ?? null),
    fetchWorkflowSummary(r.workflowRunId ?? null),
  ]);
  return {
    kind: "rule",
    id: r.id,
    label: r.name,
    createdBy: r.createdBy ?? "user",
    agent,
    workflow,
    parent: null,
    children: [],
    meta: {
      appliesTo: r.appliesTo,
      lang: r.lang,
      status: r.status,
      providerKey: r.providerKey,
    },
  };
}

async function buildDiscoveryNode(id: string): Promise<LineageNode | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(discoveryJobTable)
    .where(eq(discoveryJobTable.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const [agent, workflow] = await Promise.all([
    fetchAgentSummary(r.agentInstanceId ?? null),
    fetchWorkflowSummary(r.workflowRunId ?? null),
  ]);
  return {
    kind: "discovery_job",
    id: r.id,
    label: `${r.kind} job`,
    createdBy: r.createdBy ?? "user",
    agent,
    workflow,
    parent: null,
    children: [],
    meta: {
      kind: r.kind,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    },
  };
}

async function buildCompositionNode(
  id: string,
  opts: { withChildren?: boolean } = {}
): Promise<LineageNode | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(compositionTable)
    .where(eq(compositionTable.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const [agent, workflow] = await Promise.all([
    fetchAgentSummary(r.agentInstanceId ?? null),
    fetchWorkflowSummary(r.workflowRunId ?? null),
  ]);
  let parent: LineageNode | null = null;
  if (r.parentCompositionId) {
    parent = await buildCompositionNode(r.parentCompositionId, { withChildren: false });
  }
  const factorIds = ((r.factorIdsJson as string[] | undefined) ?? []).filter(Boolean);
  const ruleIds = ((r.ruleIdsJson as string[] | undefined) ?? []).filter(Boolean);
  const children: LineageNode[] = [];
  if (opts.withChildren) {
    const [factors, rules] = await Promise.all([
      Promise.all(factorIds.map((fid) => buildFactorNode(fid))),
      Promise.all(ruleIds.map((rid) => buildRuleNode(rid))),
    ]);
    for (const n of factors) if (n) children.push(n);
    for (const n of rules) if (n) children.push(n);
  }
  return {
    kind: "composition",
    id: r.id,
    label: r.name?.trim() || `${r.kind}#${r.id.slice(0, 8)}`,
    createdBy: r.createdBy ?? "user",
    agent,
    workflow,
    parent,
    children,
    meta: {
      kind: r.kind,
      weightMethod: r.weightMethod,
      rebalanceFreq: r.rebalanceFreq,
      universe: r.universe,
      factorIds,
      ruleIds,
      description: r.description ?? "",
    },
  };
}

async function buildBacktestNode(id: string): Promise<LineageNode | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(backtestRunTable)
    .where(eq(backtestRunTable.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const [agent, workflow] = await Promise.all([
    fetchAgentSummary(r.agentInstanceId ?? null),
    fetchWorkflowSummary(r.workflowRunId ?? null),
  ]);
  let composition: LineageNode | null = null;
  if (r.compositionId) {
    composition = await buildCompositionNode(r.compositionId, { withChildren: true });
  }
  return {
    kind: "backtest_run",
    id: r.id,
    label: `${r.engineKey}#${r.id.slice(0, 8)}`,
    createdBy: r.createdBy ?? "user",
    agent,
    workflow,
    parent: composition,
    children: composition ? composition.children : [],
    meta: {
      status: r.status,
      engineKey: r.engineKey,
      providerId: r.providerId,
      strategyVersionId: r.strategyVersionId,
    },
  };
}

/**
 * GET /api/v1/quant/lineage?kind=factor&id=xxx
 *
 * 返回单个 LineageNode（深入 1 ~ 2 层；composition / backtest_run 会带 children）。
 * 主要用于前端「点开一个产物的详情面板」时一次性拿到 lineage 显示数据。
 */
quantRouter.get("/lineage", async (c) => {
  const kind = c.req.query("kind") as LineageKind | undefined;
  const id = c.req.query("id");
  if (!kind || !id) {
    return c.json({ ok: false, error: "kind_and_id_required" }, 400);
  }
  try {
    let node: LineageNode | null = null;
    if (kind === "factor") node = await buildFactorNode(id);
    else if (kind === "rule") node = await buildRuleNode(id);
    else if (kind === "composition")
      node = await buildCompositionNode(id, { withChildren: true });
    else if (kind === "discovery_job") node = await buildDiscoveryNode(id);
    else if (kind === "backtest_run") node = await buildBacktestNode(id);
    else return c.json({ ok: false, error: `unknown_kind:${kind}` }, 400);
    if (!node) return c.json({ ok: false, error: "not_found" }, 404);
    return c.json({ ok: true, data: node });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/**
 * POST /api/v1/quant/lineage/batch
 *
 * 入参：`{ kind, ids: string[] }`；批量解析一组 ID 的 lineage（不带 children），
 * 返回 `{ data: LineageNode[] }`。前端列表 hover / 滚动加载时使用，避免 N 个独立请求。
 */
quantRouter.post("/lineage/batch", async (c) => {
  try {
    const body = await c.req.json<{ kind: LineageKind; ids: string[] }>();
    if (!body.kind || !Array.isArray(body.ids) || body.ids.length === 0) {
      return c.json({ ok: false, error: "kind_and_ids_required" }, 400);
    }
    const ids = body.ids.filter(Boolean).slice(0, 200); // 防止单批过大
    const results: LineageNode[] = [];
    for (const id of ids) {
      let n: LineageNode | null = null;
      if (body.kind === "factor") n = await buildFactorNode(id);
      else if (body.kind === "rule") n = await buildRuleNode(id);
      else if (body.kind === "composition")
        n = await buildCompositionNode(id, { withChildren: false });
      else if (body.kind === "discovery_job") n = await buildDiscoveryNode(id);
      else if (body.kind === "backtest_run") n = await buildBacktestNode(id);
      if (n) results.push(n);
    }
    return c.json({ ok: true, data: results });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/**
 * GET /api/v1/quant/agents?ids=a,b,c
 *
 * 批量解析 agentInstance.id → AgentSummary，前端 LineageBadge 列表渲染时使用。
 */
quantRouter.get("/agents", async (c) => {
  const raw = c.req.query("ids") ?? "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return c.json({ ok: true, data: [] });
  try {
    const db = await getDb();
    const rows = await db
      .select({
        instanceId: agentInstanceTable.id,
        definitionId: agentInstanceTable.definitionId,
        role: agentDefinitionTable.role,
        name: agentDefinitionTable.name,
      })
      .from(agentInstanceTable)
      .leftJoin(
        agentDefinitionTable,
        eq(agentInstanceTable.definitionId, agentDefinitionTable.id)
      )
      .where(inArray(agentInstanceTable.id, ids));
    return c.json({ ok: true, data: rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/**
 * GET /api/v1/quant/workflows?ids=a,b,c
 *
 * 批量解析 workflow_run.id → WorkflowSummary。
 */
quantRouter.get("/workflows", async (c) => {
  const raw = c.req.query("ids") ?? "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return c.json({ ok: true, data: [] });
  try {
    const db = await getDb();
    const rows = await db
      .select({
        id: workflowRunTable.id,
        goal: workflowRunTable.goal,
        mode: workflowRunTable.mode,
        status: workflowRunTable.status,
        startedAt: workflowRunTable.startedAt,
        researchScenarioId: workflowRunTable.researchScenarioId,
      })
      .from(workflowRunTable)
      .where(inArray(workflowRunTable.id, ids));
    return c.json({ ok: true, data: rows });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/**
 * GET /api/v1/quant/strategy-scripts?project_id=&purpose=&workflow_run_id=&session_id=
 *
 * 跨 session 列出某 project 下的所有 indicator_strategy_script —— 给「量化工作台 →
 * 脚本工坊」tab 用。原 chat.routes 下的 `GET /sessions/:sessionId/strategy-scripts`
 * 只能按 session 拉，工作台需要 project 维度聚合，且要带 sessionTitle 让用户能识别
 * 脚本来自哪场对话。
 *
 * 默认不返回 ideCode / signalCode 全文（数据量大），只返回元数据 + 代码长度；用户
 * 进详情时再走 `GET /api/v1/quant/strategy-scripts/:id` 拉全文。
 */
quantRouter.get("/strategy-scripts", async (c) => {
  try {
    const db = await getDb();
    const projectId = c.req.query("project_id");
    const purpose = c.req.query("purpose") as
      | "research"
      | "live_trading"
      | "both"
      | undefined;
    const workflowRunId = c.req.query("workflow_run_id");
    const sessionId = c.req.query("session_id");

    const conds = [];
    if (projectId) conds.push(eq(chatSessionTable.projectId, projectId));
    if (purpose) conds.push(eq(scriptTable.purpose, purpose));
    if (workflowRunId) conds.push(eq(scriptTable.workflowRunId, workflowRunId));
    if (sessionId) conds.push(eq(scriptTable.sessionId, sessionId));

    const query = db
      .select({
        id: scriptTable.id,
        sessionId: scriptTable.sessionId,
        sessionTitle: chatSessionTable.title,
        projectId: chatSessionTable.projectId,
        workflowRunId: scriptTable.workflowRunId,
        name: scriptTable.name,
        purpose: scriptTable.purpose,
        ideCodeLen: scriptTable.ideCode,
        signalCodeLen: scriptTable.signalCode,
        aiPromptSnapshot: scriptTable.aiPromptSnapshot,
        createdAt: scriptTable.createdAt,
        updatedAt: scriptTable.updatedAt,
      })
      .from(scriptTable)
      .innerJoin(chatSessionTable, eq(chatSessionTable.id, scriptTable.sessionId));

    const rows =
      conds.length === 0
        ? await query.orderBy(desc(scriptTable.updatedAt))
        : await query
            .where(conds.length === 1 ? conds[0] : and(...conds))
            .orderBy(desc(scriptTable.updatedAt));

    // 字段裁剪：只回 *_len（避免直接把可能很长的 code 灌出来）
    const data = rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      projectId: r.projectId,
      workflowRunId: r.workflowRunId,
      name: r.name,
      purpose: r.purpose,
      ideCodeLength: (r.ideCodeLen ?? "").length,
      signalCodeLength: (r.signalCodeLen ?? "").length,
      hasAiPrompt: !!(r.aiPromptSnapshot && r.aiPromptSnapshot.trim().length > 0),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    return c.json({ ok: true, data });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/**
 * GET /api/v1/quant/strategy-scripts/:id
 *
 * 按 id 单查 —— 返回包含 ideCode / signalCode 全文的完整记录 + sessionTitle / projectId
 * 等关联字段，供脚本工坊详情面板渲染只读 Python 代码块。
 */
quantRouter.get("/strategy-scripts/:id", async (c) => {
  try {
    const db = await getDb();
    const id = c.req.param("id");
    const rows = await db
      .select({
        id: scriptTable.id,
        sessionId: scriptTable.sessionId,
        sessionTitle: chatSessionTable.title,
        projectId: chatSessionTable.projectId,
        workflowRunId: scriptTable.workflowRunId,
        name: scriptTable.name,
        purpose: scriptTable.purpose,
        ideCode: scriptTable.ideCode,
        signalCode: scriptTable.signalCode,
        aiPromptSnapshot: scriptTable.aiPromptSnapshot,
        chartSnapshotJson: scriptTable.chartSnapshotJson,
        createdAt: scriptTable.createdAt,
        updatedAt: scriptTable.updatedAt,
      })
      .from(scriptTable)
      .innerJoin(chatSessionTable, eq(chatSessionTable.id, scriptTable.sessionId))
      .where(eq(scriptTable.id, id))
      .limit(1);
    if (!rows[0]) return c.json({ ok: false, error: "not_found" }, 404);
    return c.json({ ok: true, data: rows[0] });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});
