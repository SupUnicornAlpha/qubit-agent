import { describe, expect, it } from "bun:test";
import { normalizeLoopKind } from "../../../types/loop";
import { parseCliLoopLine, sniffNativeSessionId } from "../loop-protocol";
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
  it("parses session line with sessionId", () => {
    const line = JSON.stringify({
      v: "qubit.loop.v1",
      type: "session",
      sessionId: "sess-123",
    });
    const p = parseCliLoopLine(line);
    expect(p?.type).toBe("session");
    expect(p?.sessionId).toBe("sess-123");
  });
});

describe("sniffNativeSessionId", () => {
  it("extracts Claude-style session_id", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-abc",
    });
    expect(sniffNativeSessionId(line)).toBe("claude-sess-abc");
  });
  it("extracts Codex-style session_id", () => {
    const line = JSON.stringify({
      type: "session_configured",
      session_id: "codex-sess-xyz",
    });
    expect(sniffNativeSessionId(line)).toBe("codex-sess-xyz");
  });
  it("accepts sessionId camelCase variant", () => {
    expect(sniffNativeSessionId('{"sessionId":"a"}')).toBe("a");
  });
  it("returns null when no session_id field", () => {
    expect(sniffNativeSessionId('{"type":"log","message":"hi"}')).toBeNull();
    expect(sniffNativeSessionId("plain text")).toBeNull();
    expect(sniffNativeSessionId("{not json")).toBeNull();
  });
});
