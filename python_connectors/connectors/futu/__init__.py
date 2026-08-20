"""
Futu OpenQuote DataConnector — historical OHLCV via OpenD.

Uses `OpenQuoteContext.request_history_kline` (does not require the quote WS bridge).
For listed options it combines `get_option_chain` (contract metadata) with
`get_market_snapshot` (current quote / IV / OI / Greeks).  The OpenD API returns
the former as static data only, so treating `get_option_chain` by itself as a
live option chain would be incorrect.
Install: pip install futu-api
Requires a running OpenD with quote entitlement for the requested market.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

from ..base import BaseConnector

_UTC = timezone.utc


def _to_futu_code(symbol: str, exchange: str) -> str:
    s = symbol.strip().upper()
    ex = exchange.strip().upper()
    if not s:
        raise ValueError("symbol is required")

    if s.startswith(("SH.", "SZ.", "HK.", "US.", "BJ.")):
        return s

    if "." in s:
        base, suf = s.rsplit(".", 1)
        digits = re.sub(r"\D", "", base)
        suf = suf.upper()
        if suf in ("SH", "SSE", "XSHG") and digits:
            return f"SH.{digits.zfill(6)}"
        if suf in ("SZ", "SZSE", "XSHE") and digits:
            return f"SZ.{digits.zfill(6)}"
        if suf in ("BJ", "BSE") and digits:
            return f"BJ.{digits.zfill(6)}"
        if suf in ("HK", "HKEX") and digits:
            return f"HK.{digits.zfill(5)}"
        if suf in ("US", "NASDAQ", "NYSE", "AMEX"):
            return f"US.{base}"
        return s

    digits = re.sub(r"\D", "", s)
    if ex in ("HK", "HKEX") or (digits and len(digits) <= 5 and ex.startswith("HK")):
        return f"HK.{digits.zfill(5)}"
    if ex in ("US", "NASDAQ", "NYSE", "AMEX", "OTC") or re.fullmatch(r"[A-Z]{1,5}", s):
        return f"US.{s}"
    if digits and len(digits) == 6:
        if digits.startswith(("5", "6", "9")) or ex in ("SH", "SSE", "XSHG"):
            return f"SH.{digits}"
        if ex in ("BJ", "BSE") or digits.startswith(("4", "8")):
            return f"BJ.{digits}"
        return f"SZ.{digits}"
    raise ValueError(f"cannot map symbol={symbol!r} exchange={exchange!r} to Futu code")


def _period_to_kltype(period: str) -> Any:
    from futu import KLType  # type: ignore

    mapping = {
        "1m": KLType.K_1M,
        "5m": KLType.K_5M,
        "15m": KLType.K_15M,
        "30m": KLType.K_30M,
        "1h": KLType.K_60M,
        # Some futu-api builds expose K_240M; fall back to 60m if absent.
        "4h": getattr(KLType, "K_240M", None) or KLType.K_60M,
        "1d": KLType.K_DAY,
    }
    key = (period or "1d").strip().lower()
    if key not in mapping:
        raise ValueError(f"futu unsupported period={period!r}")
    return mapping[key]


def _ymd(iso_or_date: str) -> str:
    text = (iso_or_date or "").strip()
    if not text:
        return datetime.now(tz=_UTC).strftime("%Y-%m-%d")
    if "T" in text:
        text = text.split("T", 1)[0]
    return text[:10]


def _row_timestamp(time_key: Any) -> str:
    raw = str(time_key or "").strip()
    if not raw:
        return datetime.now(tz=_UTC).isoformat().replace("+00:00", "Z")
    # Futu usually returns "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"
    if " " in raw:
        try:
            dt = datetime.strptime(raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=_UTC)
            return dt.isoformat().replace("+00:00", "Z")
        except ValueError:
            pass
    if len(raw) >= 10:
        try:
            dt = datetime.strptime(raw[:10], "%Y-%m-%d").replace(tzinfo=_UTC)
            return dt.isoformat().replace("+00:00", "Z")
        except ValueError:
            pass
    return datetime.now(tz=_UTC).isoformat().replace("+00:00", "Z")


class FutuQuoteConnector(BaseConnector):
    @property
    def name(self) -> str:
        return "futu"

    @property
    def version(self) -> str:
        return "1.0.0"

    def init(self, config: dict[str, Any]) -> None:
        self._host = str(
            config.get("opendHost")
            or config.get("opend_host")
            or os.environ.get("QUBIT_FUTU_OPEND_HOST")
            or "127.0.0.1"
        ).strip() or "127.0.0.1"
        self._port = int(
            config.get("opendPort")
            or config.get("opend_port")
            or os.environ.get("QUBIT_FUTU_OPEND_PORT")
            or 11111
        )

    def healthcheck(self) -> dict[str, Any]:
        try:
            from futu import OpenQuoteContext, RET_OK  # type: ignore

            ctx = OpenQuoteContext(host=self._host, port=self._port)
            try:
                # Lightweight call: empty snapshot list is still a connectivity probe.
                ret, _data = ctx.get_global_state()
                ok = ret == RET_OK
                return {
                    "status": "healthy" if ok else "unhealthy",
                    "healthy": ok,
                    "message": "futu OpenQuote ok" if ok else f"get_global_state ret={ret}",
                    "opendHost": self._host,
                    "opendPort": self._port,
                }
            finally:
                ctx.close()
        except ImportError:
            return {
                "status": "unhealthy",
                "healthy": False,
                "message": "futu-api not installed; pip install futu-api",
            }
        except Exception as e:  # noqa: BLE001
            return {
                "status": "unhealthy",
                "healthy": False,
                "message": str(e),
                "opendHost": self._host,
                "opendPort": self._port,
            }

    def execute(self, operation: str, payload: dict[str, Any]) -> Any:
        if operation == "fetch_bars":
            return self._fetch_bars(payload or {})
        if operation == "fetch_option_chain":
            return self._fetch_option_chain(payload or {})
        raise ValueError(f"unsupported operation: {operation}")

    def _fetch_bars(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        from futu import AuType, OpenQuoteContext, RET_OK  # type: ignore

        symbol = str(params.get("symbol") or "").strip()
        exchange = str(params.get("exchange") or "").strip()
        period = str(params.get("period") or "1d").strip()
        start = _ymd(str(params.get("startDate") or ""))
        end = _ymd(str(params.get("endDate") or ""))
        code = _to_futu_code(symbol, exchange)
        ktype = _period_to_kltype(period)

        host = str(params.get("opendHost") or self._host)
        port = int(params.get("opendPort") or self._port)

        ctx = OpenQuoteContext(host=host, port=port)
        rows: list[dict[str, Any]] = []
        try:
            page_req_key = None
            while True:
                ret, data, page_req_key = ctx.request_history_kline(
                    code,
                    start=start,
                    end=end,
                    ktype=ktype,
                    autype=AuType.QFQ,
                    max_count=1000,
                    page_req_key=page_req_key,
                )
                if ret != RET_OK:
                    raise RuntimeError(f"futu request_history_kline failed: {data}")
                if data is None or getattr(data, "empty", True):
                    break
                for _, row in data.iterrows():
                    time_key = row.get("time_key") if hasattr(row, "get") else row["time_key"]
                    open_ = float(row.get("open", 0) if hasattr(row, "get") else row["open"] or 0)
                    high = float(row.get("high", 0) if hasattr(row, "get") else row["high"] or 0)
                    low = float(row.get("low", 0) if hasattr(row, "get") else row["low"] or 0)
                    close = float(row.get("close", 0) if hasattr(row, "get") else row["close"] or 0)
                    volume = float(
                        row.get("volume", 0) if hasattr(row, "get") else row["volume"] or 0
                    )
                    turnover = float(
                        row.get("turnover", 0) if hasattr(row, "get") else row["turnover"] or 0
                    )
                    rows.append(
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
                if page_req_key is None:
                    break
        finally:
            ctx.close()

        rows.sort(key=lambda b: b["timestamp"])
        return rows

    def _fetch_option_chain(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return one expiry of a Futu/OpenD option chain with current snapshots.

        Futu's option-chain API supplies contract metadata only.  Snapshot data
        is requested in batches afterwards, which is the source of price, bid /
        ask, volume, open interest, IV and available Greeks.  This stays a
        read-only market-data operation; no trading API is opened.
        """
        from futu import OpenQuoteContext, RET_OK  # type: ignore

        symbol = str(params.get("symbol") or "").strip()
        exchange = str(params.get("exchange") or "US").strip()
        if not symbol:
            raise ValueError("fetch_option_chain: symbol is required")
        code = _to_futu_code(symbol, exchange)
        requested_expiry = _ymd(str(params.get("expiry") or "")) if params.get("expiry") else ""
        host = str(params.get("opendHost") or self._host)
        port = int(params.get("opendPort") or self._port)

        ctx = OpenQuoteContext(host=host, port=port)
        try:
            ret, expiry_data = ctx.get_option_expiration_date(code)
            if ret != RET_OK:
                raise RuntimeError(f"futu get_option_expiration_date failed: {expiry_data}")
            expirations = sorted(
                {
                    str(row.get("strike_time") or "").strip()
                    for _, row in expiry_data.iterrows()
                    if str(row.get("strike_time") or "").strip()
                }
            )
            if not expirations:
                raise RuntimeError(f"futu get_option_expiration_date returned no listed options for {code}")
            expiry = requested_expiry if requested_expiry in expirations else expirations[0]

            ret, chain_data = ctx.get_option_chain(code, start=expiry, end=expiry)
            if ret != RET_OK:
                raise RuntimeError(f"futu get_option_chain failed: {chain_data}")
            if chain_data is None or getattr(chain_data, "empty", True):
                raise RuntimeError(f"futu get_option_chain returned no contracts for {code} @ {expiry}")

            contract_rows: list[dict[str, Any]] = []
            codes: list[str] = []
            for _, row in chain_data.iterrows():
                option_code = str(row.get("code") or "").strip().upper()
                strike = _finite_or_none(row.get("strike_price"))
                right = _option_right(row.get("option_type"))
                if not option_code or strike is None or right is None:
                    continue
                contract_rows.append(
                    {
                        "code": option_code,
                        "right": right,
                        "strike": strike,
                        "expiration": str(row.get("strike_time") or expiry).strip() or expiry,
                    }
                )
                codes.append(option_code)
            if not contract_rows:
                raise RuntimeError(f"futu get_option_chain returned no usable call/put contracts for {code}")

            snapshots: dict[str, Any] = {}
            # Futu documents a maximum of 400 snapshot codes per request.
            for offset in range(0, len(codes), 400):
                ret, snapshot_data = ctx.get_market_snapshot(codes[offset : offset + 400])
                if ret != RET_OK:
                    raise RuntimeError(f"futu get_market_snapshot failed: {snapshot_data}")
                if snapshot_data is None or getattr(snapshot_data, "empty", True):
                    continue
                for _, row in snapshot_data.iterrows():
                    snapshot_code = str(row.get("code") or "").strip().upper()
                    if snapshot_code:
                        snapshots[snapshot_code] = row

            ret, underlying_snapshot = ctx.get_market_snapshot([code])
            if ret != RET_OK:
                raise RuntimeError(f"futu underlying snapshot failed: {underlying_snapshot}")
            spot = None
            if underlying_snapshot is not None and not getattr(underlying_snapshot, "empty", True):
                spot = _finite_or_none(underlying_snapshot.iloc[0].get("last_price"))

            calls: list[dict[str, Any]] = []
            puts: list[dict[str, Any]] = []
            for item in contract_rows:
                snapshot = snapshots.get(item["code"])
                previous = _finite_or_none(snapshot.get("prev_close_price")) if snapshot is not None else None
                last = _finite_or_none(snapshot.get("last_price")) if snapshot is not None else None
                change = last - previous if last is not None and previous is not None else None
                percent_change = (change / previous * 100) if change is not None and previous not in (None, 0) else None
                normalized = {
                    "contractSymbol": item["code"],
                    "right": item["right"],
                    "strike": item["strike"],
                    "lastPrice": last,
                    "bid": _finite_or_none(snapshot.get("bid_price")) if snapshot is not None else None,
                    "ask": _finite_or_none(snapshot.get("ask_price")) if snapshot is not None else None,
                    "change": change,
                    "percentChange": percent_change,
                    "volume": _finite_or_none(snapshot.get("volume")) if snapshot is not None else None,
                    "openInterest": _finite_or_none(snapshot.get("option_open_interest")) if snapshot is not None else None,
                    "impliedVolatility": _finite_or_none(snapshot.get("option_implied_volatility")) if snapshot is not None else None,
                    "inTheMoney": _is_in_the_money(item["right"], item["strike"], spot),
                    "expiration": f"{item['expiration'][:10]}T00:00:00Z",
                    "greeks": {
                        "delta": _finite_or_none(snapshot.get("option_delta")) if snapshot is not None else None,
                        "gamma": _finite_or_none(snapshot.get("option_gamma")) if snapshot is not None else None,
                        "vega": _finite_or_none(snapshot.get("option_vega")) if snapshot is not None else None,
                        "theta": _finite_or_none(snapshot.get("option_theta")) if snapshot is not None else None,
                        "rho": _finite_or_none(snapshot.get("option_rho")) if snapshot is not None else None,
                    },
                }
                (calls if item["right"] == "call" else puts).append(normalized)

            return {
                "underlying": symbol.upper(),
                "source": "futu_opend",
                "feedClass": "L2_realtime_observe",
                "licenseUse": "observe_only",
                "fallbackUsed": False,
                "fetchedAt": datetime.now(_UTC).isoformat().replace("+00:00", "Z"),
                "expirations": [f"{date[:10]}T00:00:00Z" for date in expirations],
                "calls": calls,
                "puts": puts,
            }
        finally:
            ctx.close()


def _finite_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed == parsed and parsed not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _option_right(value: Any) -> str | None:
    raw = str(value or "").upper()
    if "CALL" in raw:
        return "call"
    if "PUT" in raw:
        return "put"
    return None


def _is_in_the_money(right: str, strike: float, spot: float | None) -> bool:
    if spot is None:
        return False
    return spot >= strike if right == "call" else spot <= strike


def get_connector() -> FutuQuoteConnector:
    return FutuQuoteConnector()
