/** Pick Strategy API V2 source when present among ide/signal blobs. */
export function preferStrategyApiCode(parts: {
  ideCode?: string | null;
  signalCode?: string | null;
}): string {
  const ide = parts.ideCode?.trim() ?? "";
  const signal = parts.signalCode?.trim() ?? "";
  const candidates = [ide, signal].filter(Boolean);
  const preferred = candidates.find(
    (c) =>
      c.includes("def initialize") &&
      (c.includes("handle_data") || c.includes("on_rebalance"))
  );
  if (preferred) return preferred;
  return ide || signal;
}

export function isStrategyApiV2Code(code: string): boolean {
  const c = code.trim();
  return (
    c.includes("def initialize") &&
    (c.includes("handle_data") || c.includes("on_rebalance"))
  );
}
