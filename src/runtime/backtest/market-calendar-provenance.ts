export interface TradingCalendarProvenance {
  /** Immutable exchange-calendar release used to create the market snapshot. */
  version?: string;
  /** IANA timezone in which session dates and open-auction fields are interpreted. */
  timezone?: string;
  /** Symbol-specific session states copied from the immutable snapshot. */
  sessionsBySymbol?: Record<string, Record<string, "open" | "closed">>;
}

export interface TradingCalendarProvenanceCheck {
  state: "pass" | "warning";
  code:
    | "calendar_version_missing"
    | "calendar_timezone_missing"
    | "calendar_timezone_invalid"
    | "calendar_sessions_missing"
    | "calendar_provenance_valid";
  message: string;
}

/**
 * Calendar validation is deliberately provenance-only at this layer. A backtest must not
 * infer holidays or sessions from missing bars: that requires a separately versioned exchange
 * session table. Until then, a frozen calendar version + IANA timezone is the minimum evidence.
 */
export function assessTradingCalendarProvenance(
  calendar: TradingCalendarProvenance | undefined
): TradingCalendarProvenanceCheck[] {
  const checks: TradingCalendarProvenanceCheck[] = [];
  const version = calendar?.version?.trim();
  const timezone = calendar?.timezone?.trim();
  const hasSessions = Object.values(calendar?.sessionsBySymbol ?? {}).some(
    (sessions) => Object.keys(sessions).length > 0
  );

  if (!version) {
    checks.push({
      state: "warning",
      code: "calendar_version_missing",
      message: "快照未冻结交易日历版本；不得由缺失 K 线推断节假日或开市状态",
    });
  }
  if (!timezone) {
    checks.push({
      state: "warning",
      code: "calendar_timezone_missing",
      message: "快照未声明交易日历时区，无法审计交易日边界",
    });
  } else if (!isIanaTimeZone(timezone)) {
    checks.push({
      state: "warning",
      code: "calendar_timezone_invalid",
      message: `交易日历时区无效: ${timezone}`,
    });
  }
  if (!hasSessions) {
    checks.push({
      state: "warning",
      code: "calendar_sessions_missing",
      message: "快照未提供逐标的交易会话表；无法验证闭市日的订单不会被撮合",
    });
  }
  if (checks.length === 0) {
    checks.push({
      state: "pass",
      code: "calendar_provenance_valid",
      message: "交易日历版本与 IANA 时区已随快照冻结",
    });
  }
  return checks;
}

function isIanaTimeZone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}
