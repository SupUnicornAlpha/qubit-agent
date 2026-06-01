/**
 * python-deps 单测：normalize / diff / 安全校验。
 *
 * 不跑真实 pip：那需要联网拉包，不适合 CI。install/uninstall 的端到端
 * 行为通过 routes 集成测 + 手动 smoke 验证（DESIGN §8.2 P1-6）。
 */
import { describe, expect, test } from "bun:test";
import {
  diffPackages,
  installPython,
  normalizePackageName,
  PythonDepsError,
  uninstallPython,
} from "../python-deps";
import type { ExpectedPackage, InstalledPackage } from "../types";

function exp(
  name: string,
  spec: string | null,
  status: "enabled" | "disabled" = "enabled"
): ExpectedPackage {
  return {
    id: `exp-${name}`,
    kind: "python",
    name,
    displayName: name,
    description: "",
    versionSpec: spec,
    userVersionSpec: null,
    effectiveVersionSpec: spec,
    optional: false,
    capability: "core",
    source: "requirements",
    status,
    isBuiltin: true,
    extra: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function inst(name: string, version: string): InstalledPackage {
  return { name, version };
}

describe("normalizePackageName (PEP 503)", () => {
  test("lowercase + dot/_ → -", () => {
    expect(normalizePackageName("Pandas")).toBe("pandas");
    expect(normalizePackageName("Foo_Bar.Baz")).toBe("foo-bar-baz");
    expect(normalizePackageName("yfinance")).toBe("yfinance");
  });
});

describe("diffPackages", () => {
  test("满足/缺失/版本不匹配/orphan 分桶", () => {
    const expected = [
      exp("pandas", ">=2.2.0"),
      exp("yfinance", ">=0.2.40"),
      exp("akshare", ">=1.12.0"),
      exp("pytest", null),
    ];
    const installed = [
      inst("pandas", "2.2.3"),
      inst("yfinance", "0.2.20"), // mismatch
      inst("requests", "2.31.0"), // orphan
      // akshare missing
      // pytest missing；但 spec=null 仍算 missing（未装）
    ];
    const d = diffPackages(expected, installed);
    expect(d.satisfied.map((p) => p.name)).toEqual(["pandas"]);
    expect(d.missing.map((p) => p.name).sort()).toEqual(["akshare", "pytest"]);
    expect(d.versionMismatch).toHaveLength(1);
    expect(d.versionMismatch[0].expected.name).toBe("yfinance");
    expect(d.versionMismatch[0].installed.version).toBe("0.2.20");
    expect(d.orphan.map((p) => p.name)).toEqual(["requests"]);
  });

  test("disabled 项被 diff 跳过，不计 missing 也不影响 orphan", () => {
    const expected = [exp("pandas", ">=2.2.0", "disabled")];
    const installed: InstalledPackage[] = [];
    const d = diffPackages(expected, installed);
    expect(d.missing).toHaveLength(0);
  });

  test("大小写 / 下划线归一化匹配", () => {
    const expected = [exp("Foo_Bar", ">=1.0")];
    const installed = [inst("foo-bar", "1.2.0")];
    const d = diffPackages(expected, installed);
    expect(d.satisfied).toHaveLength(1);
    expect(d.missing).toHaveLength(0);
  });
});

describe("install/uninstall 安全校验（不真实跑 pip）", () => {
  test("非法包名拒绝（防 shell 注入）", async () => {
    await expect(
      installPython({ packageName: "pandas; rm -rf /" })
    ).rejects.toMatchObject({ code: "invalid_package_name" } as PythonDepsError);

    await expect(
      installPython({ packageName: "../etc/passwd" })
    ).rejects.toMatchObject({ code: "invalid_package_name" });
  });

  test("非法 spec 拒绝", async () => {
    await expect(
      installPython({ packageName: "pandas", versionSpec: ">=1.0; cat /etc/passwd" })
    ).rejects.toMatchObject({ code: "invalid_version_spec" });

    await expect(
      installPython({
        packageName: "pandas",
        versionSpec: "@git+https://github.com/example/pandas",
      })
    ).rejects.toMatchObject({ code: "invalid_version_spec" });
  });

  test("uninstall 也走包名校验", async () => {
    await expect(
      uninstallPython({ packageName: "pkg`whoami`" })
    ).rejects.toMatchObject({ code: "invalid_package_name" });
  });
});
