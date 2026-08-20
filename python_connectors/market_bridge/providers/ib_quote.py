from __future__ import annotations

"""Interactive Brokers TWS / Gateway real-time market-data bridge.

The historical connector already uses ib_insync. This provider completes the
real-time side using the same local TWS/Gateway session. It only emits fields
that IB actually returned; depth and time-and-sales are entitlement-dependent.
"""

import logging
import os
import re
import threading
from datetime import datetime, timezone
from typing import Any, Callable

from market_bridge.protocol import event_payload, normalize_symbol

logger = logging.getLogger("market_bridge.ib")
EmitFn = Callable[[dict[str, Any]], None]


class IbQuoteProvider:
    id = "ib"

    def __init__(self, emit: EmitFn) -> None:
        self._emit = emit
        self._host = os.environ.get("QUBIT_IB_HOST", "127.0.0.1")
        self._port = int(os.environ.get("QUBIT_IB_PORT", "7497"))
        self._client_id = int(os.environ.get("QUBIT_IB_MARKET_CLIENT_ID", "71"))
        self._ib: Any | None = None
        self._subs: dict[str, dict[str, Any]] = {}
        self._tickers: dict[str, Any] = {}
        self._seen_trades: dict[str, str] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._seq = 0
        self._last_connect_error: str | None = None

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._poll_loop, name="ib-quote", daemon=True)
        self._thread.start()
        logger.info("IB quote bridge started %s:%s", self._host, self._port)

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3.0)
        self._disconnect()

    def subscribe(self, subscription: dict[str, Any]) -> None:
        symbol = normalize_symbol(subscription.get("symbol", ""))
        if not symbol:
            return
        with self._lock:
            self._subs[symbol] = subscription
        self._status(symbol, "subscribed")

    def unsubscribe(self, subscription: dict[str, Any]) -> None:
        symbol = normalize_symbol(subscription.get("symbol", ""))
        with self._lock:
            self._subs.pop(symbol, None)
            ticker = self._tickers.pop(symbol, None)
            self._seen_trades.pop(symbol, None)
        if ticker is not None and self._ib is not None:
            try:
                self._ib.cancelMktData(ticker.contract)
                self._ib.cancelMktDepth(ticker.contract, isSmartDepth=False)
            except Exception:  # noqa: BLE001
                pass

    def _next(self, kind: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._seq += 1
            sequence = self._seq
        self._emit(event_payload(kind=kind, sequence=sequence, data=data))

    def _status(self, symbol: str, status: str, **extra: Any) -> None:
        self._next("status", {"status": status, "provider": self.id, "symbol": symbol, **extra})

    def _poll_loop(self) -> None:
        while not self._stop.wait(0.7):
            with self._lock:
                subscriptions = dict(self._subs)
            if not subscriptions:
                continue
            if not self._ensure_connection():
                for symbol in subscriptions:
                    self._status(symbol, "waiting_tws", message=self._last_connect_error or "TWS / IB Gateway unavailable")
                continue
            for symbol, subscription in subscriptions.items():
                if symbol not in self._tickers:
                    self._subscribe_symbol(symbol, subscription)
            for symbol, subscription in subscriptions.items():
                ticker = self._tickers.get(symbol)
                if ticker is not None:
                    self._emit_ticker(symbol, subscription, ticker)
            try:
                self._ib.sleep(0.01)
            except Exception:  # noqa: BLE001
                self._disconnect()

    def _ensure_connection(self) -> bool:
        if self._ib is not None:
            try:
                if self._ib.isConnected():
                    return True
            except Exception:  # noqa: BLE001
                pass
        try:
            from ib_insync import IB  # type: ignore

            ib = IB()
            ib.connect(self._host, self._port, clientId=self._client_id, timeout=5)
            ib.reqMarketDataType(1)
            self._ib = ib
            self._last_connect_error = None
            return True
        except ImportError:
            self._last_connect_error = "ib_insync not installed; pip install ib-insync"
        except Exception as error:  # noqa: BLE001
            self._last_connect_error = str(error)
        return False

    def _disconnect(self) -> None:
        ib = self._ib
        self._ib = None
        self._tickers.clear()
        if ib is not None:
            try:
                ib.disconnect()
            except Exception:  # noqa: BLE001
                pass

    def _subscribe_symbol(self, symbol: str, subscription: dict[str, Any]) -> None:
        if self._ib is None:
            return
        try:
            contract = _to_contract(symbol, str(subscription.get("exchange") or ""))
            self._ib.qualifyContracts(contract)
            ticker = self._ib.reqMktData(contract, genericTickList="233", snapshot=False, regulatorySnapshot=False)
            try:
                self._ib.reqMktDepth(contract, 5, isSmartDepth=False)
            except Exception as error:  # noqa: BLE001
                logger.info("IB depth unavailable for %s: %s", symbol, error)
            self._tickers[symbol] = ticker
        except Exception as error:  # noqa: BLE001
            logger.warning("IB subscribe %s failed: %s", symbol, error)
            self._status(symbol, "capability_unavailable", message=str(error))

    def _emit_ticker(self, symbol: str, subscription: dict[str, Any], ticker: Any) -> None:
        timestamp = _now()
        bid = _number(getattr(ticker, "bid", None))
        ask = _number(getattr(ticker, "ask", None))
        last = _number(getattr(ticker, "last", None)) or _number(getattr(ticker, "close", None))
        if last is not None or bid is not None or ask is not None:
            self._next("quote", {
                "symbol": symbol, "exchange": str(subscription.get("exchange") or "US").upper(),
                "lastPrice": last, "bidPrice": bid, "askPrice": ask,
                "bidSize": _number(getattr(ticker, "bidSize", None)),
                "askSize": _number(getattr(ticker, "askSize", None)),
                "volume": _number(getattr(ticker, "volume", None)), "timestamp": timestamp,
            })
        bids = _dom_levels(getattr(ticker, "domBids", None))
        asks = _dom_levels(getattr(ticker, "domAsks", None))
        if bids or asks:
            self._next("order_book", {
                "symbol": symbol, "exchange": str(subscription.get("exchange") or "US").upper(),
                "bids": bids, "asks": asks, "timestamp": timestamp,
            })
        size = _number(getattr(ticker, "lastSize", None))
        if last is not None and size is not None and size > 0:
            trade_id = f"{getattr(ticker, 'time', '')}:{last}:{size}"
            if self._seen_trades.get(symbol) != trade_id:
                self._seen_trades[symbol] = trade_id
                self._next("trade", {
                    "id": f"ib:{symbol}:{trade_id}", "symbol": symbol,
                    "exchange": str(subscription.get("exchange") or "US").upper(),
                    "price": last, "volume": size, "timestamp": timestamp,
                })


def _to_contract(symbol: str, exchange: str) -> Any:
    from ib_insync import Stock  # type: ignore

    raw = symbol.upper()
    market = exchange.upper()
    if raw.endswith(".HK"):
        return Stock(raw[:-3].lstrip("0") or raw[:-3], "SEHK", "HKD")
    if market in ("HK", "HKEX"):
        return Stock(raw.lstrip("0") or raw, "SEHK", "HKD")
    if "." in raw:
        raw = raw.rsplit(".", 1)[0]
    if re.fullmatch(r"\d{6}", raw):
        raise ValueError("IB quote bridge does not route A-share symbols; use QMT/Futu")
    return Stock(raw, "SMART", "USD")


def _dom_levels(levels: Any) -> list[dict[str, float | str]]:
    if not isinstance(levels, (list, tuple)):
        return []
    result: list[dict[str, float | str]] = []
    for level in levels[:5]:
        price, size = _number(getattr(level, "price", None)), _number(getattr(level, "size", None))
        if price is None or size is None or price <= 0:
            continue
        row: dict[str, float | str] = {"price": price, "volume": size}
        if getattr(level, "marketMaker", None):
            row["marketMaker"] = str(level.marketMaker)
        result.append(row)
    return result


def _number(value: Any) -> float | None:
    try:
        number = float(value)
        return number if number == number and number not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
