"""
Wind DataConnector — OHLCV via WindPy (requires local Wind Financial Terminal).

Prerequisites:
  1. Install Wind Financial Terminal and log in (or provide username/password below).
  2. Install WindPy in the same Python env Wind ships, or copy WindPy from Wind install dir.
  3. pip install pandas (optional, for data handling)

Session:
  - init() calls w.start() once and keeps the subprocess connection alive.
  - fetch_bars / session_* ops call _ensure_connected() to reconnect if dropped.
"""

from __future__ import annotations

import re
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from ..base import BaseConnector

_CN_TZ = timezone(timedelta(hours=8))
_SESSION_LOCK = threading.Lock()


def _to_wind_code(symbol: str, exchange: str) -> str | None:
    s = symbol.strip().upper()
    ex = exchange.strip().upper()
    if not s:
        return None
    if re.search(r"\.[A-Z0-9]{1,4}$", s):
        return s
    digits = re.sub(r"\D", "", s)[-6:].zfill(6)
    if ex in ("US", "NASDAQ", "NYSE", "AMEX", "OTC") and not re.fullmatch(r"\d{6}", digits):
        if len(s) <= 6 and s.isalpha():
            return f"{s}.O"
        return None
    if ex in ("HK", "HKEX"):
        hk = re.sub(r"\D", "", s)[-5:].zfill(5)
        return f"{hk}.HK"
    if re.fullmatch(r"\d{6}", digits):
        if ex in ("BJ", "BSE") or digits.startswith(("4", "8", "9")):
            return f"{digits}.BJ"
        if ex in ("SZ", "SZSE", "XSHE") or digits.startswith(("0", "3")):
            return f"{digits}.SZ"
        return f"{digits}.SH"
    return None


def _iso_from_wind_time(raw: Any) -> str:
    if isinstance(raw, datetime):
        dt = raw if raw.tzinfo else raw.replace(tzinfo=_CN_TZ)
        return dt.isoformat()
    text = str(raw).strip()
    if not text:
        return datetime.now(tz=_CN_TZ).isoformat()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(text[:19] if " " in fmt else text[:10], fmt)
            return dt.replace(tzinfo=_CN_TZ).isoformat()
        except ValueError:
            continue
    if len(text) >= 8 and text[:8].isdigit():
        try:
            dt = datetime.strptime(text[:8], "%Y%m%d")
            return dt.replace(tzinfo=_CN_TZ).isoformat()
        except ValueError:
            pass
    return text


