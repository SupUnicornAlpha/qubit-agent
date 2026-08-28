import { describe, expect, test } from "bun:test";
import {
  dedupeById,
  quantLineageFilterActive,
  quantListProjectFilter,
} from "./quantListScope";

describe("quantListProjectFilter", () => {
  test("null scope 不传 projectId", () => {
    expect(quantListProjectFilter(null)).toEqual({});
  });

  test("指定 scope 带上 projectId", () => {
    expect(quantListProjectFilter("p1")).toEqual({ projectId: "p1" });
  });
});

describe("quantLineageFilterActive", () => {
  test("none 模式不激活", () => {
    expect(quantLineageFilterActive({ mode: "none", id: "" })).toBe(false);
    expect(quantLineageFilterActive({ mode: "none", id: "x" })).toBe(false);
  });

  test("workflow/session 需非空 id", () => {
    expect(quantLineageFilterActive({ mode: "workflow", id: "" })).toBe(false);
    expect(quantLineageFilterActive({ mode: "workflow", id: "wf-1" })).toBe(true);
    expect(quantLineageFilterActive({ mode: "session", id: "sess-1" })).toBe(true);
  });
});

describe("dedupeById", () => {
  test("按 id 去重保留首次", () => {
    expect(
      dedupeById([
        { id: "a", v: 1 },
        { id: "b", v: 2 },
        { id: "a", v: 3 },
      ])
    ).toEqual([
      { id: "a", v: 1 },
      { id: "b", v: 2 },
    ]);
  });
});
