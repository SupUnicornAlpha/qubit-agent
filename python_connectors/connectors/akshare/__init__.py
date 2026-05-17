"""
AKShare DataConnector — A-share OHLCV via AKShare (free, no API key).

Install: pip install akshare pandas
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from ..base import BaseConnector

_CN_TZ = timezone(timedelta(hours=8))


def _to_a_share_code(symbol: str, exchange: str) -> str | None:
    s = symbol.strip().upper()
    ex = exchange.strip().upper()
    if not s:
        return None
    if s.endswith((".SH", ".SZ", ".BJ")):
        return re.sub(r"\D", "", s.split(".", 1)[0])[-6:].zfill(6)
    digits = re.sub(r"\D", "", s)[-6:].zfill(6)
    if ex in ("US", "NASDAQ", "NYSE", "AMEX", "OTC") and not re.fullmatch(r"\d{6}", digits):
        return None
    if re.fullmatch(r"\d{6}", digits):
        return digits
    if len(s) <= 6 and s.isalnum() and any(c.isalpha() for c in s):
        return None
    return digits if re.fullmatch(r"\d{6}", digits) else None


def _iso_from_cn_datetime(raw: str) -> str:
    text = raw.strip()
    if not text:
        return datetime.now(tz=_CN_TZ).isoformat().replace("+00:00", "Z")
    if " " in text:
        dt = datetime.strptime(text[:19], "%Y-%m-%d %H:%M:%S")
    elif len(text) >= 10 and text[4] == "-":
        dt = datetime.strptime(text[:10], "%Y-%m-%d")
    else:
        dt = datetime.strptime(text[:8], "%Y%m%d")
    return dt.replace(tzinfo=_CN_TZ).isoformat()


def _period_to_ak_minute(period: str) -> str | None:
    mapping = {
        "1m": "1",
        "5m": "5",
        "15m": "15",
        "30m": "30",
        "1h": "60",
        "4h": "60",
    }
    return mapping.get(period)


class AKShareConnector(BaseConnector):
    name = "akshare"
    version = "1.0.0"

    def __init__(self) -> None:
        self._ak: Any = None

    def init(self, config: dict[str, Any]) -> None:
        try:
            import akshare as ak  # type: ignore[import]
            self._ak = ak
        except ImportError as e:
            raise ImportError("akshare not installed. Run: pip install akshare pandas") from e

    def healthcheck(self) -> dict[str, Any]:
        if self._ak is None:
            return {"healthy": False, "message": "Not initialized"}
        return {"healthy": True, "message": "akshare ready"}

    def execute(self, operation: str, payload: dict[str, Any]) -> Any:
        if self._ak is None:
            raise RuntimeError("AKShareConnector not initialized")
        if operation == "fetch_bars":
            return self._fetch_bars(payload)
        if operation == "fetch_news":
            return self._fetch_news(payload)
        raise ValueError(f"Unknown operation: {operation}")

    def _fetch_bars(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        symbol = str(params.get("symbol", "")).strip()
        exchange = str(params.get("exchange", "")).strip()
        period = str(params.get("period", "1d"))
        start_date = str(params.get("startDate", ""))[:10]
        end_date = str(params.get("endDate", ""))[:10]
        code = _to_a_share_code(symbol, exchange)
        if not code:
            raise ValueError(f"akshare: unsupported symbol/exchange ({symbol!r}, {exchange!r})")

        start_ymd = start_date.replace("-", "")
        end_ymd = end_date.replace("-", "")

        if period == "1d":
            df = self._ak.stock_zh_a_hist(
                symbol=code,
                period="daily",
                start_date=start_ymd,
                end_date=end_ymd,
                adjust="qfq",
            )
            return self._daily_df_to_bars(df, symbol, exchange)

        min_p = _period_to_ak_minute(period)
        if not min_p:
            return []

        start_dt = f"{start_date} 09:30:00"
        end_dt = f"{end_date} 15:00:00"
        df = self._ak.stock_zh_a_hist_min_em(
            symbol=code,
            start_date=start_dt,
            end_date=end_dt,
            period=min_p,
        )
        bars = self._minute_df_to_bars(df, symbol, exchange)
        if period == "4h":
            return self._aggregate_4h(bars, symbol, exchange)
        return bars

    def _daily_df_to_bars(self, df: Any, symbol: str, exchange: str) -> list[dict[str, Any]]:
        if df is None or getattr(df, "empty", True):
            return []
        out: list[dict[str, Any]] = []
        for _, row in df.iterrows():
            date_raw = str(row.get("日期", row.iloc[0]))
            out.append(
                {
                    "symbol": symbol,
                    "exchange": exchange or "UNKNOWN",
                    "open": float(row.get("开盘", 0)),
                    "high": float(row.get("最高", 0)),
                    "low": float(row.get("最低", 0)),
                    "close": float(row.get("收盘", 0)),
                    "volume": float(row.get("成交量", 0)),
                    "turnover": float(row.get("成交额", 0) if "成交额" in row else 0),
                    "timestamp": _iso_from_cn_datetime(date_raw),
                }
            )
        return out

    def _minute_df_to_bars(self, df: Any, symbol: str, exchange: str) -> list[dict[str, Any]]:
        if df is None or getattr(df, "empty", True):
            return []
        out: list[dict[str, Any]] = []
        time_col = "时间" if "时间" in df.columns else df.columns[0]
        for _, row in df.iterrows():
            date_raw = str(row.get(time_col, row.iloc[0]))
            out.append(
                {
                    "symbol": symbol,
                    "exchange": exchange or "UNKNOWN",
                    "open": float(row.get("开盘", 0)),
                    "high": float(row.get("最高", 0)),
                    "low": float(row.get("最低", 0)),
                    "close": float(row.get("收盘", 0)),
                    "volume": float(row.get("成交量", 0)),
                    "turnover": float(row.get("成交额", 0) if "成交额" in row else 0),
                    "timestamp": _iso_from_cn_datetime(date_raw),
                }
            )
        return out

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
                    "turnover": sum(b.get("turnover", 0) for b in bucket),
                    "timestamp": datetime.fromtimestamp(bucket_key / 1000, tz=_CN_TZ).isoformat(),
                }
            )
            bucket = []

        for b in sorted_bars:
            ts = datetime.fromisoformat(b["timestamp"].replace("Z", "+00:00")).timestamp() * 1000
            k = int(ts // window_ms) * window_ms
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

    def _fetch_news(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        _ = params
        return []


def get_connector() -> AKShareConnector:
    return AKShareConnector()
