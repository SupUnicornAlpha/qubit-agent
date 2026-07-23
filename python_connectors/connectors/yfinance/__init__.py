"""
YFinance DataConnector — Yahoo Finance via the `yfinance` Python package.

Why exists alongside the TS-only `yahoo_chart` source?
- yahoo_chart hits the unofficial v8 chart endpoint directly (no Python deps);
  it's enough for OHLCV but doesn't expose dividends / earnings / `Ticker.info`.
- This connector wraps `yfinance` so the agent can pull richer fundamentals
  without us re-implementing cookies/crumb/holdings/options parsing in TS.

Operations:
  fetch_bars         → OHLCV (BarData[])
  fetch_dividends    → [{ date, amount }]
  fetch_earnings     → [{ period, eps?, revenue?, source }]   (income statement rows + earnings dates)
  fetch_asset_info   → { shortName, sector, industry, marketCap, ... }
                       PII fields (address/email/phone) are stripped at this layer.

Install: pip install yfinance pandas
"""

from __future__ import annotations

import re
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from ..base import BaseConnector

_UTC = timezone.utc

ASSET_INFO_WHITELIST: tuple[str, ...] = (
    "shortName",
    "longName",
    "sector",
    "industry",
    "country",
    "currency",
    "marketCap",
    "sharesOutstanding",
    "beta",
    "trailingPE",
    "dividendYield",
    "fiftyTwoWeekHigh",
    "fiftyTwoWeekLow",
    "longBusinessSummary",
    "exchange",
    "quoteType",
)


def _to_yahoo_symbol(symbol: str, exchange: str) -> str:
    """Mirror of TS `symbolToYahooSymbol` for the operations we care about.

    Kept intentionally minimal: A-share / HK / US / crypto. Others fall through
    as-is, matching yfinance's own tolerant ticker resolution.
    """
    s = symbol.strip().upper()
    ex = exchange.strip().upper()
    if not s:
        return s

    if "." in s:
        if s.endswith(".SH"):
            return f"{s[:-3]}.SS"
        return s

    digits = re.sub(r"\D", "", s)[-6:].zfill(6)
    if "SH" in ex or ex in ("SSE", "XSHG"):
        return f"{digits}.SS"
    if "SZ" in ex or ex in ("SZSE", "XSHE"):
        return f"{digits}.SZ"
    if "HK" in ex or ex == "HKEX":
        hk = re.sub(r"\D", "", s)[-5:].zfill(5)
        return f"{hk[-4:]}.HK"
    if ex in ("CRYPTO", "CC", "BINANCE"):
        if re.fullmatch(r"[A-Z0-9]{2,12}-USD", s):
            return s
        base = re.sub(r"-USD$", "", re.sub(r"[^A-Z0-9-]", "", s)) or "BTC"
        return base if "-" in base else f"{base}-USD"
    return s


_PERIOD_TO_INTERVAL = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "60m",
    "4h": "60m",  # aggregated to 4h windows below
    "1d": "1d",
}


def _to_iso(dt: Any) -> str:
    """Coerce a pandas Timestamp / datetime / numpy datetime to ISO 8601 UTC."""
    try:
        if hasattr(dt, "to_pydatetime"):
            dt = dt.to_pydatetime()
        if isinstance(dt, datetime):
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=_UTC)
            return dt.astimezone(_UTC).isoformat().replace("+00:00", "Z")
    except Exception:
        pass
    return str(dt)


