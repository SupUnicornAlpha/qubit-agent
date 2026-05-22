import { Hono } from "hono";
import { runPlatformBootstrap } from "../runtime/bootstrap/packaged-setup";
import { isPackagedRuntime } from "../runtime/app-paths";
import { checkPythonHealth } from "../runtime/sandbox/python-runtime";

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

/**
 * Python 运行时健康状态：解释器路径 / 版本 / 关键依赖（pandas/numpy/scipy）。
 * 用于：
 *   - 前端"系统设置"展示红黄绿三态
 *   - 运维诊断 code.run_python 失败
 *   - bootstrap 后验证 venv 是否生效（?force=true 跳过 60s 缓存）
 */
systemRouter.get("/python-health", async (c) => {
  const force = c.req.query("force") === "true";
  const report = await checkPythonHealth({ force });
  return c.json({ ok: report.ok, data: report });
});
