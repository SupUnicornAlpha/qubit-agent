/**
 * SelfEvolveConfig 单测：env 解析 + 默认值 + monkey-patch + gate。
 *
 * 这是 P9 的"开关层"，4 个 worker / reason 注入都要 gate 它，必须先把语义钉死。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getSelfEvolveConfig,
  selfEvolveDisabledReason,
  setSelfEvolveConfigForTest,
} from "../self-evolve-config";

const ENV_KEYS = [
  "SELF_EVOLVE_ENABLED",
  "AUTO_INSTALL_MODE",
  "PNL_AWARE_REASON_ENABLED",
  "AUTO_INSTALL_MIN_SCORE",
  "REASON_PNL_TOP_N",
  "REASON_PNL_WINDOW_DAYS",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const o: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) o[k] = process.env[k];
  return o;
}

function restoreEnv(s: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k]!;
  }
}

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = snapshotEnv();
  for (const k of ENV_KEYS) delete process.env[k];
  setSelfEvolveConfigForTest(null);
});

afterEach(() => {
  restoreEnv(saved);
  setSelfEvolveConfigForTest(null);
});

describe("默认值", () => {
  test("env 全空 → 默认 disabled / propose / pnl off", () => {
    const c = getSelfEvolveConfig();
    expect(c.enabled).toBe(false);
    expect(c.autoInstallMode).toBe("propose");
    expect(c.pnlAwareReasonEnabled).toBe(false);
    expect(c.minScoreForAuto).toBe(0.85);
    expect(c.reasonPnlTopN).toBe(3);
    expect(c.reasonPnlWindowDays).toBe(7);
  });

  test("SELF_EVOLVE_ENABLED=true → pnl-aware 默认随总闸开", () => {
    process.env["SELF_EVOLVE_ENABLED"] = "true";
    const c = getSelfEvolveConfig();
    expect(c.enabled).toBe(true);
    expect(c.pnlAwareReasonEnabled).toBe(true);
  });

  test("SELF_EVOLVE_ENABLED=true + PNL_AWARE_REASON_ENABLED=false → 可独立关掉", () => {
    process.env["SELF_EVOLVE_ENABLED"] = "true";
    process.env["PNL_AWARE_REASON_ENABLED"] = "false";
    const c = getSelfEvolveConfig();
    expect(c.enabled).toBe(true);
    expect(c.pnlAwareReasonEnabled).toBe(false);
  });
});

describe("env 解析容错", () => {
  test("布尔接受多种格式：1 / on / yes", () => {
    process.env["SELF_EVOLVE_ENABLED"] = "1";
    expect(getSelfEvolveConfig().enabled).toBe(true);
    setSelfEvolveConfigForTest(null);
    process.env["SELF_EVOLVE_ENABLED"] = "on";
    expect(getSelfEvolveConfig().enabled).toBe(true);
    setSelfEvolveConfigForTest(null);
    process.env["SELF_EVOLVE_ENABLED"] = "yes";
    expect(getSelfEvolveConfig().enabled).toBe(true);
  });

  test("AUTO_INSTALL_MODE 非法值 → 回 propose 默认", () => {
    process.env["AUTO_INSTALL_MODE"] = "garbage";
    expect(getSelfEvolveConfig().autoInstallMode).toBe("propose");
  });

  test("AUTO_INSTALL_MIN_SCORE 越界裁切到 [0,1]", () => {
    process.env["AUTO_INSTALL_MIN_SCORE"] = "1.5";
    expect(getSelfEvolveConfig().minScoreForAuto).toBe(1);
    setSelfEvolveConfigForTest(null);
    process.env["AUTO_INSTALL_MIN_SCORE"] = "-0.3";
    expect(getSelfEvolveConfig().minScoreForAuto).toBe(0);
  });

  test("REASON_PNL_TOP_N 非数字回默认", () => {
    process.env["REASON_PNL_TOP_N"] = "abc";
    expect(getSelfEvolveConfig().reasonPnlTopN).toBe(3);
  });
});

describe("setSelfEvolveConfigForTest", () => {
  test("monkey-patch 单字段", () => {
    setSelfEvolveConfigForTest({ enabled: true, autoInstallMode: "auto" });
    const c = getSelfEvolveConfig();
    expect(c.enabled).toBe(true);
    expect(c.autoInstallMode).toBe("auto");
    expect(c.minScoreForAuto).toBe(0.85); // 其它字段保留默认
  });

  test("传 null 回到 env 加载", () => {
    setSelfEvolveConfigForTest({ enabled: true });
    expect(getSelfEvolveConfig().enabled).toBe(true);
    setSelfEvolveConfigForTest(null);
    expect(getSelfEvolveConfig().enabled).toBe(false);
  });
});

describe("selfEvolveDisabledReason", () => {
  test("默认关 → 返回原因字符串", () => {
    expect(selfEvolveDisabledReason()).toBe("SELF_EVOLVE_ENABLED=false");
  });

  test("总闸开 → 返回 null（可跑）", () => {
    setSelfEvolveConfigForTest({ enabled: true });
    expect(selfEvolveDisabledReason()).toBeNull();
  });
});
