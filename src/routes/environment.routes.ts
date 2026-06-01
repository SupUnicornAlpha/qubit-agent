/**
 * /api/v1/environment — EnvironmentManager 路由（DESIGN §6.6）
 *
 * 端点（10 个）：
 *   - GET    /status                       顶层聚合（diff + connector probes）
 *   - GET    /registry?kind=python|npm     期望清单（env_registry）
 *   - POST   /registry                     新建用户自定义项
 *   - PATCH  /registry/:id                 更新（status / userVersionSpec / 用户项 displayName 等）
 *   - DELETE /registry/:id                 删除（仅用户项）
 *   - POST   /python/install               { packageName, versionSpec? } → { logId }
 *   - POST   /python/uninstall             { packageName }                → { logId }
 *   - POST   /npm/install                  { packageName, version? }      → { logId }
 *   - POST   /npm/uninstall                { packageName }                → { logId }
 *   - GET    /install-log?packageName=&kind=&limit=
 *
 * 错误规范：
 *   - 校验失败 → 400 + { ok:false, code }
 *   - 资源不存在 → 404
 *   - 业务规则拒绝（builtin_protected / duplicate）→ 409
 *   - 子进程 / DB 故障 → 500 + { ok:false, code:"internal" }（堆栈不外泄）
 */

import { Hono } from "hono";
import {
  EnvRegistryError,
  envRegistryService,
} from "../runtime/environment/registry-service";
import {
  installPython,
  PythonDepsError,
  uninstallPython,
} from "../runtime/environment/python-deps";
import {
  installNpm,
  NpmDepsError,
  uninstallNpm,
} from "../runtime/environment/npm-deps";
import { getEnvironmentStatus } from "../runtime/environment/status";
import { envInstallLogService } from "../runtime/environment/install-log-service";
import type { EnvKind } from "../runtime/environment/types";

export const environmentRouter = new Hono();

/* ───────────────────────── /status ───────────────────────── */

environmentRouter.get("/status", async (c) => {
  try {
    const status = await getEnvironmentStatus();
    return c.json({ ok: true, data: status });
  } catch (e) {
    return c.json(
      { ok: false, code: "internal", error: (e as Error).message },
      500
    );
  }
});

/* ───────────────────────── /registry CRUD ───────────────────────── */

environmentRouter.get("/registry", async (c) => {
  const kindQ = c.req.query("kind");
  if (kindQ && kindQ !== "python" && kindQ !== "npm") {
    return c.json({ ok: false, code: "invalid_kind" }, 400);
  }
  const list = await envRegistryService.list({
    ...(kindQ ? { kind: kindQ as EnvKind } : {}),
  });
  return c.json({ ok: true, data: list });
});

environmentRouter.post("/registry", async (c) => {
  let body: {
    kind?: EnvKind;
    packageName?: string;
    displayName?: string;
    description?: string;
    versionSpec?: string | null;
    optional?: boolean;
    capability?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, code: "invalid_body" }, 400);
  }

  if (!body.kind || !body.packageName || !body.displayName) {
    return c.json({ ok: false, code: "missing_fields" }, 400);
  }
  try {
    const created = await envRegistryService.createUserItem({
      kind: body.kind,
      packageName: body.packageName,
      displayName: body.displayName,
      description: body.description,
      versionSpec: body.versionSpec ?? null,
      optional: body.optional,
      capability: body.capability,
    });
    return c.json({ ok: true, data: created }, 201);
  } catch (e) {
    return mapEnvRegistryError(c, e);
  }
});

environmentRouter.patch("/registry/:id", async (c) => {
  const id = c.req.param("id");
  let body: Parameters<typeof envRegistryService.update>[1];
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, code: "invalid_body" }, 400);
  }
  try {
    const updated = await envRegistryService.update(id, body);
    return c.json({ ok: true, data: updated });
  } catch (e) {
    return mapEnvRegistryError(c, e);
  }
});

