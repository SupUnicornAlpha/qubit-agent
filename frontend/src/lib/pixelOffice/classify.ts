import type { AnalystTeamGraphToolCall } from "../../api/types";
import type { CatAction } from "./types";

export function isToolSuccess(status: string): boolean {
  return status === "success" || status === "ok";
}

/** 从 toolName / toolKind 推断办公室动作 */
export function classifyToolAction(tc: AnalystTeamGraphToolCall): CatAction {
  const kind = (tc.toolKind ?? "").toLowerCase();
  const name = (tc.toolName ?? "").toLowerCase();

  if (kind === "mcp") return "mcp";
  if (kind === "skill" || name.startsWith("skill.")) return "skill";

  if (
    /sandbox|shell|terminal|run_terminal|execute|bash|cmd|subprocess|pty/.test(name) ||
    kind === "acp_connector"
  ) {
    return "sandbox";
  }

  if (kind === "builtin") return "builtin";
  return "tool";
}

export function classifyInteractionKind(kind: string): CatAction | "chat" | null {
  const k = kind.toLowerCase();
  if (k === "llm_message") return "chat";
  if (k === "signal_submit") return "signal";
  if (k === "tool_call") return "tool";
  return null;
}
