import { Hono } from "hono";
import { buildObservationTree } from "../runtime/eval-platform/observation-tree";
import { listScores, summarizeScoresByName } from "../runtime/eval-platform/score-query";
import { persistWorkflowEvalScores } from "../runtime/eval-platform/orchestrator";
import {
  addWorkflowToDataset,
  createDatasetItem,
  deleteDatasetItem,
  getDatasetItem,
  listDatasetItems,
  updateDatasetItem,
} from "../runtime/eval-platform/dataset/dataset-item-service";
import {
  diffExperimentRuns,
  runExperiment,
} from "../runtime/eval-platform/experiment/experiment-runner";
import {
  compareScoreWindows,
  queryScoreDailyRollup,
} from "../runtime/eval-platform/analytics/score-analytics";
import { listEnabledLlmJudgeEvaluators, loadEvaluatorConfigs } from "../runtime/eval-platform/evaluators/registry";
import { flushAsyncEvalQueueForTesting } from "../runtime/eval-platform/async-eval/queue";
import { rollupSessionScores } from "../runtime/eval-platform/session/session-score-rollup";
import {
  exportWorkflowAnnotationsToGolden,
  listHumanAnnotations,
  submitHumanAnnotation,
} from "../runtime/eval-platform/annotation/human-annotation-service";
import {
  submitChatMessageFeedback,
  submitWorkflowFeedback,
} from "../runtime/eval-platform/feedback/user-feedback-service";

export const agentEvalRouter = new Hono();

agentEvalRouter.get("/scores", async (c) => {
  const workflowRunId = c.req.query("workflowRunId")?.trim();
  const sessionId = c.req.query("sessionId")?.trim();
  const name = c.req.query("name")?.trim();
  const since = c.req.query("since")?.trim();
  const limitRaw = c.req.query("limit");
  if (!workflowRunId && !sessionId && !name) {
    return c.json(
      { ok: false, error: "at least one of workflowRunId, sessionId, or name is required" },
      400
    );
  }
  const input: Parameters<typeof listScores>[0] = {};
  if (workflowRunId) input.workflowRunId = workflowRunId;
  if (sessionId) input.sessionId = sessionId;
  if (name) input.name = name;
  if (since) input.since = since;
  if (limitRaw) input.limit = Number(limitRaw);
  return c.json({ ok: true, data: await listScores(input) });
});

agentEvalRouter.get("/scores/summary", async (c) => {
  const namesRaw = c.req.query("names")?.trim();
  const since = c.req.query("since")?.trim();
  const names =
    namesRaw?.split(",").map((item) => item.trim()).filter(Boolean) ??
    ["aqm.weighted_score", "benchmark.overall.score"];
  return c.json({ ok: true, data: await summarizeScoresByName(names, since) });
});