environmentRouter.delete("/registry/:id", async (c) => {
  try {
    await envRegistryService.remove(c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    return mapEnvRegistryError(c, e);
  }
});

/* ───────────────────────── /python install/uninstall ───────────────────────── */

environmentRouter.post("/python/install", async (c) => {
  let body: { packageName?: string; versionSpec?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, code: "invalid_body" }, 400);
  }
  if (!body.packageName) {
    return c.json({ ok: false, code: "missing_fields" }, 400);
  }
  try {
    const r = await installPython({
      packageName: body.packageName,
      versionSpec: body.versionSpec ?? null,
    });
    // 不 await r.done —— 异步任务，前端轮询 /install-log
    return c.json({ ok: true, data: { logId: r.logId } }, 202);
  } catch (e) {
    return mapPythonError(c, e);
  }
});

environmentRouter.post("/python/uninstall", async (c) => {
  let body: { packageName?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, code: "invalid_body" }, 400);
  }
  if (!body.packageName) return c.json({ ok: false, code: "missing_fields" }, 400);
  try {
    const r = await uninstallPython({ packageName: body.packageName });
    return c.json({ ok: true, data: { logId: r.logId } }, 202);
  } catch (e) {
    return mapPythonError(c, e);
  }
});

/* ───────────────────────── /npm install/uninstall ───────────────────────── */

environmentRouter.post("/npm/install", async (c) => {
  let body: { packageName?: string; version?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, code: "invalid_body" }, 400);
  }
  if (!body.packageName) return c.json({ ok: false, code: "missing_fields" }, 400);
  try {
    const r = await installNpm({
      packageName: body.packageName,
      version: body.version ?? null,
    });
    return c.json({ ok: true, data: { logId: r.logId } }, 202);
  } catch (e) {
    return mapNpmError(c, e);
  }
});

environmentRouter.post("/npm/uninstall", async (c) => {
  let body: { packageName?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, code: "invalid_body" }, 400);
  }
  if (!body.packageName) return c.json({ ok: false, code: "missing_fields" }, 400);
  try {
    const r = await uninstallNpm({ packageName: body.packageName });
    return c.json({ ok: true, data: { logId: r.logId } }, 202);
  } catch (e) {
    return mapNpmError(c, e);
  }
});

/* ───────────────────────── /install-log ───────────────────────── */

environmentRouter.get("/install-log", async (c) => {
  const kindQ = c.req.query("kind");
  if (kindQ && kindQ !== "python" && kindQ !== "npm") {
    return c.json({ ok: false, code: "invalid_kind" }, 400);
  }
  const limitQ = Number.parseInt(c.req.query("limit") ?? "", 10);
  const filter = {
    ...(kindQ ? { kind: kindQ as EnvKind } : {}),
    ...(c.req.query("packageName")
      ? { packageName: c.req.query("packageName") as string }
      : {}),
    ...(Number.isFinite(limitQ) && limitQ > 0 ? { limit: limitQ } : {}),
  };
  const list = await envInstallLogService.list(filter);
  return c.json({ ok: true, data: list });
});

/* ───────────────────────── error mapping ───────────────────────── */

type RouteContext = Parameters<Parameters<typeof environmentRouter.get>[1]>[0];

function mapEnvRegistryError(c: RouteContext, e: unknown) {
  if (e instanceof EnvRegistryError) {
    if (e.code === "not_found") return c.json({ ok: false, code: e.code }, 404);
    if (e.code === "builtin_protected" || e.code === "duplicate")
      return c.json({ ok: false, code: e.code }, 409);
    return c.json({ ok: false, code: e.code }, 400);
  }
  return c.json({ ok: false, code: "internal", error: (e as Error).message }, 500);
}

function mapPythonError(c: RouteContext, e: unknown) {
  if (e instanceof PythonDepsError) {
    if (e.code === "invalid_package_name" || e.code === "invalid_version_spec") {
      return c.json({ ok: false, code: e.code }, 400);
    }
    return c.json({ ok: false, code: e.code }, 500);
  }
  return c.json({ ok: false, code: "internal", error: (e as Error).message }, 500);
}

function mapNpmError(c: RouteContext, e: unknown) {
  if (e instanceof NpmDepsError) {
    if (e.code === "invalid_package_name" || e.code === "invalid_version") {
      return c.json({ ok: false, code: e.code }, 400);
    }
    return c.json({ ok: false, code: e.code }, 500);
  }
  return c.json({ ok: false, code: "internal", error: (e as Error).message }, 500);
}