class YFinanceConnector(BaseConnector):
    name = "yfinance"
    version = "1.0.0"

    def __init__(self) -> None:
        self._yf: Any = None

    def init(self, config: dict[str, Any]) -> None:
        try:
            import yfinance as yf  # type: ignore[import]
            self._yf = yf
        except ImportError as e:
            raise ImportError(
                "yfinance not installed. Run: pip install yfinance pandas"
            ) from e

    def healthcheck(self) -> dict[str, Any]:
        if self._yf is None:
            return {"healthy": False, "message": "Not initialized"}
        return {"healthy": True, "message": "yfinance ready"}

    def execute(self, operation: str, payload: dict[str, Any]) -> Any:
        if self._yf is None:
            raise RuntimeError("YFinanceConnector not initialized")
        proxy_url = str(payload.get("proxyUrl") or "").strip()
        if proxy_url:
            os.environ["HTTP_PROXY"] = proxy_url
            os.environ["HTTPS_PROXY"] = proxy_url
            os.environ["http_proxy"] = proxy_url
            os.environ["https_proxy"] = proxy_url
        else:
            os.environ.pop("HTTP_PROXY", None)
            os.environ.pop("HTTPS_PROXY", None)
            os.environ.pop("http_proxy", None)
            os.environ.pop("https_proxy", None)
        if operation == "fetch_bars":
            return self._fetch_bars(payload)
        if operation == "fetch_dividends":
            return self._fetch_dividends(payload)
        if operation == "fetch_earnings":
            return self._fetch_earnings(payload)
        if operation == "fetch_asset_info":
            return self._fetch_asset_info(payload)
        raise ValueError(f"Unknown operation: {operation}")

    # ─── operations ──────────────────────────────────────────────────────────

    def _fetch_bars(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        symbol = str(params.get("symbol", "")).strip()
        exchange = str(params.get("exchange", "")).strip()
        period = str(params.get("period", "1d"))
        start_date = str(params.get("startDate", ""))[:10]
        end_date = str(params.get("endDate", ""))[:10]

        interval = _PERIOD_TO_INTERVAL.get(period)
        if interval is None:
            return []

        ticker = self._yf.Ticker(_to_yahoo_symbol(symbol, exchange))
        hist = ticker.history(
            start=start_date,
            end=end_date,
            interval=interval,
            auto_adjust=False,
            actions=False,
        )
        if hist is None or getattr(hist, "empty", True):
            return []

        bars: list[dict[str, Any]] = []
        for ts, row in hist.iterrows():
            try:
                bars.append(
                    {
                        "symbol": symbol,
                        "exchange": exchange or "UNKNOWN",
                        "open": float(row.get("Open", 0)),
                        "high": float(row.get("High", 0)),
                        "low": float(row.get("Low", 0)),
                        "close": float(row.get("Close", 0)),
                        "volume": float(row.get("Volume", 0)),
                        "turnover": 0.0,
                        "timestamp": _to_iso(ts),
                    }
                )
            except (TypeError, ValueError):
                # skip rows yfinance occasionally fills with NaN around halts
                continue

        if period == "4h":
            return self._aggregate_4h(bars, symbol, exchange)
        return bars

    def _fetch_dividends(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        symbol = str(params.get("symbol", "")).strip()
        exchange = str(params.get("exchange", "")).strip()
        start_date = str(params.get("startDate", ""))[:10] or None
        end_date = str(params.get("endDate", ""))[:10] or None

        ticker = self._yf.Ticker(_to_yahoo_symbol(symbol, exchange))
        series = ticker.dividends
        if series is None or getattr(series, "empty", True):
            return []

        out: list[dict[str, Any]] = []
        for ts, amt in series.items():
            iso = _to_iso(ts)
            if start_date and iso[:10] < start_date:
                continue
            if end_date and iso[:10] > end_date:
                continue
            try:
                out.append({"date": iso, "amount": float(amt)})
            except (TypeError, ValueError):
                continue
        return out

    def _fetch_earnings(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        """Best-effort earnings: prefer income statement (annual + quarterly).

        yfinance has shifted attribute names across versions; we probe a few
        candidates and produce a normalized list. Empty list is the legitimate
        fallback (no exception) since earnings coverage is patchy on Yahoo.
        """
        symbol = str(params.get("symbol", "")).strip()
        exchange = str(params.get("exchange", "")).strip()
        ticker = self._yf.Ticker(_to_yahoo_symbol(symbol, exchange))

        out: list[dict[str, Any]] = []

        for source_name, attr in (
            ("annual_income", "income_stmt"),
            ("quarterly_income", "quarterly_income_stmt"),
        ):
            df = getattr(ticker, attr, None)
            if df is None or getattr(df, "empty", True):
                continue
            # df shape: rows = line items, columns = period dates
            try:
                cols = list(df.columns)
            except Exception:
                continue
            for col in cols:
                period_iso = _to_iso(col)[:10]
                row: dict[str, Any] = {"period": period_iso, "source": source_name}
                # Probe common line-item names; tolerate missing.
                for key, line_item in (
                    ("revenue", "Total Revenue"),
                    ("netIncome", "Net Income"),
                    ("operatingIncome", "Operating Income"),
                    ("eps", "Diluted EPS"),
                ):
                    try:
                        if line_item in df.index:
                            v = df.at[line_item, col]
                            row[key] = float(v) if v is not None and v == v else None
                    except (KeyError, TypeError, ValueError):
                        row[key] = None
                out.append(row)
        return out

    def _fetch_asset_info(self, params: dict[str, Any]) -> dict[str, Any]:
        symbol = str(params.get("symbol", "")).strip()
        exchange = str(params.get("exchange", "")).strip()
        ticker = self._yf.Ticker(_to_yahoo_symbol(symbol, exchange))

        info: dict[str, Any] = {}
        try:
            raw = ticker.info or {}
            info = {k: raw[k] for k in ASSET_INFO_WHITELIST if k in raw}
        except Exception:
            # yfinance can throw on rate limits / dead tickers; return empty
            info = {}

        info["symbol"] = symbol
        info["yahooSymbol"] = _to_yahoo_symbol(symbol, exchange)
        return info

    # ─── helpers ─────────────────────────────────────────────────────────────

    def _aggregate_4h(
        self, bars: list[dict[str, Any]], symbol: str, exchange: str
    ) -> list[dict[str, Any]]:
        if not bars:
            return []
        window_ms = 4 * 60 * 60 * 1000
        sorted_bars = sorted(bars, key=lambda b: b["timestamp"])
        out: list[dict[str, Any]] = []
        bucket: list[dict[str, Any]] = []
        bucket_key = -1

        def flush() -> None:
            nonlocal bucket, bucket_key
            if not bucket:
                return
            out.append(
                {
                    "symbol": symbol,
                    "exchange": exchange or "UNKNOWN",
                    "open": bucket[0]["open"],
                    "high": max(b["high"] for b in bucket),
                    "low": min(b["low"] for b in bucket),
                    "close": bucket[-1]["close"],
                    "volume": sum(b["volume"] for b in bucket),
                    "turnover": 0.0,
                    "timestamp": datetime.fromtimestamp(bucket_key / 1000, tz=_UTC).isoformat(),
                }
            )
            bucket = []

        for b in sorted_bars:
            ts_ms = int(
                datetime.fromisoformat(b["timestamp"].replace("Z", "+00:00")).timestamp() * 1000
            )
            k = (ts_ms // window_ms) * window_ms
            if not bucket:
                bucket_key = k
                bucket = [b]
            elif k == bucket_key:
                bucket.append(b)
            else:
                flush()
                bucket_key = k
                bucket = [b]
        flush()
        return out


def get_connector() -> YFinanceConnector:
    return YFinanceConnector()
