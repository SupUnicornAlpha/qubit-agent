"""
同花顺 iFinD historical OHLCV — desktop/terminal data API (not SuperMind backtest `history()`).

SuperMind's strategy `history()` only works inside the SuperMind research/backtest sandbox.
For Qubit desktop we use iFinDPy (`THS_HistoryQuotes` / `THS_HF`) which is the
Tonghuashun product that exposes historical bars to external Python processes.

Install: vendor iFinDPy (同花顺 iFinD 数据接口) + logged-in iFinD terminal where required.
Env: QUBIT_IFIND_USERNAME / QUBIT_IFIND_PASSWORD (or init config username/password).
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

from ..base import BaseConnector

_UTC = timezone.utc

# Daily HistoryQuotes period tokens.
_DAILY_PERIOD = {
    "1d": "D",
}

# High-frequency interval minutes for THS_HF / THS_HighFrequenceSequence.
_HF_INTERVAL = {
    "1m": "1",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1h": "60",
    "4h": "240",
}


def _to_ths_code(symbol: str, exchange: str) -> str:
    s = symbol.strip().upper()
    ex = exchange.strip().upper()
    if not s:
        raise ValueError("symbol is required")
    if re.fullmatch(r"\d{6}\.(SH|SZ|BJ|OF)", s):
        return s
    if "." in s:
        base, suf = s.rsplit(".", 1)
        digits = re.sub(r"\D", "", base)
        suf = suf.upper()
        if digits and suf in ("SH", "SSE", "XSHG"):
            return f"{digits.zfill(6)}.SH"
        if digits and suf in ("SZ", "SZSE", "XSHE"):
            return f"{digits.zfill(6)}.SZ"
        if digits and suf in ("BJ", "BSE"):
            return f"{digits.zfill(6)}.BJ"
        if digits and suf in ("HK", "HKEX"):
            return f"{digits.zfill(5)}.HK"
        return s
    digits = re.sub(r"\D", "", s)
    if digits and len(digits) == 6:
        if digits.startswith(("5", "6", "9")) or ex in ("SH", "SSE", "XSHG"):
            return f"{digits}.SH"
        if ex in ("BJ", "BSE") or digits.startswith(("4", "8")):
            return f"{digits}.BJ"
        return f"{digits}.SZ"
    if digits and (ex in ("HK", "HKEX") or len(digits) <= 5):
        return f"{digits.zfill(5)}.HK"
    raise ValueError(f"cannot map symbol={symbol!r} exchange={exchange!r} to iFinD code")


def _ymd(iso_or_date: str) -> str:
    text = (iso_or_date or "").strip()
    if not text:
        return datetime.now(tz=_UTC).strftime("%Y-%m-%d")
    if "T" in text:
        text = text.split("T", 1)[0]
    return text[:10]


def _ymd_hms(iso_or_date: str, end: bool = False) -> str:
    text = (iso_or_date or "").strip()
    if not text:
        now = datetime.now(tz=_UTC)
        return now.strftime("%Y-%m-%d %H:%M:%S")
    if "T" in text:
        try:
            raw = text.replace("Z", "+00:00")
            dt = datetime.fromisoformat(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=_UTC)
            return dt.astimezone(_UTC).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            pass
    day = text[:10]
    return f"{day} {'15:00:00' if end else '09:30:00'}"


def _row_timestamp(time_key: Any) -> str:
    raw = str(time_key or "").strip()
    if not raw:
        return datetime.now(tz=_UTC).isoformat().replace("+00:00", "Z")
    if re.fullmatch(r"\d{8}", raw):
        dt = datetime.strptime(raw, "%Y%m%d").replace(tzinfo=_UTC)
        return dt.isoformat().replace("+00:00", "Z")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            piece = raw[:19] if " " in raw or "/" in raw else raw[:10]
            dt = datetime.strptime(piece, fmt).replace(tzinfo=_UTC)
            return dt.isoformat().replace("+00:00", "Z")
        except ValueError:
            continue
    return datetime.now(tz=_UTC).isoformat().replace("+00:00", "Z")


def _extract_table(result: Any) -> list[dict[str, Any]]:
    """Normalize iFinDPy return shapes into list of dict rows."""
    if result is None:
        return []
    if isinstance(result, dict):
        err = result.get("errorcode", result.get("errorCode", 0))
        if err not in (0, "0", None):
            msg = result.get("errmsg") or result.get("errorMsg") or result.get("message") or result
            raise RuntimeError(f"iFinD errorcode={err}: {msg}")
        tables = result.get("tables") or result.get("data") or result.get("table")
        if tables is None:
            return []
        if isinstance(tables, list):
            # Sometimes [{time:[], open:[], ...}] or list of row dicts
            if tables and isinstance(tables[0], dict) and any(
                isinstance(v, list) for v in tables[0].values()
            ):
                block = tables[0]
                keys = list(block.keys())
                n = max((len(block[k]) for k in keys if isinstance(block[k], list)), default=0)
                rows = []
                for i in range(n):
                    rows.append({k: (block[k][i] if isinstance(block[k], list) and i < len(block[k]) else None) for k in keys})
                return rows
            return [r for r in tables if isinstance(r, dict)]
        if hasattr(tables, "to_dict"):
            return tables.to_dict(orient="records")  # type: ignore[no-any-return]
        return []
    if hasattr(result, "to_dict"):
        try:
            return result.to_dict(orient="records")  # type: ignore[no-any-return]
        except Exception:  # noqa: BLE001
            pass
    if isinstance(result, list):
        return [r for r in result if isinstance(r, dict)]
    return []


class IfindHistoryConnector(BaseConnector):
    @property
    def name(self) -> str:
        return "ifind"

    @property
    def version(self) -> str:
        return "1.0.0"

    def init(self, config: dict[str, Any]) -> None:
        self._username = str(
            config.get("username")
            or config.get("ifindUsername")
            or os.environ.get("QUBIT_IFIND_USERNAME")
            or ""
        ).strip()
        self._password = str(
            config.get("password")
            or config.get("ifindPassword")
            or os.environ.get("QUBIT_IFIND_PASSWORD")
            or ""
        ).strip()
        self._logged_in = False

    def _ensure_login(self) -> None:
        if self._logged_in:
            return
        try:
            from iFinDPy import THS_iFinDLogin  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "iFinDPy not installed; install 同花顺 iFinD Python SDK (iFinDPy)"
            ) from exc
        if not self._username or not self._password:
            raise RuntimeError(
                "iFinD credentials missing (QUBIT_IFIND_USERNAME / QUBIT_IFIND_PASSWORD)"
            )
        ret = THS_iFinDLogin(self._username, self._password)
        # 0 = success on most builds; some return string "0"
        if ret not in (0, "0", None, True):
            raise RuntimeError(f"THS_iFinDLogin failed: {ret}")
        self._logged_in = True

    def healthcheck(self) -> dict[str, Any]:
        try:
            self._ensure_login()
            return {
                "status": "healthy",
                "healthy": True,
                "message": "iFinD login ok",
                "username": self._username,
            }
        except ImportError:
            return {
                "status": "unhealthy",
                "healthy": False,
                "message": "iFinDPy not installed",
            }
        except Exception as e:  # noqa: BLE001
            return {
                "status": "unhealthy",
                "healthy": False,
                "message": str(e),
                "username": self._username or None,
            }

    def execute(self, operation: str, payload: dict[str, Any]) -> Any:
        if operation == "fetch_bars":
            return self._fetch_bars(payload or {})
        raise ValueError(f"unsupported operation: {operation}")

    def _fetch_bars(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        self._ensure_login()
        symbol = str(params.get("symbol") or "").strip()
        exchange = str(params.get("exchange") or "").strip()
        period = str(params.get("period") or "1d").strip().lower()
        code = _to_ths_code(symbol, exchange)
        start = str(params.get("startDate") or "")
        end = str(params.get("endDate") or "")

        if period in _DAILY_PERIOD:
            rows = self._history_quotes_daily(code, start, end)
        elif period in _HF_INTERVAL:
            rows = self._high_freq(code, period, start, end)
        else:
            raise ValueError(f"ifind unsupported period={period!r}")

        out: list[dict[str, Any]] = []
        for row in rows:
            # Field names vary across iFinD builds.
            time_key = (
                row.get("time")
                or row.get("time_key")
                or row.get("date")
                or row.get("thscode")
                or row.get("时间")
            )
            # If thscode column was mistaken, try remaining date-like keys
            if time_key == code:
                time_key = row.get("time") or row.get("date")
            open_ = float(row.get("open") or row.get("OPEN") or row.get("开盘价") or 0)
            high = float(row.get("high") or row.get("HIGH") or row.get("最高价") or 0)
            low = float(row.get("low") or row.get("LOW") or row.get("最低价") or 0)
            close = float(row.get("close") or row.get("CLOSE") or row.get("收盘价") or 0)
            volume = float(row.get("volume") or row.get("VOLUME") or row.get("成交量") or 0)
            turnover = float(
                row.get("amount")
                or row.get("turnover")
                or row.get("AMOUNT")
                or row.get("成交额")
                or 0
            )
            out.append(
                {
                    "symbol": symbol,
                    "exchange": exchange or "UNKNOWN",
                    "open": open_,
                    "high": high,
                    "low": low,
                    "close": close,
                    "volume": volume,
                    "turnover": turnover,
                    "timestamp": _row_timestamp(time_key),
                }
            )
        out.sort(key=lambda b: b["timestamp"])
        return out

    def _history_quotes_daily(self, code: str, start: str, end: str) -> list[dict[str, Any]]:
        from iFinDPy import THS_HistoryQuotes  # type: ignore

        result = THS_HistoryQuotes(
            code,
            "open,high,low,close,volume,amount",
            "period:D,pricetype:1,rptcategory:0,fqdate:1900-01-01,hb:YSHB,fill:Previous",
            _ymd(start),
            _ymd(end),
        )
        return _extract_table(result)

    def _high_freq(self, code: str, period: str, start: str, end: str) -> list[dict[str, Any]]:
        interval = _HF_INTERVAL[period]
        start_s = _ymd_hms(start, end=False)
        end_s = _ymd_hms(end, end=True)
        # Prefer THS_HF if present; fall back to THS_HighFrequenceSequence.
        try:
            from iFinDPy import THS_HF  # type: ignore

            result = THS_HF(
                code,
                "open;high;low;close;volume;amount",
                f"Fill:Previous,Interval:{interval}",
                start_s,
                end_s,
            )
            return _extract_table(result)
        except ImportError:
            pass
        try:
            from iFinDPy import THS_HighFrequenceSequence  # type: ignore

            result = THS_HighFrequenceSequence(
                code,
                "open;high;low;close;volume;amount",
                f"CPS:no,Fill:Previous,Interval:{interval}",
                start_s,
                end_s,
            )
            return _extract_table(result)
        except ImportError as exc:
            raise RuntimeError(
                "iFinDPy high-frequency APIs unavailable (THS_HF / THS_HighFrequenceSequence)"
            ) from exc


def get_connector() -> IfindHistoryConnector:
    return IfindHistoryConnector()
