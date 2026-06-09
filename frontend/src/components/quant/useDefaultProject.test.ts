/**
 * Unit tests — pickPreferredProject。
 *
 * 修复点（2026-06-09）：
 *   旧版 `projects[0]?.id` 永远拿最老的（seed fixture），不是 Agent / 评测
 *   实际使用的 `QUBIT Default Project`，导致 ComposerTab 看不到 Agent 产物。
 */

import { describe, expect, test } from "bun:test";
import { pickPreferredProject } from "./useDefaultProject";

describe("pickPreferredProject", () => {
  test("空 list 返回 null", () => {
    expect(pickPreferredProject([])).toBeNull();
  });

  test("命中 QUBIT Default Project 即使不是第 0 个也优先返回", () => {
    const ps = [
      { id: "old1", name: "test_proj" },
      { id: "old2", name: "skill_proj" },
      { id: "default", name: "QUBIT Default Project" },
      { id: "old3", name: "disc-proj" },
    ];
    expect(pickPreferredProject(ps)).toBe("default");
  });

  test("没有 QUBIT Default 时回退到 name='default'", () => {
    const ps = [
      { id: "a", name: "test_proj" },
      { id: "b", name: "default" },
    ];
    expect(pickPreferredProject(ps)).toBe("b");
  });

  test("两个都没有时回退 projects[0]", () => {
    const ps = [
      { id: "a", name: "test_proj" },
      { id: "b", name: "skill_proj" },
    ];
    expect(pickPreferredProject(ps)).toBe("a");
  });

  test("QUBIT Default Project 优先级高于 default", () => {
    const ps = [
      { id: "a", name: "default" },
      { id: "b", name: "QUBIT Default Project" },
    ];
    expect(pickPreferredProject(ps)).toBe("b");
  });
});