agentEvalRouter.get("/scores/analytics/daily", async (c) => {
  const names = c.req.query("names")?.split(",").map((s) => s.trim()).filter(Boolean);
  const since = c.req.query("since")?.trim();
  const until = c.req.query("until")?.trim();
  const data = await queryScoreDailyRollup({
    ...(names?.length ? { names } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  });
  return c.json({ ok: true, data });
});

agentEvalRouter.get("/scores/analytics/compare", async (c) => {
  const name = c.req.query("name")?.trim();
  if (!name) return c.json({ ok: false, error: "name is required" }, 400);
  const recentDays = Number(c.req.query("recentDays") ?? "7");
  return c.json({ ok: true, data: await compareScoreWindows({ name, recentDays }) });
});

agentEvalRouter.get("/workflows/:workflowRunId/observations", async (c) => {
  const workflowRunId = c.req.param("workflowRunId");
  const data = await buildObservationTree(workflowRunId);
  if (!data) return c.json({ ok: false, error: "workflow not found", workflowRunId }, 404);
  return c.json({ ok: true, data });
});

agentEvalRouter.post("/workflows/:workflowRunId/persist-scores", async (c) => {
  const workflowRunId = c.req.param("workflowRunId");
  const body = await c.req
    .json<{ configFingerprint?: string }>()
    .catch(() => ({}) as { configFingerprint?: string });
  const data = await persistWorkflowEvalScores({
    workflowRunId,
    ...(body.configFingerprint ? { configFingerprint: body.configFingerprint } : {}),
  });
  return c.json({ ok: true, data });
});

agentEvalRouter.get("/datasets/:datasetId/items", async (c) => {
  const datasetId = c.req.param("datasetId");
  return c.json({ ok: true, data: await listDatasetItems(datasetId) });
});

agentEvalRouter.post("/datasets/:datasetId/items", async (c) => {
  const datasetId = c.req.param("datasetId");
  const body = await c.req
    .json<{
      caseKey?: string;
      inputJson?: Record<string, unknown>;
      expectedJson?: Record<string, unknown>;
      metadataJson?: Record<string, unknown>;
      sourceWorkflowRunId?: string;
    }>()
    .catch(() => ({}));
  if (!body.caseKey) return c.json({ ok: false, error: "caseKey is required" }, 400);
  const data = await createDatasetItem({
    datasetId,
    caseKey: body.caseKey,
    inputJson: body.inputJson ?? {},
    expectedJson: body.expectedJson ?? {},
    metadataJson: body.metadataJson ?? {},
    ...(body.sourceWorkflowRunId ? { sourceWorkflowRunId: body.sourceWorkflowRunId } : {}),
  });
  return c.json({ ok: true, data });
});

agentEvalRouter.post("/datasets/:datasetId/items/from-trace", async (c) => {
  const datasetId = c.req.param("datasetId");
  const body = await c.req
    .json<{
      workflowRunId?: string;
      caseKey?: string;
      expectedJson?: Record<string, unknown>;
      metadataJson?: Record<string, unknown>;
    }>()
    .catch(() => ({}));
  if (!body.workflowRunId) return c.json({ ok: false, error: "workflowRunId is required" }, 400);
  const data = await addWorkflowToDataset({
    datasetId,
    workflowRunId: body.workflowRunId,
    ...(body.caseKey ? { caseKey: body.caseKey } : {}),
    ...(body.expectedJson ? { expectedJson: body.expectedJson } : {}),
    ...(body.metadataJson ? { metadataJson: body.metadataJson } : {}),
  });
  return c.json({ ok: true, data });
});

agentEvalRouter.get("/dataset-items/:itemId", async (c) => {
  const data = await getDatasetItem(c.req.param("itemId"));
  if (!data) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true, data });
});

agentEvalRouter.patch("/dataset-items/:itemId", async (c) => {
  const body = await c.req
    .json<{
      caseKey?: string;
      inputJson?: Record<string, unknown>;
      expectedJson?: Record<string, unknown>;
      metadataJson?: Record<string, unknown>;
      sourceWorkflowRunId?: string | null;
    }>()
    .catch(() => ({}));
  const data = await updateDatasetItem(c.req.param("itemId"), body);
  if (!data) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true, data });
});

agentEvalRouter.delete("/dataset-items/:itemId", async (c) => {
  const ok = await deleteDatasetItem(c.req.param("itemId"));
  if (!ok) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true, data: { deleted: true } });
});

agentEvalRouter.post("/experiments/run", async (c) => {
  const body = await c.req
    .json<{
      datasetId?: string;
      experimentLabel?: string;
      configFingerprint?: string;
      projectId?: string;
      baselineRunId?: string;
      mode?: "replay" | "launch";
      waitTimeoutMs?: number;
    }>()
    .catch(() => ({}));
  if (!body.datasetId || !body.experimentLabel || !body.configFingerprint || !body.projectId) {
    return c.json(
      {
        ok: false,
        error: "datasetId, experimentLabel, configFingerprint, projectId are required",
      },
      400
    );
  }
  const data = await runExperiment({
    datasetId: body.datasetId,
    experimentLabel: body.experimentLabel,
    configFingerprint: body.configFingerprint,
    projectId: body.projectId,
    ...(body.baselineRunId ? { baselineRunId: body.baselineRunId } : {}),
    ...(body.mode ? { mode: body.mode } : {}),
    ...(body.waitTimeoutMs !== undefined ? { waitTimeoutMs: body.waitTimeoutMs } : {}),
  });
  return c.json({ ok: true, data });
});

agentEvalRouter.get("/experiments/diff", async (c) => {
  const baselineRunId = c.req.query("baselineRunId")?.trim();
  const challengerRunId = c.req.query("challengerRunId")?.trim();
  if (!baselineRunId || !challengerRunId) {
    return c.json({ ok: false, error: "baselineRunId and challengerRunId are required" }, 400);
  }
  return c.json({ ok: true, data: await diffExperimentRuns(baselineRunId, challengerRunId) });
});

