/**
 * P1-2 单测：requirements / npx 解析、seed upsert 幂等 / 不覆盖用户编辑、
 * registry-service CRUD 业务规则。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import { envRegistry } from "../../../db/sqlite/schema";
import { envRegistryService, EnvRegistryError } from "../registry-service";
import {
  parseNpxCommand,
  parseRequirementsTxt,
  seedEnvRegistry,
} from "../seed-env-registry";

beforeAll(async () => {
  await runMigrations();
  // 干净起步：删除 env_registry 全部行（只在 test 环境）
  const db = await getDb();
  await db.delete(envRegistry).execute();
});

describe("parseRequirementsTxt", () => {
  test("跳过空行 / 注释 / -r 指令", () => {
    const out = parseRequirementsTxt(
      [
        "# Core",
        "numpy>=1.26.0",
        "",
        "# pandas>=2.2.0  # 整行注释",
        "pandas>=2.2.0",
        "akshare>=1.12.0  # 行尾注释",
        "yfinance>=0.2.40",
        "-r dev-requirements.txt",
      ].join("\n")
    );
    expect(out.get("numpy")).toBe(">=1.26.0");
    expect(out.get("pandas")).toBe(">=2.2.0");
    expect(out.get("akshare")).toBe(">=1.12.0");
    expect(out.get("yfinance")).toBe(">=0.2.40");
    // commented-out 行不进 map
    expect(out.has("tushare")).toBe(false);
  });

  test("无版本约束 → null spec", () => {
    expect(parseRequirementsTxt("requests").get("requests")).toBeNull();
  });
});

describe("parseNpxCommand", () => {
  test("典型 npx -y pkg@version --flag", () => {
    expect(parseNpxCommand("npx -y mcp-financex@1.0.11")).toEqual({
      pkg: "mcp-financex",
      version: "1.0.11",
      rawArgs: [],
    });
    expect(parseNpxCommand("npx -y @houtini/fmp-mcp@1.1.3")).toEqual({
      pkg: "@houtini/fmp-mcp",
      version: "1.1.3",
      rawArgs: [],
    });
  });

  test("无 @version 也合法", () => {
    expect(parseNpxCommand("npx -y mcp-foo")).toEqual({
      pkg: "mcp-foo",
      version: null,
      rawArgs: [],
    });
  });

  test("非 npx 命令返回 null", () => {
    expect(parseNpxCommand("python script.py")).toBeNull();
    expect(parseNpxCommand(undefined)).toBeNull();
  });

  test("尾部 args 透传", () => {
    expect(parseNpxCommand("npx -y mcp-foo@1 --port 8080")).toEqual({
      pkg: "mcp-foo",
      version: "1",
      rawArgs: ["--port", "8080"],
    });
  });
});

describe("seedEnvRegistry — upsert 幂等 + 用户编辑保留", () => {
  test("第一次跑：插入 BUILTIN_PYTHON_META + stdio MCP", async () => {
    const r = await seedEnvRegistry([
      {
        name: "mcp-financex",
        transport: "stdio",
        command: "npx -y mcp-financex@1.0.11",
        description: "test stub",
      },
    ]);
    expect(r.inserted + r.updated).toBe(r.total);
    const all = await envRegistryService.list();
    expect(all.some((p) => p.kind === "python" && p.name === "yfinance")).toBe(true);
    expect(all.some((p) => p.kind === "npm" && p.name === "mcp-financex")).toBe(true);

    // is_builtin / source 应被正确标
    const yfin = all.find((p) => p.name === "yfinance")!;
    expect(yfin.isBuiltin).toBe(true);
    expect(yfin.source).toBe("requirements");
    expect(yfin.versionSpec).toBe(">=0.2.40");

    const fx = all.find((p) => p.name === "mcp-financex")!;
    expect(fx.isBuiltin).toBe(true);
    expect(fx.source).toBe("seed-mcp");
    expect(fx.versionSpec).toBe("==1.0.11");
    expect(fx.extra.mcpServerName).toBe("mcp-financex");
  });

  test("第二次跑：用户改过的 status / userVersionSpec 不被覆盖", async () => {
    const before = await envRegistryService.list({ kind: "python" });
    const yfin = before.find((p) => p.name === "yfinance")!;

    await envRegistryService.update(yfin.id, {
      status: "disabled",
      userVersionSpec: "==0.2.40",
    });

    // 再 seed
    await seedEnvRegistry([]);

    const after = await envRegistryService.list({ kind: "python" });
    const yfin2 = after.find((p) => p.name === "yfinance")!;
    expect(yfin2.status).toBe("disabled");
    expect(yfin2.userVersionSpec).toBe("==0.2.40");
    expect(yfin2.versionSpec).toBe(">=0.2.40"); // system 字段照常被刷新
    expect(yfin2.effectiveVersionSpec).toBe("==0.2.40");
  });
});

describe("envRegistryService — CRUD 业务规则", () => {
  test("createUserItem + delete: 用户自建项可 CRUD", async () => {
    const created = await envRegistryService.createUserItem({
      kind: "python",
      packageName: "scipy",
      displayName: "SciPy",
      description: "可选科学计算",
      versionSpec: ">=1.13",
      capability: "user/scientific",
    });
    expect(created.isBuiltin).toBe(false);
    expect(created.source).toBe("user");
    expect(created.userVersionSpec).toBe(">=1.13");

    await envRegistryService.remove(created.id);
    const got = await envRegistryService.getById(created.id);
    expect(got).toBeNull();
  });

  test("createUserItem 同 (kind, name) 重复 → duplicate", async () => {
    await expect(
      envRegistryService.createUserItem({
        kind: "python",
        packageName: "yfinance", // seed 已建过
        displayName: "yfinance dup",
      })
    ).rejects.toMatchObject({ code: "duplicate" } as EnvRegistryError);
  });

  test("system 项删除 → builtin_protected", async () => {
    const list = await envRegistryService.list({ kind: "python" });
    const yfin = list.find((p) => p.name === "yfinance")!;
    await expect(envRegistryService.remove(yfin.id)).rejects.toMatchObject({
      code: "builtin_protected",
    } as EnvRegistryError);
  });

  test("system 项 update：仅 status / userVersionSpec 生效，displayName 等被忽略", async () => {
    const list = await envRegistryService.list({ kind: "python" });
    const yfin = list.find((p) => p.name === "yfinance")!;
    const originalDisplay = yfin.displayName;

    const updated = await envRegistryService.update(yfin.id, {
      displayName: "HACKED",
      description: "HACKED",
      capability: "HACKED",
      userVersionSpec: "==0.2.50",
      status: "enabled",
    });

    expect(updated.displayName).toBe(originalDisplay);
    expect(updated.userVersionSpec).toBe("==0.2.50");
    expect(updated.status).toBe("enabled");
  });

  test("invalid_kind 输入被拒", async () => {
    await expect(
      envRegistryService.createUserItem({
        // @ts-expect-error 故意传非法 kind
        kind: "go",
        packageName: "foo",
        displayName: "foo",
      })
    ).rejects.toMatchObject({ code: "invalid_kind" });
  });
});
