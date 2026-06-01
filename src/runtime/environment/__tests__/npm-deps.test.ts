/**
 * npm-deps 单测：listInstalledNpm 扫盘、diffNpm 分桶、安全校验。
 *
 * 不跑真实 bun add：那需要联网拉包；端到端通过 routes 集成测验证。
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../../../config";
import {
  diffNpm,
  installNpm,
  listInstalledNpm,
  NpmDepsError,
  uninstallNpm,
} from "../npm-deps";
import type { ExpectedPackage, InstalledPackage } from "../types";

// QUBIT_DATA_DIR 由外部注入，必须是 /tmp 下临时目录（防止误写到真实数据）
const TEST_DIR = `${config.dataDir}/mcp-bin/node_modules`;

beforeAll(() => {
  expect(config.dataDir).toMatch(/^\/tmp\//);
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });

  mkdirSync(join(TEST_DIR, "mcp-financex"), { recursive: true });
  writeFileSync(
    join(TEST_DIR, "mcp-financex", "package.json"),
    JSON.stringify({ name: "mcp-financex", version: "1.0.11" })
  );

  mkdirSync(join(TEST_DIR, "@houtini", "fmp-mcp"), { recursive: true });
  writeFileSync(
    join(TEST_DIR, "@houtini", "fmp-mcp", "package.json"),
    JSON.stringify({ name: "@houtini/fmp-mcp", version: "1.1.0" })
  );

  // .bin / .cache 应被忽略
  mkdirSync(join(TEST_DIR, ".bin"), { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function exp(name: string, spec: string | null): ExpectedPackage {
  return {
    id: `exp-${name}`,
    kind: "npm",
    name,
    displayName: name,
    description: "",
    versionSpec: spec,
    userVersionSpec: null,
    effectiveVersionSpec: spec,
    optional: true,
    capability: "mcp/test",
    source: "seed-mcp",
    status: "enabled",
    isBuiltin: true,
    extra: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("listInstalledNpm 扫盘", () => {
  test("枚举一级 + scoped 包，跳过 .bin", () => {
    const all = listInstalledNpm();
    expect(all.find((p) => p.name === "mcp-financex")?.version).toBe("1.0.11");
    expect(all.find((p) => p.name === "@houtini/fmp-mcp")?.version).toBe("1.1.0");
    expect(all.some((p) => p.name === ".bin")).toBe(false);
  });
});

describe("diffNpm 分桶", () => {
  test("==1.0.11 命中已装 → satisfied；mismatch → versionMismatch；未装 → missing", () => {
    const expected = [
      exp("mcp-financex", "==1.0.11"),
      exp("@houtini/fmp-mcp", "==2.0.0"), // mismatch
      exp("mcp-foo", "==1.0.0"), // missing
    ];
    const installed: InstalledPackage[] = listInstalledNpm();
    const d = diffNpm(expected, installed);
    expect(d.satisfied.map((p) => p.name)).toEqual(["mcp-financex"]);
    expect(d.versionMismatch.map((p) => p.expected.name)).toEqual(["@houtini/fmp-mcp"]);
    expect(d.missing.map((p) => p.name)).toEqual(["mcp-foo"]);
  });

  test("disabled 项被跳过", () => {
    const expected = [{ ...exp("mcp-financex", "==1.0.11"), status: "disabled" as const }];
    const d = diffNpm(expected, listInstalledNpm());
    expect(d.missing).toHaveLength(0);
    expect(d.satisfied).toHaveLength(0);
  });
});

describe("install/uninstall 安全校验", () => {
  test("非法包名拒绝（防 shell 注入）", async () => {
    await expect(
      installNpm({ packageName: "mcp-foo; rm -rf /" })
    ).rejects.toMatchObject({ code: "invalid_package_name" } as NpmDepsError);

    await expect(
      installNpm({ packageName: "git+https://x" })
    ).rejects.toMatchObject({ code: "invalid_package_name" });
  });

  test("非法版本拒绝", async () => {
    await expect(
      installNpm({ packageName: "mcp-financex", version: "1.0.11; cat /etc/passwd" })
    ).rejects.toMatchObject({ code: "invalid_version" });
  });

  test("uninstall 也走包名校验", async () => {
    await expect(uninstallNpm({ packageName: "../bad" })).rejects.toMatchObject({
      code: "invalid_package_name",
    });
  });
});
