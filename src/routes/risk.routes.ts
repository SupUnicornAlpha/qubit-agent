import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { riskVetoLog } from "../db/sqlite/schema";
import { loadRiskConfig, saveRiskConfig } from "../runtime/config/risk-config";

export const riskRouter = new Hono();

riskRouter.get("/config", async (c) => {
  const data = await loadRiskConfig();
  return c.json({ ok: true, data });
});

riskRouter.put("/config", async (c) => {
  const body = await c.req.json<{
    vetoThreshold?: number;
    blockConfidenceThreshold?: number;
    severityMode?: "conservative" | "balanced" | "aggressive";
  }>();
  const data = await saveRiskConfig(body);
  return c.json({ ok: true, data });
});

riskRouter.get("/veto-logs/:workflowId", async (c) => {
  const workflowId = c.req.param("workflowId");
  const db = await getDb();
  const rows = await db
    .select()
    .from(riskVetoLog)
    .where(eq(riskVetoLog.workflowRunId, workflowId))
    .orderBy(desc(riskVetoLog.createdAt));
  return c.json({ ok: true, data: rows });
});
