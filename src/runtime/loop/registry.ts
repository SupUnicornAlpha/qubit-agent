import type { AgentLoopKind } from "../../types/loop";
import { ClaudeCliLoopDriver, CodexCliLoopDriver } from "./cli-loop-driver";
import type { LoopDriver } from "./loop-driver";
import { nativeLoopDriver } from "./native-loop-driver";

const claude = new ClaudeCliLoopDriver();
const codex = new CodexCliLoopDriver();

export function getLoopDriver(kind: AgentLoopKind): LoopDriver {
  switch (kind) {
    case "claude_cli":
      return claude;
    case "codex_cli":
      return codex;
    default:
      return nativeLoopDriver;
  }
}
