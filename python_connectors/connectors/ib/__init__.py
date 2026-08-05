"""
Interactive Brokers historical OHLCV via ib_insync / TWS Gateway.

Uses `IB.reqHistoricalData` (does not require the quote WS bridge stub).
Install: pip install ib_insync
Requires TWS or IB Gateway with API enabled.
"""

from __future__ import annotations

import math
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from ..base import BaseConnector

_UTC = timezone.utc

_BAR_SIZE = {
    "1m": "1 min",
    "5m": "5 mins",
    "15m": "15 mins",
    "30m": "30 mins",
    "1h": "1 hour",
    "4h": "4 hours",
    "1d": "1 day",
}

# Soft pacing-friendly chunk windows (calendar days) per bar size.
_CHUNK_DAYS = {
    "1m": 3,
    "5m": 10,
    "15m": 20,
    "30m": 30,
    "1h": 60,
    "4h": 120,
    "1d": 365,
}


def _parse_iso(value: str) -> datetime:
    text = (value or "").strip()
    if not text:
        return datetime.now(tz=_UTC)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        try:
            dt = datetime.strptime(text[:10], "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError(f"invalid date: {value!r}") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_UTC)
    return dt.astimezone(_UTC)


def _to_contract(symbol: str, exchange: str) -> Any:
    from ib_insync import Stock  # type: ignore

    s = symbol.strip().upper()
    ex = exchange.strip().upper()
    if not s:
        raise ValueError("symbol is required")

    if "." in s:
        base, suf = s.rsplit(".", 1)
        digits = re.sub(r"\D", "", base)
        suf = suf.upper()
        if suf in ("HK", "HKEX") and digits:
            return Stock(digits.lstrip("0") or digits, "SEHK", "HKD")
        if suf in ("SH", "SSE", "XSHG", "SZ", "SZSE", "XSHE", "BJ", "BSE") and digits:
            # CN equities via IB often need market data subscription + SMART routing.
            return Stock(digits, "SMART", "CNH")
        if suf in ("US", "NASDAQ", "NYSE", "AMEX"):
            return Stock(base, "SMART", "USD")
        s = base

    digits = re.sub(r"\D", "", s)
    if ex in ("HK", "HKEX") or (digits and len(digits) <= 5 and ex.startswith("HK")):
        code = (digits.lstrip("0") or digits).zfill(4) if digits else s
        return Stock(code, "SEHK", "HKD")
    if ex in ("SH", "SSE", "XSHG", "SZ", "SZSE", "XSHE", "BJ", "BSE") or (
        digits and len(digits) == 6
    ):
        return Stock(digits or s, "SMART", "CNH")
    return Stock(s, "SMART", "USD")


def _bar_timestamp(date_val: Any) -> str:
    if hasattr(date_val, "isoformat"):
        dt = date_val
        if getattr(dt, "tzinfo", None) is None:
            dt = dt.replace(tzinfo=_UTC)
        return dt.astimezone(_UTC).isoformat().replace("+00:00", "Z")
    raw = str(date_val or "").strip()
    if not raw:
        return datetime.now(tz=_UTC).isoformat().replace("+00:00", "Z")
    # Daily bars often "YYYYMMDD"
    if re.fullmatch(r"\d{8}", raw):
        dt = datetime.strptime(raw, "%Y%m%d").replace(tzinfo=_UTC)
        return dt.isoformat().replace("+00:00", "Z")
    # Intraday "YYYYMMDD HH:MM:SS" or ISO
    for fmt in ("%Y%m%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(raw[:19] if " " in raw else raw[:10], fmt).replace(tzinfo=_UTC)
            return dt.isoformat().replace("+00:00", "Z")
        except ValueError:
            continue
    return datetime.now(tz=_UTC).isoformat().replace("+00:00", "Z")


def _duration_for_chunk(days: int, period: str) -> str:
    days = max(1, int(days))
    if period == "1d":
        if days <= 365:
            return f"{days} D"
        years = max(1, int(math.ceil(days / 365)))
        return f"{years} Y"
    # Intraday: IB accepts "N D" / "N W"
    if days <= 7:
        return f"{days} D"
    weeks = max(1, int(math.ceil(days / 7)))
    if weeks <= 52:
        return f"{weeks} W"
    months = max(1, int(math.ceil(days / 30)))
    return f"{months} M"


def _end_datetime_str(dt: datetime) -> str:
    # Empty string = now; otherwise yyyymmdd hh:mm:ss UTC
    return dt.astimezone(_UTC).strftime("%Y%m%d %H:%M:%S") + " UTC"


class IbHistoryConnector(BaseConnector):
    @property
    def name(self) -> str:
        return "ib"

    @property
    def version(self) -> str:
        return "1.0.0"

    def init(self, config: dict[str, Any]) -> None:
        self._host = str(
            config.get("host")
            or os.environ.get("QUBIT_IB_HOST")
            or "127.0.0.1"
        ).strip() or "127.0.0.1"
        self._port = int(
            config.get("port")
            or os.environ.get("QUBIT_IB_PORT")
            or 7497
        )
        # Prefer a dedicated history client id to avoid colliding with trading.
        self._client_id = int(
            config.get("historyClientId")
            or config.get("history_client_id")
            or os.environ.get("QUBIT_IB_HISTORY_CLIENT_ID")
            or (
                int(config.get("clientId") or os.environ.get("QUBIT_IB_CLIENT_ID") or 1) + 50
            )
        )

    def healthcheck(self) -> dict[str, Any]:
        try:
            from ib_insync import IB  # type: ignore

            ib = IB()
            ib.connect(self._host, self._port, clientId=self._client_id, timeout=5)
            try:
                accounts = list(ib.managedAccounts())
                return {
                    "status": "healthy",
                    "healthy": True,
                    "message": "ib gateway connected",
                    "host": self._host,
                    "port": self._port,
                    "clientId": self._client_id,
                    "accounts": accounts,
                }
            finally:
                ib.disconnect()
        except ImportError:
            return {
                "status": "unhealthy",
                "healthy": False,
                "message": "ib_insync not installed; pip install ib_insync",
            }
        except Exception as e:  # noqa: BLE001
            return {
                "status": "unhealthy",
                "healthy": False,
                "message": str(e),
                "host": self._host,
                "port": self._port,
            }

    def execute(self, operation: str, payload: dict[str, Any]) -> Any:
        if operation == "fetch_bars":
            return self._fetch_bars(payload or {})
        raise ValueError(f"unsupported operation: {operation}")

    def _fetch_bars(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        from ib_insync import IB  # type: ignore

        symbol = str(params.get("symbol") or "").strip()
        exchange = str(params.get("exchange") or "").strip()
        period = str(params.get("period") or "1d").strip().lower()
        if period not in _BAR_SIZE:
            raise ValueError(f"ib unsupported period={period!r}")
        start = _parse_iso(str(params.get("startDate") or ""))
        end = _parse_iso(str(params.get("endDate") or ""))
        if end < start:
            start, end = end, start

        host = str(params.get("host") or self._host)
        port = int(params.get("port") or self._port)
        client_id = int(params.get("historyClientId") or params.get("clientId") or self._client_id)

        contract = _to_contract(symbol, exchange)
        bar_size = _BAR_SIZE[period]
        chunk_days = _CHUNK_DAYS[period]

        ib = IB()
        ib.connect(host, port, clientId=client_id, timeout=15)
        rows: list[dict[str, Any]] = []
        try:
            ib.qualifyContracts(contract)
            cursor_end = end
            while cursor_end > start:
                chunk_start = max(start, cursor_end - timedelta(days=chunk_days))
                duration = _duration_for_chunk(
                    max(1, (cursor_end - chunk_start).days + 1), period
                )
                bars = ib.reqHistoricalData(
                    contract,
                    endDateTime=_end_datetime_str(cursor_end),
                    durationStr=duration,
                    barSizeSetting=bar_size,
                    whatToShow="TRADES",
                    useRTH=True,
                    formatDate=1,
                    keepUpToDate=False,
                )
                if not bars:
                    # Step back anyway to avoid infinite loop on empty weekends.
                    cursor_end = chunk_start - timedelta(seconds=1)
                    continue
                for bar in bars:
                    ts = _bar_timestamp(getattr(bar, "date", None))
                    rows.append(
                        {
                            "symbol": symbol,
                            "exchange": exchange or "UNKNOWN",
                            "open": float(getattr(bar, "open", 0) or 0),
                            "high": float(getattr(bar, "high", 0) or 0),
                            "low": float(getattr(bar, "low", 0) or 0),
                            "close": float(getattr(bar, "close", 0) or 0),
                            "volume": float(getattr(bar, "volume", 0) or 0),
                            "turnover": 0.0,
                            "timestamp": ts,
                        }
                    )
                # Move window; small pause for pacing.
                cursor_end = chunk_start - timedelta(seconds=1)
                ib.sleep(0.35)
        finally:
            ib.disconnect()

        # Dedupe by timestamp (overlapping chunks).
        by_ts: dict[str, dict[str, Any]] = {}
        for row in rows:
            by_ts[row["timestamp"]] = row
        out = sorted(by_ts.values(), key=lambda b: b["timestamp"])
        start_iso = start.isoformat().replace("+00:00", "Z")
        end_iso = end.isoformat().replace("+00:00", "Z")
        return [b for b in out if start_iso <= b["timestamp"] <= end_iso]


def get_connector() -> IbHistoryConnector:
    return IbHistoryConnector()
