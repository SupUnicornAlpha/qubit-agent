/**
 * /api/v1/environment 路由集成测 — 不依赖真实 pip / bun add（不联网）。
 *
 * 覆盖：
 *   - GET /status → 200 + ok/warn/error 字段；env_registry 可见
 *   - GET /registry?kind=python|npm
 *   - POST/PATCH/DELETE /registry 业务规则与错误码
 *   - install/uninstall 端点的安全校验（包名 / 版本注入）
 *   - GET /install-log filter
 *
 * 真实 pip install 行为（异步任务 → log status=success）通过手动 smoke
 * 测试验证；CI 上跑会引入网络依赖与时长波动，得不偿失。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { config } from "../../../config";
import { runMigrations } from "../../../db/sqlite/migrate";
import { seedEnvRegistry } from "../seed-env-registry";

async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * 该测试要求外部以 `QUBIT_DATA_DIR=/tmp/...` 启动 bun test —— config 在
 * module-import 时立刻 frozen，没法在 beforeAll 中改。与同目录其它
 * env-mgr 测试约定一致（同时可让 npm-deps 复用 mcp-bin/node_modules）。
 */
describe("/api/v1/environment routes", () => {
  let app: { request: (req: Request) => Promise<Response> };

  beforeAll(async () => {
    expect(config.dataDir).toMatch(/\/tmp\//);
    await runMigrations();
    await seedEnvRegistry([]); // 用空 mcp presets，避免 fmp/financex 干扰
    const server = await import("../../../server");
    app = server.app;
  });

  test("GET /status → 200 + summary", async () => {
    const res = await app.request(new Request("http://t/api/v1/environment/status"));
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      ok: boolean;
      data: {
        ok: "ok" | "warn" | "error";
        summary: string;
        python: { expected: unknown[] };
        npm: { expected: unknown[] };
      };
    }>(res);
    expect(body.ok).toBe(true);
    expect(["ok", "warn", "error"]).toContain(body.data.ok);
    expect(typeof body.data.summary).toBe("string");
    // python 期望清单含我们 seed 的 yfinance / pandas / akshare
    expect(body.data.python.expected.length).toBeGreaterThan(0);
  });

  test("GET /registry?kind=python 仅返回 python 项", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/environment/registry?kind=python")
    );
    expect(res.status).toBe(200);
    const body = await jsonOf<{ data: Array<{ kind: string; name: string }> }>(res);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((it) => it.kind === "python")).toBe(true);
    expect(body.data.some((it) => it.name === "yfinance")).toBe(true);
  });

  test("GET /registry?kind=invalid → 400", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/environment/registry?kind=go")
    );
    expect(res.status).toBe(400);
  });

  test("POST /registry 创建 + DELETE", async () => {
    const created = await app.request(
      new Request("http://t/api/v1/environment/registry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "python",
          packageName: "scipy",
          displayName: "SciPy",
          versionSpec: ">=1.13",
          capability: "user/scientific",
        }),
      })
    );
    expect(created.status).toBe(201);
    const cb = await jsonOf<{ data: { id: string; isBuiltin: boolean } }>(created);
    expect(cb.data.isBuiltin).toBe(false);
    const id = cb.data.id;

    const del = await app.request(
      new Request(`http://t/api/v1/environment/registry/${id}`, { method: "DELETE" })
    );
    expect(del.status).toBe(200);
  });

  test("POST /registry 同名 → 409 duplicate", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/environment/registry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "python",
          packageName: "yfinance", // seed 已建过
          displayName: "dup",
        }),
      })
    );
    expect(res.status).toBe(409);
    const body = await jsonOf<{ code: string }>(res);
    expect(body.code).toBe("duplicate");
  });

  test("DELETE 系统项 → 409 builtin_protected", async () => {
    const list = await app.request(
      new Request("http://t/api/v1/environment/registry?kind=python")
    );
    const lb = await jsonOf<{ data: Array<{ id: string; name: string; isBuiltin: boolean }> }>(
      list
    );
    const yfin = lb.data.find((p) => p.name === "yfinance" && p.isBuiltin)!;
    expect(yfin).toBeTruthy();
    const del = await app.request(
      new Request(`http://t/api/v1/environment/registry/${yfin.id}`, { method: "DELETE" })
    );
    expect(del.status).toBe(409);
    const body = await jsonOf<{ code: string }>(del);
    expect(body.code).toBe("builtin_protected");
  });

  test("PATCH /registry/:id 更新 status", async () => {
    const list = await app.request(
      new Request("http://t/api/v1/environment/registry?kind=python")
    );
    const lb = await jsonOf<{ data: Array<{ id: string; name: string }> }>(list);
    const yfin = lb.data.find((p) => p.name === "yfinance")!;

    const patch = await app.request(
      new Request(`http://t/api/v1/environment/registry/${yfin.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "disabled" }),
      })
    );
    expect(patch.status).toBe(200);
    const pb = await jsonOf<{ data: { status: string } }>(patch);
    expect(pb.data.status).toBe("disabled");

    // 还原
    await app.request(
      new Request(`http://t/api/v1/environment/registry/${yfin.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "enabled" }),
      })
    );
  });

  test("POST /python/install 缺 packageName → 400", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/environment/python/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
  });

  test("POST /python/install 非法包名 → 400 invalid_package_name", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/environment/python/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packageName: "bad; rm -rf /" }),
      })
    );
    expect(res.status).toBe(400);
    const body = await jsonOf<{ code: string }>(res);
    expect(body.code).toBe("invalid_package_name");
  });

  test("POST /npm/install 非法版本 → 400 invalid_version", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/environment/npm/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          packageName: "mcp-foo",
          version: "1.0; cat /etc/passwd",
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await jsonOf<{ code: string }>(res);
    expect(body.code).toBe("invalid_version");
  });

  test("GET /install-log 空表 → ok=true, data=[]", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/environment/install-log")
    );
    expect(res.status).toBe(200);
    const body = await jsonOf<{ ok: boolean; data: unknown[] }>(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("GET /install-log?kind=invalid → 400", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/environment/install-log?kind=go")
    );
    expect(res.status).toBe(400);
  });
});
