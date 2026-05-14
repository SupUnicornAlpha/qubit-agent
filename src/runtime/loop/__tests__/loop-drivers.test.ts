import { describe, expect, it } from "bun:test";
import { normalizeLoopKind } from "../../../types/loop";
import { parseCliLoopLine } from "../loop-protocol";
import { nativeLoopDriver } from "../native-loop-driver";
import { getLoopDriver } from "../registry";

describe("getLoopDriver", () => {
  it("returns native driver", () => {
    expect(getLoopDriver("native")).toBe(nativeLoopDriver);
  });
  it("returns Claude CLI driver", () => {
    expect(getLoopDriver("claude_cli")).toBe(getLoopDriver("claude_cli"));
  });
  it("returns Codex CLI driver", () => {
    expect(getLoopDriver("codex_cli")).toBe(getLoopDriver("codex_cli"));
  });
});

describe("normalizeLoopKind", () => {
  it("defaults invalid to native", () => {
    expect(normalizeLoopKind(undefined)).toBe("native");
    expect(normalizeLoopKind("")).toBe("native");
    expect(normalizeLoopKind("cursor")).toBe("native");
  });
});

describe("parseCliLoopLine", () => {
  it("parses valid NDJSON", () => {
    const line = JSON.stringify({
      v: "qubit.loop.v1",
      type: "log",
      message: "hello",
    });
    const p = parseCliLoopLine(line);
    expect(p?.type).toBe("log");
    expect(p?.message).toBe("hello");
  });
  it("returns null for invalid", () => {
    expect(parseCliLoopLine("not json")).toBeNull();
    expect(parseCliLoopLine("{}")).toBeNull();
  });
});