def _period_to_wsi_barsize(period: str) -> str | None:
    mapping = {"1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "60"}
    return mapping.get(period)


class WindConnector(BaseConnector):
    name = "wind"
    version = "1.0.0"

    def __init__(self) -> None:
        self._w: Any = None
        self._username = ""
        self._password = ""
        self._wait_sec = 60
        self._auto_login = True
        self._last_login_at: str | None = None
        self._last_user_id: str | None = None

    def init(self, config: dict[str, Any]) -> None:
        try:
            from WindPy import w  # type: ignore[import]
        except ImportError as e:
            raise ImportError(
                "WindPy not installed. Install Wind Terminal + WindPy, or set PYTHONPATH to Wind's WindPy directory."
            ) from e

        self._w = w
        self._username = str(config.get("username") or config.get("windUsername") or "").strip()
        self._password = str(config.get("password") or config.get("windPassword") or "").strip()
        self._wait_sec = int(config.get("startWaitSec") or config.get("windStartWaitSec") or 60)
        auto = config.get("autoLogin", config.get("windAutoLogin", True))
        self._auto_login = bool(auto) if auto is not None else True
        self._connect(force=True)

    def shutdown(self) -> None:
        with _SESSION_LOCK:
            if self._w is not None:
                try:
                    self._w.stop()
                except Exception:
                    pass

    def healthcheck(self) -> dict[str, Any]:
        if self._w is None:
            return {"healthy": False, "message": "WindPy not initialized"}
        status = self._session_status_unlocked()
        if status.get("connected"):
            return {"healthy": True, "message": f"Wind connected ({status.get('userId') or 'unknown user'})"}
        return {"healthy": False, "message": status.get("message") or "Wind not connected"}

    def execute(self, operation: str, payload: dict[str, Any]) -> Any:
        if self._w is None:
            raise RuntimeError("WindConnector not initialized")
        if operation == "fetch_bars":
            return self._fetch_bars(payload)
        if operation == "session_status":
            return self._session_status()
        if operation == "session_login":
            username = str(payload.get("username") or self._username).strip()
            password = str(payload.get("password") or self._password).strip()
            wait_sec = int(payload.get("startWaitSec") or self._wait_sec)
            return self._session_login(username, password, wait_sec)
        if operation == "session_reconnect":
            return self._session_reconnect()
        raise ValueError(f"Unknown operation: {operation}")

    def _is_connected(self) -> bool:
        try:
            if self._w is None:
                return False
            ret = self._w.isconnected()
            if isinstance(ret, (list, tuple)) and len(ret) > 0:
                return int(ret[0]) == 1
            if hasattr(ret, "ErrorCode"):
                return int(ret.ErrorCode) == 0
            return bool(ret)
        except Exception:
            return False

    def _connect(self, force: bool = False) -> dict[str, Any]:
        with _SESSION_LOCK:
            if self._w is None:
                raise RuntimeError("WindPy not loaded")
            if not force and self._is_connected():
                return self._session_status_unlocked()
            try:
                self._w.stop()
            except Exception:
                pass
            kwargs: dict[str, Any] = {"waitTime": self._wait_sec}
            if self._auto_login and self._username and self._password:
                kwargs["username"] = self._username
                kwargs["password"] = self._password
            ret = self._w.start(**kwargs)
            err = getattr(ret, "ErrorCode", 0)
            if int(err) != 0:
                msg = getattr(ret, "Data", None) or str(ret)
                raise RuntimeError(f"Wind start failed: {msg}")
            self._last_login_at = datetime.now(tz=_CN_TZ).isoformat()
            self._last_user_id = self._query_user_id_unlocked()
            return self._session_status_unlocked()

    def _ensure_connected(self) -> None:
        if self._is_connected():
            return
        self._connect(force=True)

    def _query_user_id_unlocked(self) -> str | None:
        try:
            ret = self._w.tquery("logonuserid")
            if hasattr(ret, "ErrorCode") and int(ret.ErrorCode) != 0:
                return None
            data = getattr(ret, "Data", None)
            if isinstance(data, list) and data and isinstance(data[0], list) and data[0]:
                return str(data[0][0])
        except Exception:
            pass
        return None

    def _session_status_unlocked(self) -> dict[str, Any]:
        connected = self._is_connected()
        user_id = self._query_user_id_unlocked() if connected else None
        if user_id:
            self._last_user_id = user_id
        return {
            "connected": connected,
            "userId": user_id or self._last_user_id,
            "lastLoginAt": self._last_login_at,
            "message": "connected" if connected else "disconnected",
            "hasCredentials": bool(self._username and self._password),
        }

    def _session_status(self) -> dict[str, Any]:
        with _SESSION_LOCK:
            return self._session_status_unlocked()

    def _session_login(self, username: str, password: str, wait_sec: int) -> dict[str, Any]:
        with _SESSION_LOCK:
            self._username = username
            self._password = password
            self._wait_sec = wait_sec
            self._auto_login = True
            try:
                self._w.stop()
            except Exception:
                pass
            ret = self._w.start(waitTime=wait_sec, username=username, password=password)
            err = getattr(ret, "ErrorCode", 0)
            if int(err) != 0:
                msg = getattr(ret, "Data", None) or str(ret)
                raise RuntimeError(f"Wind login failed: {msg}")
            self._last_login_at = datetime.now(tz=_CN_TZ).isoformat()
            self._last_user_id = self._query_user_id_unlocked()
            return self._session_status_unlocked()

    def _session_reconnect(self) -> dict[str, Any]:
        return self._connect(force=True)

    def _wind_result_to_bars(
        self, result: Any, symbol: str, exchange: str, field_index: dict[str, int]
    ) -> list[dict[str, Any]]:
        if hasattr(result, "ErrorCode") and int(result.ErrorCode) != 0:
            msg = getattr(result, "Data", None) or f"ErrorCode={result.ErrorCode}"
            raise RuntimeError(f"Wind API error: {msg}")
        times = getattr(result, "Times", None) or []
        data = getattr(result, "Data", None) or []
        if not times or not data:
            return []
        out: list[dict[str, Any]] = []
        n = len(times)
        for i in range(n):
            def val(field: str) -> float:
                idx = field_index.get(field, -1)
                if idx < 0 or idx >= len(data):
                    return 0.0
                row = data[idx]
                if not row or i >= len(row):
                    return 0.0
                v = row[i]
                if v is None:
                    return 0.0
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return 0.0

            out.append(
                {
                    "symbol": symbol,
                    "exchange": exchange or "UNKNOWN",
                    "open": val("open"),
                    "high": val("high"),
                    "low": val("low"),
                    "close": val("close"),
                    "volume": val("volume"),
                    "turnover": val("amt"),
                    "timestamp": _iso_from_wind_time(times[i]),
                }
            )
        return out

    def _fetch_bars(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        self._ensure_connected()
        symbol = str(params.get("symbol", "")).strip()
        exchange = str(params.get("exchange", "")).strip()
        period = str(params.get("period", "1d"))
        start_date = str(params.get("startDate", ""))[:10]
        end_date = str(params.get("endDate", ""))[:10]
        code = _to_wind_code(symbol, exchange)
        if not code:
            raise ValueError(f"wind: unsupported symbol/exchange ({symbol!r}, {exchange!r})")

        fields = "open,high,low,close,volume,amt"
        field_names = ["open", "high", "low", "close", "volume", "amt"]
        field_index = {name: i for i, name in enumerate(field_names)}

        if period == "1d":
            result = self._w.wsd(code, fields, start_date, end_date, "")
            bars = self._wind_result_to_bars(result, symbol, exchange, field_index)
            return bars

        barsize = _period_to_wsi_barsize(period)
        if not barsize:
            return []

        start_dt = f"{start_date} 09:00:00"
        end_dt = f"{end_date} 15:00:00"
        options = f"BarSize={barsize}"
        result = self._w.wsi(code, fields, start_dt, end_dt, options)
        bars = self._wind_result_to_bars(result, symbol, exchange, field_index)
        if period == "4h":
            return self._aggregate_4h(bars, symbol, exchange)
        return bars

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


def get_connector() -> WindConnector:
    return WindConnector()
