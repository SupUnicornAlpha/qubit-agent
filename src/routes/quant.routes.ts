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
  factorBacktestPromotionService,
  FactorBacktestPromotionError,
} from "../runtime/quant/factor-backtest-promotion-service";
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

function asPromotionError(e: unknown) {
  if (e instanceof FactorBacktestPromotionError) {
    return { ok: false, code: e.code, error: e.message } as const;
  }
  return { ok: false, code: "internal_error", error: (e as Error).message } as const;
}

/**
 * POST /api/v1/quant/factor-backtest-promotions/run-now
 *
 * P0 闭环入口：factor_ids → strategy_version → strategy_composition → backtest_run。
 * 所有产物会写入 workflowRunId / projectId 血缘，量化工坊可直接观察。
 */
quantRouter.post("/factor-backtest-promotions/run-now", async (c) => {
  try {
    const body = await c.req.json<{
      project_id?: string;
      projectId?: string;
      factor_ids?: string[];
      factorIds?: string[];
      strategy_name?: string;
      strategyName?: string;
      version_tag?: string;
      versionTag?: string;
      composition_name?: string;
      compositionName?: string;
      description?: string;
      symbols?: string[];
      universe?: string;
      start_date?: string;
      startDate?: string;
      end_date?: string;
      endDate?: string;
      capital?: number;
      costs?: { commissionBps: number; slippageBps: number; minCommission?: number };
      rebalance?: "daily" | "weekly" | "monthly";
      top_n?: number;
      topN?: number;
      longShort?: boolean;
      benchmark?: string;
      provider_key?: string;
      providerKey?: string;
      workflow_run_id?: string | null;
      workflowRunId?: string | null;
      agent_instance_id?: string | null;
      agentInstanceId?: string | null;
      created_by?: string;
      createdBy?: string;
    }>();
    const data = await factorBacktestPromotionService.promoteAndBacktest({
      ...(body.project_id ?? body.projectId ? { projectId: (body.project_id ?? body.projectId)! } : {}),
      factorIds: body.factor_ids ?? body.factorIds ?? [],
      ...(body.strategy_name ?? body.strategyName
        ? { strategyName: (body.strategy_name ?? body.strategyName)! }
        : {}),
      ...(body.version_tag ?? body.versionTag
        ? { versionTag: (body.version_tag ?? body.versionTag)! }
        : {}),
      ...(body.composition_name ?? body.compositionName
        ? { compositionName: (body.composition_name ?? body.compositionName)! }
        : {}),
      ...(body.description ? { description: body.description } : {}),
      ...(body.symbols ? { symbols: body.symbols } : {}),
      ...(body.universe ? { universe: body.universe } : {}),
      startDate: body.start_date ?? body.startDate ?? "",
      endDate: body.end_date ?? body.endDate ?? "",
      ...(body.capital !== undefined ? { capital: Number(body.capital) } : {}),
      ...(body.costs ? { costs: body.costs } : {}),
      ...(body.rebalance ? { rebalance: body.rebalance } : {}),
      ...(body.top_n !== undefined || body.topN !== undefined
        ? { topN: Number(body.top_n ?? body.topN) }
        : {}),
      ...(body.longShort !== undefined ? { longShort: body.longShort } : {}),
      ...(body.benchmark ? { benchmark: body.benchmark } : {}),
      ...(body.provider_key ?? body.providerKey
        ? { providerKey: (body.provider_key ?? body.providerKey)! }
        : {}),
      workflowRunId: body.workflow_run_id ?? body.workflowRunId ?? null,
      agentInstanceId: body.agent_instance_id ?? body.agentInstanceId ?? null,
      createdBy: body.created_by ?? body.createdBy ?? "user",
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(asPromotionError(e), 400);
  }
});

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

/**
 * POST /api/v1/quant/strategy-contract/compile
 * Body: { code: string }
 * Prime 06：脚本工坊「验证」= Manifest 编译。
 */
quantRouter.post("/strategy-contract/compile", async (c) => {
  try {
    const body = await c.req.json<{
      code?: string;
      strategyCode?: string;
      sessionId?: string;
      workflowRunId?: string;
      scriptId?: string;
      name?: string;
      persist?: boolean;
    }>();
    const code = String(body.code ?? body.strategyCode ?? "").trim();
    if (!code) return c.json({ ok: false, error: "code_required" }, 400);
    const { compileStrategyContract } = await import(
      "../runtime/strategy/v2/contract-service"
    );
    const result = await compileStrategyContract(code);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 422);
    let persistMeta: Record<string, unknown> | undefined;
    const shouldPersist =
      body.persist !== false &&
      Boolean(
        String(body.sessionId ?? "").trim() ||
          String(body.workflowRunId ?? "").trim() ||
          String(body.scriptId ?? "").trim()
      );
    if (shouldPersist) {
      const { persistCompiledStrategyScript } = await import(
        "../runtime/strategy/v2/persist-compiled-script"
      );
      const persist = await persistCompiledStrategyScript({
        code,
        manifest: result.manifest,
        sessionId: body.sessionId,
        workflowRunId: body.workflowRunId,
        scriptId: body.scriptId,
        name: body.name,
      });
      persistMeta = persist.persisted
        ? {
            persisted: true,
            scriptId: persist.scriptId,
            scriptName: persist.name,
            created: persist.created,
            artifactDir: persist.artifactDir,
          }
        : { persisted: false, persistReason: persist.reason };
    }
    return c.json({
      ok: true,
      data: {
        ...result,
        ...(persistMeta ?? {}),
      },
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/**
 * POST /api/v1/quant/strategy-contract/backtest
 * Body: { code, symbol?, limit?, timeframe?, params?, initialCapital?, bars? }
 */
quantRouter.post("/strategy-contract/backtest", async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const code = String(body.code ?? body.strategyCode ?? "").trim();
    if (!code) return c.json({ ok: false, error: "code_required" }, 400);
    const {
      backtestStrategyContract,
      compileStrategyContract,
      instrumentIdToKlinesSymbol,
      primaryInstrumentId,
    } = await import("../runtime/strategy/v2/contract-service");
    const compiled = await compileStrategyContract(code);
    if (!compiled.ok) {
      return c.json({ ok: false, stage: "compile", error: compiled.error }, 422);
    }
    const instrumentId =
      String(body.symbol ?? "").trim() || primaryInstrumentId(compiled.manifest);
    const timeframe = String(
      body.timeframe ?? compiled.manifest.primaryFrequency ?? "1d"
    ).trim();
    const limit = Math.max(
      30,
      Math.min(Number(body.limit ?? 180) || 180, 2000)
    );
    let bars = Array.isArray(body.bars) ? body.bars : null;
    if (!bars) {
      const { queryKlines } = await import("../runtime/market/klines-query");
      const q = await queryKlines({
        symbol: instrumentIdToKlinesSymbol(instrumentId),
        timeframe,
        limit,
      });
      if (q.error || q.bars.length < 10) {
        return c.json(
          {
            ok: false,
            stage: "market_data",
            error: q.error?.message ?? `klines_insufficient:${q.bars.length}`,
            manifest: compiled.manifest,
          },
          422
        );
      }
      bars = q.bars;
    }
    const result = await backtestStrategyContract({
      strategyCode: code,
      bars: bars as never,
      symbol: instrumentId,
      initialCapital: Number(body.initialCapital ?? body.initial_capital ?? 100_000),
      commission: Number(body.commission ?? 0.001),
      ...(body.params && typeof body.params === "object"
        ? { params: body.params as Record<string, unknown> }
        : {}),
    });
    if (!result.ok) {
      return c.json({ ok: false, stage: "backtest", error: result.error }, 422);
    }
    return c.json({
      ok: true,
      data: {
        ...result,
        equityCurve: result.equityCurve.slice(-60),
        equityCurveFullLength: result.equityCurve.length,
        intents: result.intents.slice(0, 40),
        trades: result.trades.slice(0, 40),
      },
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/**
 * POST /api/v1/quant/strategy-contract/paper-deploy
 * Body: { code, paperCapital?, timeframe?, market?, params? }
 * 固定纸本金注册 PaperSession（进程内）；不等同于 strategy_runtime。
 */
quantRouter.post("/strategy-contract/paper-deploy", async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const code = String(body.code ?? body.strategyCode ?? "").trim();
    if (!code) return c.json({ ok: false, error: "code_required" }, 400);
    const {
      compileStrategyContract,
      primaryInstrumentId,
      instrumentIdToKlinesSymbol,
    } = await import("../runtime/strategy/v2/contract-service");
    const { createPaperSession } = await import(
      "../runtime/strategy/v2/paper-session-service"
    );
    const compiled = await compileStrategyContract(code);
    if (!compiled.ok) {
      return c.json({ ok: false, stage: "compile", error: compiled.error }, 422);
    }
    const instrumentId = primaryInstrumentId(compiled.manifest);
    const market =
      String(body.market ?? "").trim() ||
      (instrumentId.includes(":") ? instrumentId.split(":")[0]! : "US");
    const paperCapital = Number(body.paperCapital ?? body.paper_capital ?? 100_000);
    const session = createPaperSession({
      strategyCode: code,
      manifest: compiled.manifest,
      paperCapital: Number.isFinite(paperCapital) && paperCapital > 0 ? paperCapital : 100_000,
      primarySymbol: instrumentId,
      market,
      timeframe: String(
        body.timeframe ?? compiled.manifest.primaryFrequency ?? "1d"
      ).trim(),
      ...(body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? { params: body.params as Record<string, unknown> }
        : {}),
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      workflowRunId:
        typeof body.workflowRunId === "string" ? body.workflowRunId : null,
      strategyVersionId:
        typeof body.strategyVersionId === "string" ? body.strategyVersionId : null,
    });
    return c.json({
      ok: true,
      data: {
        sessionId: session.id,
        codeHash: session.codeHash,
        paperCapital: session.paperCapital,
        primarySymbol: session.primarySymbol,
        klinesSymbol: instrumentIdToKlinesSymbol(session.primarySymbol),
        manifest: compiled.manifest,
        sizingRule: "fixed_paper_capital",
      },
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/**
 * POST /api/v1/quant/strategy-contract/paper-run
 * Body: { sessionId?, code?, dryRun?, limit?, maxOrders? }
 * 默认 dryRun=true（工坊预览 intents）；写库需 workflow + strategyVersion。
 */
quantRouter.post("/strategy-contract/paper-run", async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const {
      getPaperSession,
      updatePaperSession,
      createPaperSession,
      tradesToPaperOrderDrafts,
    } = await import("../runtime/strategy/v2/paper-session-service");
    const {
      backtestStrategyContract,
      compileStrategyContract,
      instrumentIdToKlinesSymbol,
      primaryInstrumentId,
    } = await import("../runtime/strategy/v2/contract-service");

    let sessionId = String(body.sessionId ?? body.session_id ?? "").trim();
    if (!sessionId) {
      const code = String(body.code ?? body.strategyCode ?? "").trim();
      if (!code) return c.json({ ok: false, error: "sessionId_or_code_required" }, 400);
      const compiled = await compileStrategyContract(code);
      if (!compiled.ok) {
        return c.json({ ok: false, stage: "compile", error: compiled.error }, 422);
      }
      const instrumentId = primaryInstrumentId(compiled.manifest);
      const session = createPaperSession({
        strategyCode: code,
        manifest: compiled.manifest,
        paperCapital: Number(body.paperCapital ?? 100_000) || 100_000,
        primarySymbol: instrumentId,
        market:
          String(body.market ?? "").trim() ||
          (instrumentId.includes(":") ? instrumentId.split(":")[0]! : "US"),
      });
      sessionId = session.id;
    }

    const session = getPaperSession(sessionId);
    if (!session) {
      return c.json({ ok: false, error: `unknown_session:${sessionId}` }, 404);
    }

    const klinesSymbol = instrumentIdToKlinesSymbol(session.primarySymbol);
    const limit = Math.max(30, Math.min(Number(body.limit ?? 180) || 180, 2000));
    const { queryKlines } = await import("../runtime/market/klines-query");
    const q = await queryKlines({
      symbol: klinesSymbol,
      timeframe: session.timeframe,
      limit,
    });
    if (q.error || q.bars.length < 10) {
      updatePaperSession(sessionId, {
        status: "error",
        lastError: q.error?.message ?? "klines_insufficient",
      });
      return c.json(
        {
          ok: false,
          stage: "market_data",
          error: q.error?.message ?? `klines_insufficient:${q.bars.length}`,
          sessionId,
        },
        422
      );
    }

    const result = await backtestStrategyContract({
      strategyCode: session.strategyCode,
      bars: q.bars,
      symbol: session.primarySymbol,
      initialCapital: session.paperCapital,
      commission: Number(body.commission ?? 0.001) || 0.001,
      params: session.params,
    });
    if (!result.ok) {
      updatePaperSession(sessionId, { status: "error", lastError: result.error });
      return c.json({ ok: false, stage: "backtest", error: result.error, sessionId }, 422);
    }

    const dryRun = body.dryRun !== false && body.dry_run !== false;
    const drafts = tradesToPaperOrderDrafts(result.trades, {
      maxOrders: Math.max(1, Math.min(Number(body.maxOrders ?? 40) || 40, 100)),
    });

    const submitted: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];
    let strategyVersionId = String(
      body.strategyVersionId ?? body.strategy_version_id ?? session.strategyVersionId ?? ""
    ).trim();
    const workflowRunId = String(
      body.workflowRunId ?? body.workflow_run_id ?? session.workflowRunId ?? ""
    ).trim();
    const projectId = String(
      body.projectId ?? body.project_id ?? session.projectId ?? ""
    ).trim();

    if (!dryRun) {
      if (!workflowRunId) {
        return c.json(
          {
            ok: false,
            error: "write_requires_workflowRunId",
            hint: "从 Team/研究工作流打开的脚本才有 workflow；否则请用 dry_run 预览或启动纸交易引擎。",
            sessionId,
            orderDrafts: drafts.slice(0, 12),
          },
          422
        );
      }
      const { getDb } = await import("../db/sqlite/client");
      const db = await getDb();
      const { randomUUID } = await import("node:crypto");
      const {
        strategy: strategyTable,
        strategyVersion: strategyVersionTable,
        instrument: instrumentTable,
      } = await import("../db/sqlite/schema");
      const { eq, and } = await import("drizzle-orm");
      const { createOrderIntentWithExecution } = await import(
        "../runtime/execution/order-intent-service"
      );

      if (!strategyVersionId && projectId) {
        const name =
          String(body.name ?? "").trim() ||
          `contract_${session.codeHash.slice(0, 8)}`;
        const existing = await db
          .select()
          .from(strategyTable)
          .where(and(eq(strategyTable.projectId, projectId), eq(strategyTable.name, name)))
          .limit(1);
        let strategyId = existing[0]?.id;
        if (!strategyId) {
          strategyId = randomUUID();
          await db.insert(strategyTable).values({
            id: strategyId,
            projectId,
            name,
            style: "low_freq",
            description: `Strategy API paper · ${session.codeHash.slice(0, 12)}`,
          });
        }
        strategyVersionId = randomUUID();
        await db.insert(strategyVersionTable).values({
          id: strategyVersionId,
          strategyId,
          versionTag: `paper-${Date.now()}`,
          logicHash: session.codeHash.slice(0, 32),
          paramSchemaJson: {
            strategyManifest: session.manifest,
            codeHash: session.codeHash,
            paperCapital: session.paperCapital,
            source: "quant.paper-run",
          } as never,
          workflowRunId,
        });
        updatePaperSession(sessionId, { strategyVersionId, workflowRunId });
      }

      if (!strategyVersionId) {
        return c.json(
          {
            ok: false,
            error: "write_requires_strategyVersionId_or_projectId",
            sessionId,
          },
          422
        );
      }

      const symForBook = instrumentIdToKlinesSymbol(session.primarySymbol);
      let instrumentRowId = "";
      {
        const existing = await db
          .select()
          .from(instrumentTable)
          .where(eq(instrumentTable.symbol, symForBook.toUpperCase()))
          .limit(1);
        if (existing[0]) instrumentRowId = existing[0].id;
        else {
          instrumentRowId = randomUUID();
          await db.insert(instrumentTable).values({
            id: instrumentRowId,
            symbol: symForBook.toUpperCase(),
            assetClass: "stock",
            exchange: session.market,
            metaJson: { source: "quant.paper-run" },
          });
        }
      }

      for (const d of drafts) {
        try {
          const r = await createOrderIntentWithExecution(db, {
            workflowRunId,
            strategyVersionId,
            instrumentId: instrumentRowId,
            side: d.side,
            qty: d.qty,
            orderType: "limit",
            price: d.price,
            timeInForce: "day",
            market: session.market,
            symbol: symForBook,
            timeframe: session.timeframe,
            signalBarTime: d.signalBarTime || null,
            dispatchMode: "paper",
            requireDataQualityGate: false,
            clientOrderId: `paper:${sessionId}:${d.signalBarTime}:${d.side}:${d.qty}`,
          });
          submitted.push({
            orderIntentId: r.orderIntentId,
            riskOutcome: r.riskOutcome,
            side: d.side,
            qty: d.qty,
          });
        } catch (e) {
          skipped.push({
            side: d.side,
            qty: d.qty,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    updatePaperSession(sessionId, {
      status: "ready",
      intentCount: (session.intentCount ?? 0) + submitted.length,
      lastRunAt: new Date().toISOString(),
      lastError: null,
    });

    return c.json({
      ok: true,
      data: {
        sessionId,
        codeHash: session.codeHash,
        paperCapital: session.paperCapital,
        sizingRule: "fixed_paper_capital",
        dryRun,
        strategyVersionId: strategyVersionId || null,
        workflowRunId: workflowRunId || null,
        metrics: result.metrics,
        tradeCount: result.trades.length,
        orderDrafts: drafts.slice(0, 20),
        intents: result.intents.slice(0, 20),
        submittedCount: submitted.length,
        submitted: submitted.slice(0, 20),
        skipped,
        note: dryRun
          ? "dry_run：仅预览 intents。传 dryRun=false + workflowRunId（+ projectId）可写 paper order_intent。"
          : `已写入 ${submitted.length} 笔 paper order_intent。`,
      },
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});
