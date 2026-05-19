import { Hono } from "hono";
import { runPlatformBootstrap } from "../runtime/bootstrap/packaged-setup";
import { isPackagedRuntime } from "../runtime/app-paths";

export const systemRouter = new Hono();

systemRouter.get("/info", (c) =>
  c.json({
    ok: true,
    data: {
      packaged: isPackagedRuntime(),
      dataDir: process.env["QUBIT_DATA_DIR"] ?? null,
      appRoot: process.env["QUBIT_APP_ROOT"] ?? null,
    },
  })
);

/** 一键初始化：数据库迁移 + Agent/MCP/Tool 种子 + Python venv（若尚未创建） */
systemRouter.post("/bootstrap", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { skipPython?: boolean };
  try {
    const result = await runPlatformBootstrap({ skipPython: body.skipPython === true });
    return c.json({ ok: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: message }, 500);
  }
});
