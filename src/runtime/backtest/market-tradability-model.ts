export interface TradabilityBar {
  open: number;
  tradable?: boolean;
  suspended?: boolean;
  priceLimitUp?: number;
  priceLimitDown?: number;
  calendarSession?: "open" | "closed";
}

export interface TradabilityDecision {
  executable: boolean;
  reason:
    | "tradable"
    | "suspended"
    | "explicitly_untradable"
    | "calendar_closed"
    | "limit_up_buy_blocked"
    | "limit_down_sell_blocked";
}

/**
 * Directional open-auction tradability check. It deliberately does not infer price limits
 * from a prior close: the limit regime must be supplied by the frozen market snapshot.
 */
export function assessOpenTradability(
  bar: TradabilityBar | undefined,
  side: "buy" | "sell"
): TradabilityDecision {
  if (!bar) return { executable: false, reason: "explicitly_untradable" };
  if (bar.calendarSession === "closed") return { executable: false, reason: "calendar_closed" };
  if (bar.suspended) return { executable: false, reason: "suspended" };
  if (bar.tradable === false) return { executable: false, reason: "explicitly_untradable" };
  if (side === "buy" && bar.priceLimitUp !== undefined && bar.open >= bar.priceLimitUp) {
    return { executable: false, reason: "limit_up_buy_blocked" };
  }
  if (side === "sell" && bar.priceLimitDown !== undefined && bar.open <= bar.priceLimitDown) {
    return { executable: false, reason: "limit_down_sell_blocked" };
  }
  return { executable: true, reason: "tradable" };
}
