/**
 * v2 HITL：Orchestrator LLM 输出 brief + hitlHint JSON 的解析容错。
 * 参考 docs/HITL_REDESIGN.md §5。
 */
import { describe, expect, test } from "bun:test";
import { parsePlanWithHitlHint } from "../analyst-team-pipeline";

describe("parsePlanWithHitlHint", () => {
  test("正常路径：brief + hitlHint JSON", () => {
    const raw = `## 开篇\n常规多头分析。

## analyst_fundamental
看财务。

---HITL_HINT_JSON---
{"needed": false, "reason": "常规多头任务", "inputKind": "approve_only"}`;
    const r = parsePlanWithHitlHint(raw);
    expect(r.brief).toContain("## analyst_fundamental");
    expect(r.brief).not.toContain("HITL_HINT_JSON");
    expect(r.hitlHint?.needed).toBe(false);
    expect(r.hitlHint?.reason).toBe("常规多头任务");
    expect(r.hitlHint?.inputKind).toBe("approve_only");
  });

  test("needed=true + single_choice + options 透传", () => {
    const raw = `# brief\n...\n---HITL_HINT_JSON---\n{"needed":true,"reason":"两条路径都可行","inputKind":"single_choice","options":[{"label":"动量优先","value":"momentum"},{"label":"基本面优先","value":"fundamental","description":"看 PE/PB"}]}`;
    const r = parsePlanWithHitlHint(raw);
    expect(r.hitlHint?.needed).toBe(true);
    expect(r.hitlHint?.inputKind).toBe("single_choice");
    expect(r.hitlHint?.options).toHaveLength(2);
    expect(r.hitlHint?.options?.[1]?.description).toBe("看 PE/PB");
  });

  test("缺少分隔符 → hitlHint=null，brief 保留全文", () => {
    const raw = `## 开篇\n常规多头。\n\n## analyst_fundamental\n看财报。`;
    const r = parsePlanWithHitlHint(raw);
    expect(r.brief).toBe(raw);
    expect(r.hitlHint).toBeNull();
  });

  test("有分隔符但 JSON 无效 → hitlHint=null，brief 仍正常", () => {
    const raw = `# brief\n...\n---HITL_HINT_JSON---\n这不是 JSON`;
    const r = parsePlanWithHitlHint(raw);
    expect(r.brief).toContain("# brief");
    expect(r.hitlHint).toBeNull();
  });

  test("inputKind 非法值 → undefined（不污染）", () => {
    const raw = `# brief\n---HITL_HINT_JSON---\n{"needed":true,"inputKind":"random_kind"}`;
    const r = parsePlanWithHitlHint(raw);
    expect(r.hitlHint?.needed).toBe(true);
    expect(r.hitlHint?.inputKind).toBeUndefined();
  });

  test("options 元素缺 value → 整段 options 丢弃", () => {
    const raw = `# brief\n---HITL_HINT_JSON---\n{"needed":true,"inputKind":"single_choice","options":[{"label":"only label"}]}`;
    const r = parsePlanWithHitlHint(raw);
    expect(r.hitlHint?.options).toBeUndefined();
  });

  test("空字符串 → 哨兵 brief，hitlHint=null", () => {
    const r = parsePlanWithHitlHint("");
    expect(r.brief).toBe("（无编排简报）");
    expect(r.hitlHint).toBeNull();
  });

  test("reason 长度被截断到 200 字符", () => {
    const longReason = "x".repeat(500);
    const raw = `# b\n---HITL_HINT_JSON---\n{"needed":true,"reason":"${longReason}"}`;
    const r = parsePlanWithHitlHint(raw);
    expect(r.hitlHint?.reason?.length).toBe(200);
  });
});
