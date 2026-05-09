import { Hono } from "hono";
import {
  applyBacktestResult,
  evolveNextGeneration,
  initGenePool,
  listGeneGenerations,
  listGenerationTrends,
  listGenomesByGeneration,
} from "../runtime/gene/gene-pool";

export const geneRouter = new Hono();

geneRouter.post("/init", async (c) => {
  const body = await c.req.json<{ projectId: string; populationSize?: number; mutationRate?: number }>();
  if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
  const data = await initGenePool(body);
  return c.json({ ok: true, data });
});

geneRouter.post("/backtest-result", async (c) => {
  const body = await c.req.json<{
    genomeId: string;
    backtestRunId?: string;
    sharpeRatio: number;
    maxDrawdown: number;
    totalReturn: number;
  }>();
  if (!body.genomeId) return c.json({ error: "genomeId is required" }, 400);
  const data = await applyBacktestResult(body);
  return c.json({ ok: true, data });
});

geneRouter.post("/evolve", async (c) => {
  const body = await c.req.json<{ projectId: string }>();
  if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
  const data = await evolveNextGeneration({ projectId: body.projectId });
  return c.json({ ok: true, data });
});

geneRouter.get("/generations/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const data = await listGeneGenerations(projectId);
  return c.json({ ok: true, data });
});

geneRouter.get("/genomes/:generationId", async (c) => {
  const generationId = c.req.param("generationId");
  const data = await listGenomesByGeneration(generationId);
  return c.json({ ok: true, data });
});

geneRouter.get("/trends/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const data = await listGenerationTrends(projectId);
  return c.json({ ok: true, data });
});
