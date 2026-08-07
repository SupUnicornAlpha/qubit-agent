/**
 * Rust Core 路径的回合入口闸门（已弃用）。
 *
 * HITL=每次 / 高危工具改由 Core `hitl_policy` 在 **工具 invoke 前** 升起，
 * 再经 `projectCoreAwaitingHitl` 投影到 Bun `workflow_hitl_request`。
 * 此函数保留为 false，避免与 Core 工具闸门双卡。
 */
export function shouldPauseCoreTurnForChatHitl(_input: {
  loopOptions: LoopOptionsJson;
  params: Record<string, unknown>;
}): boolean {
  return false;
}

/** Team 面板写 `hitlMode`，对话闸门写 `hitlChatMode`；桥接两者。 */
export function resolveCoreBridgeChatHitlMode(
  loopOptions: LoopOptionsJson
): "off" | "ai" | "always" {
  if (
    loopOptions.hitlChatMode === "off" ||
    loopOptions.hitlChatMode === "ai" ||
    loopOptions.hitlChatMode === "always"
  ) {
    return loopOptions.hitlChatMode;
  }
  if (
    loopOptions.hitlMode === "off" ||
    loopOptions.hitlMode === "ai" ||
    loopOptions.hitlMode === "always"
  ) {
    return loopOptions.hitlMode;
  }
  return "ai";
}

/** `UserInput.client_meta.hitl` — Core `HitlPolicy::from_client_meta` 对端。 */
export function buildCoreHitlClientMeta(input: {
  loopOptions: LoopOptionsJson;
  /** 用户刚批准后续跑：放过 always 模式下的第一批工具 */
  skipToolGateOnce?: boolean;
}): { hitl: { mode: "off" | "ai" | "always"; skip_tool_gate_once?: boolean } } {
  const mode = resolveCoreBridgeChatHitlMode(input.loopOptions);
  return {
    hitl: {
      mode,
      ...(input.skipToolGateOnce ? { skip_tool_gate_once: true } : {}),
    },
  };
}
