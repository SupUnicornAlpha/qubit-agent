import { describe, expect, test } from "bun:test";
import { pickRoleReasonerKind } from "../role-reasoner";

describe("pickRoleReasonerKind", () => {
  test("默认 loop_kind=native → native", () => {
    expect(pickRoleReasonerKind({ loopKind: "native" })).toBe("native");
  });

  test("loop_kind=claude_cli → claude_cli（同名映射）", () => {
    expect(pickRoleReasonerKind({ loopKind: "claude_cli" })).toBe("claude_cli");
  });

  test("loop_kind=codex_cli → codex_cli", () => {
    expect(pickRoleReasonerKind({ loopKind: "codex_cli" })).toBe("codex_cli");
  });

  test("非法 loop_kind 归一化为 native", () => {
    expect(pickRoleReasonerKind({ loopKind: "garbage" })).toBe("native");
    expect(pickRoleReasonerKind({ loopKind: undefined })).toBe("native");
  });

  test("显式 roleReasoner 覆盖 loop_kind", () => {
    expect(pickRoleReasonerKind({ loopKind: "native", roleReasonerOption: "claude_cli" })).toBe(
      "claude_cli"
    );
    expect(pickRoleReasonerKind({ loopKind: "claude_cli", roleReasonerOption: "native" })).toBe(
      "native"
    );
  });

  test("roleReasoner 非法值被忽略，回退 loop_kind 推导", () => {
    expect(
      pickRoleReasonerKind({
        loopKind: "codex_cli",
        roleReasonerOption: "nope" as never,
      })
    ).toBe("codex_cli");
  });
});
