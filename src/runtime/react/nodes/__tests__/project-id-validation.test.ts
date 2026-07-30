/**
 * project-id-validation.test.ts
 *
 * 测试 `isLikelyProjectIdFormat`：判定一个字符串是否"看起来像合法 projectId"。
 *
 * 背景：原 `looksLikePlaceholderProjectId` 是反向黑名单，LLM 创造的新占位符
 * （如 `ai_semiconductor_technical`, `googl_research_proj`, `nvda_v1`）逃过拦截，
 * 在 builtin-tools.ts factor.autoEvaluate 内部 register 时触发 FK constraint failed。
 *
 * 改为正向白名单：仅接受 UUID 形态 / `proj-xxx` 老格式；其它一律视为不合法 → fallback。
 */
import { describe, expect, test } from "bun:test";
import { isLikelyProjectIdFormat } from "../project-id";

describe("isLikelyProjectIdFormat", () => {
  test("v4 UUID 合法", () => {
    expect(isLikelyProjectIdFormat("4614e8b1-e5d6-4a7b-af50-a9fb33f95dae")).toBe(true);
    expect(isLikelyProjectIdFormat("00000000-0000-4000-8000-a2a000000002")).toBe(true);
  });

  test("`proj-xxx` 老 seed 格式合法", () => {
    expect(isLikelyProjectIdFormat("proj-test")).toBe(true);
    expect(isLikelyProjectIdFormat("proj-hitl-p03")).toBe(true);
    expect(isLikelyProjectIdFormat("proj-default")).toBe(true);
  });

  test("LLM 常见占位（已知）→ 非法", () => {
    expect(isLikelyProjectIdFormat("default")).toBe(false);
    expect(isLikelyProjectIdFormat("project_id")).toBe(false);
    expect(isLikelyProjectIdFormat("projectId")).toBe(false);
    expect(isLikelyProjectIdFormat("todo")).toBe(false);
    expect(isLikelyProjectIdFormat("TODO")).toBe(false);
    expect(isLikelyProjectIdFormat("fixme")).toBe(false);
    expect(isLikelyProjectIdFormat("tbd")).toBe(false);
    expect(isLikelyProjectIdFormat("?")).toBe(false);
    expect(isLikelyProjectIdFormat("")).toBe(false);
    expect(isLikelyProjectIdFormat("   ")).toBe(false);
  });

  test("LLM 创造的业务化占位（关键回归用例）→ 非法", () => {
    /** 这两个就是 wf 4614e8b1 / 35d357c8 实测产生的字符串 */
    expect(isLikelyProjectIdFormat("ai_semiconductor_technical")).toBe(false);
    expect(isLikelyProjectIdFormat("aapl_trend_v1")).toBe(false);
    expect(isLikelyProjectIdFormat("nvda_research")).toBe(false);
    expect(isLikelyProjectIdFormat("googl_factor_proj")).toBe(false);
    expect(isLikelyProjectIdFormat("my_project")).toBe(false);
  });

  test("尖括号占位 → 非法", () => {
    expect(isLikelyProjectIdFormat("<project_id>")).toBe(false);
    expect(isLikelyProjectIdFormat("<your-project-id>")).toBe(false);
  });

  test("非 string → 非法", () => {
    expect(isLikelyProjectIdFormat(null)).toBe(false);
    expect(isLikelyProjectIdFormat(undefined)).toBe(false);
    expect(isLikelyProjectIdFormat(42)).toBe(false);
    expect(isLikelyProjectIdFormat({})).toBe(false);
  });

  test("大小写不敏感的 UUID（大写）→ 合法", () => {
    expect(isLikelyProjectIdFormat("4614E8B1-E5D6-4A7B-AF50-A9FB33F95DAE")).toBe(true);
  });

  test("非 v4 UUID（v1）→ 合法（保守，避免误伤历史数据）", () => {
    expect(isLikelyProjectIdFormat("550e8400-e29b-11d4-a716-446655440000")).toBe(true);
  });

  test("含前后空白的 UUID → 合法（trim 后判定）", () => {
    expect(isLikelyProjectIdFormat("  4614e8b1-e5d6-4a7b-af50-a9fb33f95dae  ")).toBe(true);
  });
});
