export type MarketCode = "HK" | "US" | "CN" | "CRYPTO";

export interface TradingSessionConfig {
  tradingDays: number[];
  tradingStart: string;
  tradingEnd: string;
  timezone: string;
}

const DEFAULT_SESSIONS: Record<MarketCode, TradingSessionConfig> = {
  HK: {
    tradingDays: [1, 2, 3, 4, 5],
    tradingStart: "09:30",
    tradingEnd: "16:00",
    timezone: "Asia/Hong_Kong",
  },
  US: {
    tradingDays: [1, 2, 3, 4, 5],
    tradingStart: "09:30",
    tradingEnd: "16:00",
    timezone: "America/New_York",
  },
  CN: {
    tradingDays: [1, 2, 3, 4, 5],
    tradingStart: "09:30",
    tradingEnd: "15:00",
    timezone: "Asia/Shanghai",
  },
  CRYPTO: {
    tradingDays: [0, 1, 2, 3, 4, 5, 6],
    tradingStart: "00:00",
    tradingEnd: "23:59",
    timezone: "UTC",
  },
};

function parseHmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map((x) => Number.parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function localParts(now: Date, timezone: string): { weekday: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const wd = weekdayMap[parts.find((p) => p.type === "weekday")?.value ?? "Mon"] ?? 1;
  const hour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = Number.parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { weekday: wd, minutes: hour * 60 + minute };
}

export function getTradingSession(market: string, override?: Partial<TradingSessionConfig>): TradingSessionConfig {
  const key = (market.toUpperCase() as MarketCode) in DEFAULT_SESSIONS ? (market.toUpperCase() as MarketCode) : "US";
  const base = DEFAULT_SESSIONS[key];
  return {
    tradingDays: override?.tradingDays ?? base.tradingDays,
    tradingStart: override?.tradingStart ?? base.tradingStart,
    tradingEnd: override?.tradingEnd ?? base.tradingEnd,
    timezone: override?.timezone ?? base.timezone,
  };
}

export function isWithinTradingSession(
  now: Date,
  market: string,
  override?: Partial<TradingSessionConfig>
): boolean {
  const gate = getTradingSession(market, override);
  if (market.toUpperCase() === "CRYPTO") return true;

  const local = localParts(now, gate.timezone);
  if (!gate.tradingDays.includes(local.weekday)) return false;

  const start = parseHmToMinutes(gate.tradingStart);
  const end = parseHmToMinutes(gate.tradingEnd);
  if (start <= end) return local.minutes >= start && local.minutes <= end;
  return local.minutes >= start || local.minutes <= end;
}