agentEvalRouter.get("/evaluators", async (c) => {
  return c.json({
    ok: true,
    data: {
      configs: loadEvaluatorConfigs(),
      enabledLlmJudges: listEnabledLlmJudgeEvaluators(),
    },
  });
});

/** 调试：同步 drain async eval 队列（仅 dev / test） */
agentEvalRouter.post("/async-eval/flush", async (c) => {
  if (process.env.NODE_ENV === "production") {
    return c.json({ ok: false, error: "not available in production" }, 403);
  }
  await flushAsyncEvalQueueForTesting();
  return c.json({ ok: true, data: { flushed: true } });
});

agentEvalRouter.get("/sessions/:sessionId/scores", async (c) => {
  const sessionId = c.req.param("sessionId");
  const data = await rollupSessionScores(sessionId);
  if (!data) return c.json({ ok: false, error: "session not found" }, 404);
  return c.json({ ok: true, data });
});

agentEvalRouter.get("/workflows/:workflowRunId/annotations", async (c) => {
  const data = await listHumanAnnotations(c.req.param("workflowRunId"));
  return c.json({ ok: true, data });
});

agentEvalRouter.post("/workflows/:workflowRunId/annotations", async (c) => {
  const body = await c.req
    .json<{
      name?: string;
      dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | "TEXT";
      value?: number | string | boolean;
      comment?: string;
      observationId?: string;
      actor?: string;
    }>()
    .catch(() => ({}));
  if (body.dataType === undefined || body.value === undefined) {
    return c.json({ ok: false, error: "dataType and value are required" }, 400);
  }
  try {
    const data = await submitHumanAnnotation({
      workflowRunId: c.req.param("workflowRunId"),
      dataType: body.dataType,
      value: body.value,
      ...(body.name ? { name: body.name } : {}),
      ...(body.comment ? { comment: body.comment } : {}),
      ...(body.observationId ? { observationId: body.observationId } : {}),
      ...(body.actor ? { actor: body.actor } : {}),
    });
    return c.json({ ok: true, data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.startsWith("eval_platform_forbidden") ? 403 : 400;
    return c.json({ ok: false, error: msg }, status);
  }
});

agentEvalRouter.post("/workflows/:workflowRunId/export-golden", async (c) => {
  const body = await c.req
    .json<{ datasetId?: string; caseKey?: string; actor?: string }>()
    .catch(() => ({}));
  if (!body.datasetId) return c.json({ ok: false, error: "datasetId is required" }, 400);
  try {
    const data = await exportWorkflowAnnotationsToGolden({
      datasetId: body.datasetId,
      workflowRunId: c.req.param("workflowRunId"),
      ...(body.caseKey ? { caseKey: body.caseKey } : {}),
      ...(body.actor ? { actor: body.actor } : {}),
    });
    return c.json({ ok: true, data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.startsWith("eval_platform_forbidden") ? 403 : 400;
    return c.json({ ok: false, error: msg }, status);
  }
});

agentEvalRouter.post("/workflows/:workflowRunId/feedback", async (c) => {
  const body = await c.req
    .json<{ helpful?: boolean; comment?: string; actor?: string }>()
    .catch(() => ({}));
  if (typeof body.helpful !== "boolean") {
    return c.json({ ok: false, error: "helpful boolean is required" }, 400);
  }
  const data = await submitWorkflowFeedback({
    workflowRunId: c.req.param("workflowRunId"),
    helpful: body.helpful,
    ...(body.comment ? { comment: body.comment } : {}),
    ...(body.actor ? { actor: body.actor } : {}),
  });
  return c.json({ ok: true, data });
});

agentEvalRouter.post("/chat-messages/:chatMessageId/feedback", async (c) => {
  const body = await c.req
    .json<{ helpful?: boolean; comment?: string; actor?: string }>()
    .catch(() => ({}));
  if (typeof body.helpful !== "boolean") {
    return c.json({ ok: false, error: "helpful boolean is required" }, 400);
  }
  try {
    const data = await submitChatMessageFeedback({
      chatMessageId: c.req.param("chatMessageId"),
      helpful: body.helpful,
      ...(body.comment ? { comment: body.comment } : {}),
      ...(body.actor ? { actor: body.actor } : {}),
    });
    return c.json({ ok: true, data });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
