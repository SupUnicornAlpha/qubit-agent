/** Global gate for live broker dispatch (default off). */
export function isLiveTradingEnabled(): boolean {
  const v = process.env["QUBIT_LIVE_TRADING_ENABLED"] ?? "false";
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}
