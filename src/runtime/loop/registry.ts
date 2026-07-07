import type { AgentLoopKind } from "../../types/loop";
import { a2aLoopDriver } from "../a2a/a2a-loop-driver";
import { ClaudeCliLoopDriver, CodexCliLoopDriver } from "./cli-loop-driver";
import type { LoopDriver } from "./loop-driver";

const claude = new ClaudeCliLoopDriver();
const codex = new CodexCliLoopDriver();

export function getLoopDriver(kind: AgentLoopKind): LoopDriver {
  switch (kind) {
    case "claude_cli":
      return claude;
    case "codex_cli":
      return codex;
    default:
      // native / 未知 kind 均走 A2A（GraphRunner 已删除）
      return a2aLoopDriver;
  }
}
