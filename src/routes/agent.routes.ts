import { Hono } from "hono";
import { ALL_AGENTS } from "../agents";

export const agentRouter = new Hono();

agentRouter.get("/", (c) => {
  const agents = ALL_AGENTS.map((a) => ({
    id: a.id,
    role: a.role,
    version: a.version,
    running: (a as { running?: boolean }).running ?? false,
  }));
  return c.json({ data: agents });
});
