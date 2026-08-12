import { describe, expect, test } from "bun:test";
import {
  buildCoreHitlClientMeta,
  resolveCoreBridgeChatHitlMode,
  shouldPauseCoreTurnForChatHitl,
} from "../core-hitl-bridge";

describe("core-hitl-bridge", () => {
  test("turn-entry pause is disabled (Core owns tool-gate)", () => {
    expect(
      shouldPauseCoreTurnForChatHitl({
        loopOptions: { hitlChatMode: "always" },
        params: { goal: "分析兆易创新" },
      })
    ).toBe(false);
  });

  test("resolve prefers hitlChatMode over hitlMode", () => {
    expect(resolveCoreBridgeChatHitlMode({ hitlChatMode: "off", hitlMode: "always" })).toBe("off");
    expect(resolveCoreBridgeChatHitlMode({ hitlMode: "always" })).toBe("always");
    expect(resolveCoreBridgeChatHitlMode({})).toBe("ai");
  });

  test("buildCoreHitlClientMeta maps mode + skip_once", () => {
    expect(buildCoreHitlClientMeta({ loopOptions: { hitlMode: "always" } })).toEqual({
      hitl: { mode: "always" },
    });
    expect(
      buildCoreHitlClientMeta({
        loopOptions: { hitlChatMode: "ai" },
        skipToolGateOnce: true,
      })
    ).toEqual({
      hitl: { mode: "ai", skip_tool_gate_once: true },
    });
  });
});
