import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  parseVersionSpec,
  satisfies,
} from "../version-spec";

describe("compareVersions", () => {
  test("基本数字比较", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  test("位数不同时短的视为后补 0", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  test("prerelease 标签按 numeric 前缀截断（宽松）", () => {
    expect(compareVersions("1.2.3rc1", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3.dev1", "1.2.3")).toBe(0);
  });
});

describe("parseVersionSpec / satisfies", () => {
  test(">=0.2.40 接受 0.2.40 / 0.2.41 / 1.0", () => {
    expect(satisfies("0.2.40", ">=0.2.40")).toBe(true);
    expect(satisfies("0.2.41", ">=0.2.40")).toBe(true);
    expect(satisfies("1.0.0", ">=0.2.40")).toBe(true);
    expect(satisfies("0.2.39", ">=0.2.40")).toBe(false);
  });

  test("==1.0.11 仅接受精确匹配", () => {
    expect(satisfies("1.0.11", "==1.0.11")).toBe(true);
    expect(satisfies("1.0.12", "==1.0.11")).toBe(false);
  });

  test("conjunction 组合 >=0.2,<1", () => {
    expect(satisfies("0.5", ">=0.2,<1")).toBe(true);
    expect(satisfies("1.0", ">=0.2,<1")).toBe(false);
    expect(satisfies("0.1", ">=0.2,<1")).toBe(false);
  });

  test("~=0.2.4 → >=0.2.4,<0.3", () => {
    const c = parseVersionSpec("~=0.2.4");
    expect(c[0].op).toBe("~=");
    expect(c[0].tildeUpper).toBe("0.3");
    expect(satisfies("0.2.4", "~=0.2.4")).toBe(true);
    expect(satisfies("0.2.99", "~=0.2.4")).toBe(true);
    expect(satisfies("0.3.0", "~=0.2.4")).toBe(false);
    expect(satisfies("0.2.3", "~=0.2.4")).toBe(false);
  });

  test("空 / null spec 永远 true（无约束）", () => {
    expect(satisfies("0.0.1", null)).toBe(true);
    expect(satisfies("0.0.1", "")).toBe(true);
    expect(satisfies("0.0.1", undefined)).toBe(true);
  });

  test("无效 spec → false（保守）", () => {
    expect(satisfies("1.0", "garbage spec")).toBe(false);
  });

  test("!=1.0 拒绝精确版", () => {
    expect(satisfies("1.0", "!=1.0")).toBe(false);
    expect(satisfies("1.0.1", "!=1.0")).toBe(true);
  });
});
