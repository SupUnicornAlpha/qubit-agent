/**
 * Versioned exchange-session release used by strategy runtimes.
 *
 * This module deliberately has no network or database dependency. A connector
 * may fetch an exchange or licensed-vendor calendar, validate it here, and
 * attach the immutable release to a runtime. Removing that connector simply
 * leaves live admission fail-closed; it never falls back to a guessed holiday
 * table.
 */

export type ExchangeCalendarRelease = {
  schemaVersion: 1;
  /** The source is evidence, not a free-text claim that a calendar is official. */
  sourceKind: "official_exchange" | "licensed_vendor";
  source: string;
  version: string;
  venue: string;
  timezone: string;
  retrievedAt: string;
  effectiveFrom: string;
  effectiveThrough: string;
  /** Every executable date must be explicit; omitted dates are closed/unknown. */
  sessions: Record<string, "open" | "closed">;
  /** Optional exact windows for early closes and split sessions. */
  sessionWindows?: Record<string, Array<{ openAt: string; closeAt: string; label?: string }>>;
};

export type ExchangeCalendarReleaseParseResult =
  | { ok: true; release: ExchangeCalendarRelease }
  | { ok: false; error: string };

export type ExchangeCalendarSessionDecision = {
  executable: boolean;
  reason:
    | "calendar_release_missing"
    | "calendar_release_venue_mismatch"
    | "calendar_release_out_of_range"
    | "calendar_session_missing"
    | "calendar_closed"
    | "calendar_open"
    | "calendar_outside_session_window";
  /** Exchange-local session date that the decision evaluated. */
  sessionDate?: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === kind)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function normalizeWindows(
  value: unknown,
  sessions: Record<string, "open" | "closed">
): Record<string, Array<{ openAt: string; closeAt: string; label?: string }>> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, Array<{ openAt: string; closeAt: string; label?: string }>> = {};
  for (const [date, rawWindows] of Object.entries(value)) {
    if (!validDate(date) || sessions[date] !== "open" || !Array.isArray(rawWindows)) return null;
    const windows = rawWindows.map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const window = raw as Record<string, unknown>;
      const openAt = typeof window.openAt === "string" ? window.openAt : "";
      const closeAt = typeof window.closeAt === "string" ? window.closeAt : "";
      if (
        !Number.isFinite(Date.parse(openAt)) ||
        !Number.isFinite(Date.parse(closeAt)) ||
        Date.parse(openAt) >= Date.parse(closeAt)
      ) {
        return null;
      }
      return {
        openAt,
        closeAt,
        ...(typeof window.label === "string" && window.label.trim()
          ? { label: window.label.trim() }
          : {}),
      };
    });
    if (windows.length === 0 || windows.some((window) => window === null)) return null;
    out[date] = windows as Array<{ openAt: string; closeAt: string; label?: string }>;
  }
  return out;
}

/** Strictly parse a persisted release; malformed releases are never permissive. */
export function parseExchangeCalendarRelease(value: unknown): ExchangeCalendarReleaseParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "calendar_release_missing" };
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return { ok: false, error: "calendar_release_schema_invalid" };
  if (raw.sourceKind !== "official_exchange" && raw.sourceKind !== "licensed_vendor") {
    return { ok: false, error: "calendar_release_source_kind_invalid" };
  }
  const stringFields = ["source", "version", "venue", "retrievedAt"] as const;
  if (stringFields.some((field) => typeof raw[field] !== "string" || !raw[field].trim())) {
    return { ok: false, error: "calendar_release_provenance_invalid" };
  }
  const source = raw.source as string;
  const version = raw.version as string;
  const venue = raw.venue as string;
  const retrievedAt = raw.retrievedAt as string;
  const timezone = raw.timezone as string;
  const effectiveFrom = raw.effectiveFrom as string;
  const effectiveThrough = raw.effectiveThrough as string;
  if (!Number.isFinite(Date.parse(retrievedAt))) {
    return { ok: false, error: "calendar_release_retrieved_at_invalid" };
  }
  if (!validTimeZone(timezone)) return { ok: false, error: "calendar_release_timezone_invalid" };
  if (!validDate(effectiveFrom) || !validDate(effectiveThrough)) {
    return { ok: false, error: "calendar_release_effective_range_invalid" };
  }
  if (effectiveFrom > effectiveThrough) {
    return { ok: false, error: "calendar_release_effective_range_invalid" };
  }
  if (!raw.sessions || typeof raw.sessions !== "object" || Array.isArray(raw.sessions)) {
    return { ok: false, error: "calendar_release_sessions_invalid" };
  }
  const sessions: Record<string, "open" | "closed"> = {};
  for (const [date, state] of Object.entries(raw.sessions)) {
    if (
      !validDate(date) ||
      date < effectiveFrom ||
      date > effectiveThrough ||
      (state !== "open" && state !== "closed")
    ) {
      return { ok: false, error: "calendar_release_sessions_invalid" };
    }
    sessions[date] = state;
  }
  if (Object.keys(sessions).length === 0)
    return { ok: false, error: "calendar_release_sessions_invalid" };
  const sessionWindows = normalizeWindows(raw.sessionWindows, sessions);
  if (!sessionWindows) return { ok: false, error: "calendar_release_session_windows_invalid" };
  return {
    ok: true,
    release: {
      schemaVersion: 1,
      sourceKind: raw.sourceKind,
      source: source.trim(),
      version: version.trim(),
      venue: venue.trim().toUpperCase(),
      timezone: timezone.trim(),
      retrievedAt,
      effectiveFrom,
      effectiveThrough,
      sessions,
      ...(Object.keys(sessionWindows).length > 0 ? { sessionWindows } : {}),
    },
  };
}

/**
 * Checks the exact release and intentionally treats an omitted date as
 * non-executable. The caller may separately apply a market's regular-hours
 * rule when an explicit open date has no intraday windows (daily strategies).
 */
export function assessExchangeCalendarSession(input: {
  release: unknown;
  venue: string;
  now: Date;
}): ExchangeCalendarSessionDecision {
  const parsed = parseExchangeCalendarRelease(input.release);
  if (!parsed.ok) return { executable: false, reason: "calendar_release_missing" };
  const release = parsed.release;
  if (release.venue !== input.venue.trim().toUpperCase()) {
    return { executable: false, reason: "calendar_release_venue_mismatch" };
  }
  const sessionDate = localDate(input.now, release.timezone);
  if (sessionDate < release.effectiveFrom || sessionDate > release.effectiveThrough) {
    return { executable: false, reason: "calendar_release_out_of_range", sessionDate };
  }
  const state = release.sessions[sessionDate];
  if (!state) return { executable: false, reason: "calendar_session_missing", sessionDate };
  if (state === "closed") return { executable: false, reason: "calendar_closed", sessionDate };
  const windows = release.sessionWindows?.[sessionDate];
  if (windows?.length) {
    const at = input.now.getTime();
    const within = windows.some((window) => {
      const open = Date.parse(window.openAt);
      const close = Date.parse(window.closeAt);
      return Number.isFinite(open) && Number.isFinite(close) && open <= at && at < close;
    });
    if (!within) {
      return { executable: false, reason: "calendar_outside_session_window", sessionDate };
    }
  }
  return { executable: true, reason: "calendar_open", sessionDate };
}
