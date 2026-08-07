/**
 * Monitor / Prime Core placeholder thoughts must not appear as chat bubbles.
 */
export function isUiHiddenAgentThought(
  thought: string | null | undefined,
  actionJson?: unknown
): boolean {
  const text = String(thought ?? "").trim();
  if (!text) return true;
  if (/^Prime Core (reasoning|acting)/i.test(text)) return true;
  if (text === "Reasoning with LLM provider") return true;
  if (
    actionJson &&
    typeof actionJson === "object" &&
    (actionJson as Record<string, unknown>).uiHiddenThought === true
  ) {
    return true;
  }
  const phase =
    actionJson && typeof actionJson === "object"
      ? String((actionJson as Record<string, unknown>).phase ?? "")
      : "";
  if (phase === "prime_core_reason" || phase === "prime_core_act") return true;
  return false;
}
