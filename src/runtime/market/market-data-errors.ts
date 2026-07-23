export type MarketDataFailureKind =
  | "credentials_missing"
  | "network_blocked"
  | "rate_limited"
  | "upstream_down"
  | "no_data"
  | "misconfigured"
  | "unknown";

export interface MarketDataFailure {
  kind: MarketDataFailureKind;
  message: string;
  retryAfterMs: number | null;
}

function retryAfterMsFromMessage(message: string): number | null {
  const seconds = message.match(/retry-after[=: ]+(\d+)/i)?.[1];
  if (!seconds) return null;
  return Math.max(1_000, Number(seconds) * 1_000);
}

export function classifyMarketDataFailure(error: unknown): MarketDataFailure {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  if (/credentials missing|token is missing|api key.*missing|未配置.*凭证/i.test(message)) {
    return { kind: "credentials_missing", message, retryAfterMs: null };
  }
  if (/HTTP 429|too many requests|rate.?limit/i.test(message)) {
    return {
      kind: "rate_limited",
      message,
      retryAfterMs: retryAfterMsFromMessage(message) ?? 120_000,
    };
  }
  if (
    /HTTP (403|451)|restricted location|proxyerror|unable to connect to proxy|dns|enotfound/i.test(
      message
    )
  ) {
    return { kind: "network_blocked", message, retryAfterMs: 300_000 };
  }
  if (/proxy.*required|proxy url|unsupported.*source|invalid.*base.?url|misconfig/i.test(message)) {
    return { kind: "misconfigured", message, retryAfterMs: null };
  }
  if (/no usable|no rows|returned no|empty|no data/i.test(message)) {
    return { kind: "no_data", message, retryAfterMs: 30_000 };
  }
  if (
    /timeout|timed out|socket|connection|HTTP 5\d\d|empty reply|remote disconnected|upstream/i.test(
      message
    )
  ) {
    return { kind: "upstream_down", message, retryAfterMs: 60_000 };
  }
  return { kind: "unknown", message, retryAfterMs: 30_000 };
}

export function formatMarketDataFailure(error: unknown): string {
  const failure = classifyMarketDataFailure(error);
  if (/^\[[a-z_]+\]\s/.test(failure.message)) return failure.message;
  return `[${failure.kind}] ${failure.message}`;
}
