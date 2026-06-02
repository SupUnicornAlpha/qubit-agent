/**
 * Legacy sunset feature flag 单测 — Memory V2 P2
 *
 * 覆盖：
 *   - 缺省（无 env） → false（仍走旧路径）
 *   - "1" / "true" / "yes" → true
 *   - "0" / "false" / "" / 其他 → false
 *   - 大小写不敏感
 *
 * 注：onWorkflowTerminal 的端到端测试在 observability-hook 集成测试覆盖；
 *     本文件只测纯 helper。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isLegacyConsolidateDisabled } from "../observability-hook";

const ENV_KEY = "MEMORY_V2_DISABLE_LEGACY_CONSOLIDATE";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("isLegacyConsolidateDisabled — env 解析", () => {
  test("缺省（无 env） → false（向后兼容）", () => {
    expect(isLegacyConsolidateDisabled()).toBe(false);
  });

  test('"1" → true', () => {
    process.env[ENV_KEY] = "1";
    expect(isLegacyConsolidateDisabled()).toBe(true);
  });

  test('"true" → true', () => {
    process.env[ENV_KEY] = "true";
    expect(isLegacyConsolidateDisabled()).toBe(true);
  });

  test('"yes" → true', () => {
    process.env[ENV_KEY] = "yes";
    expect(isLegacyConsolidateDisabled()).toBe(true);
  });

  test('"TRUE" 大写也认 → true', () => {
    process.env[ENV_KEY] = "TRUE";
    expect(isLegacyConsolidateDisabled()).toBe(true);
  });

  test('"0" → false', () => {
    process.env[ENV_KEY] = "0";
    expect(isLegacyConsolidateDisabled()).toBe(false);
  });

  test('"false" → false', () => {
    process.env[ENV_KEY] = "false";
    expect(isLegacyConsolidateDisabled()).toBe(false);
  });

  test('"" → false', () => {
    process.env[ENV_KEY] = "";
    expect(isLegacyConsolidateDisabled()).toBe(false);
  });

  test("意外值（'maybe'）→ false（默认安全）", () => {
    process.env[ENV_KEY] = "maybe";
    expect(isLegacyConsolidateDisabled()).toBe(false);
  });
});
