from __future__ import annotations

"""QMT/xtquant market-data bridge for a locally installed miniQMT client.

xtquant is a locally distributed Windows SDK.  The bridge is intentionally
status-only on other platforms or when the user has not installed/started QMT;
it never turns cached or unavailable data into a synthetic quote.
"""

import logging
import sys
import threading
from datetime import datetime, timezone
from typing import Any, Callable

from market_bridge.protocol import event_payload, normalize_symbol

logger = logging.getLogger("market_bridge.qmt")
EmitFn = Callable[[dict[str, Any]], None]


class QmtQuoteProvider:
    id = "qmt"

    def __init__(self, emit: EmitFn) -> None:
        self._emit = emit
        self._xtdata: Any | None = None
        self._subs: dict[str, tuple[str, int | None]] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._seq = 0
        self._unavailable: set[str] = set()

    def start(self) -> None:
        if not sys.platform.startswith("win"):
            logger.warning("QMT bridge requires Windows + a running miniQMT client")
        else:
            try:
                from xtquant import xtdata  # type: ignore

                self._xtdata = xtdata
                logger.info("QMT xtquant market-data bridge started")
            except ImportError:
                logger.warning("xtquant is not installed in this Python runtime")
        self._stop.clear()
        self._thread = threading.Thread(target=self._poll_loop, name="qmt-quote", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        if self._xtdata is not None:
            with self._lock:
                for _, (_, sequence) in self._subs.items():
                    if sequence is not None:
                        try:
                            self._xtdata.unsubscribe_quote(sequence)
                        except Exception:  # noqa: BLE001
                            pass
                self._subs.clear()

    def subscribe(self, subscription: dict[str, Any]) -> None:
        symbol = normalize_symbol(subscription.get("symbol", ""))
        if not symbol:
            return
        code = _to_qmt_code(symbol, str(subscription.get("exchange") or ""))
        sequence: int | None = None
        if self._xtdata is not None:
            try:
                # Subscription populates miniQMT's fast `get_full_tick` cache.
                sequence = int(self._xtdata.subscribe_quote(code, period="tick", callback=None))
            except Exception as error:  # noqa: BLE001
                logger.warning("QMT subscribe %s failed: %s", code, error)
        with self._lock:
            self._subs[symbol] = (code, sequence)
        self._status(symbol, "subscribed", providerCode=code, simulated=False)

    def unsubscribe(self, subscription: dict[str, Any]) -> None:
        symbol = normalize_symbol(subscription.get("symbol", ""))
        with self._lock:
            pair = self._subs.pop(symbol, None)
        if pair and pair[1] is not None and self._xtdata is not None:
            try:
                self._xtdata.unsubscribe_quote(pair[1])
            except Exception:  # noqa: BLE001
                pass

    def _next(self, kind: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._seq += 1
            seq = self._seq
        self._emit(event_payload(kind=kind, sequence=seq, data=data))

    def _status(self, symbol: str, status: str, **extra: Any) -> None:
        self._next("status", {"status": status, "provider": self.id, "symbol": symbol, **extra})

    def _poll_loop(self) -> None:
        while not self._stop.wait(0.8):
            with self._lock:
                subscriptions = dict(self._subs)
            if not subscriptions:
                continue
            if self._xtdata is None:
                reason = "QMT only runs with a local Windows miniQMT + xtquant runtime"
                for symbol in subscriptions:
                    self._status(symbol, "waiting_qmt", message=reason)
                continue
            try:
                raw = self._xtdata.get_full_tick([code for code, _ in subscriptions.values()])
            except Exception as error:  # noqa: BLE001
                logger.warning("QMT get_full_tick failed: %s", error)
                continue
            if not isinstance(raw, dict):
                continue
            for symbol, (code, _) in subscriptions.items():
                tick = raw.get(code)
                if isinstance(tick, dict):
                    self._emit_tick(symbol, code, tick)

    def _emit_tick(self, symbol: str, code: str, tick: dict[str, Any]) -> None:
        last = _number(tick.get("lastPrice") or tick.get("last") or tick.get("last_price"))
        bids = _levels(tick.get("bidPrice"), tick.get("bidVol"))
        asks = _levels(tick.get("askPrice"), tick.get("askVol"))
        timestamp = _time(tick.get("time"))
        if last is not None:
            self._next(
                "quote",
                {
                    "symbol": symbol,
                    "exchange": "CN",
                    "providerCode": code,
                    "lastPrice": last,
                    "bidPrice": bids[0]["price"] if bids else None,
                    "askPrice": asks[0]["price"] if asks else None,
                    "volume": _number(tick.get("volume")),
                    "turnover": _number(tick.get("amount")),
                    "timestamp": timestamp,
                },
            )
        if bids or asks:
            self._next(
                "order_book",
                {"symbol": symbol, "exchange": "CN", "providerCode": code, "bids": bids, "asks": asks, "timestamp": timestamp},
            )


def _to_qmt_code(symbol: str, exchange: str) -> str:
    if "." in symbol:
        return symbol
    market = exchange.upper()
    if market in ("SH", "SSE", "XSHG") or (symbol.isdigit() and symbol.startswith(("5", "6", "9"))):
        return f"{symbol}.SH"
    return f"{symbol}.SZ"


def _levels(prices: Any, volumes: Any) -> list[dict[str, float]]:
    if not isinstance(prices, (list, tuple)):
        return []
    result: list[dict[str, float]] = []
    volume_list = volumes if isinstance(volumes, (list, tuple)) else []
    for index, price in enumerate(prices[:5]):
        normalized_price = _number(price)
        normalized_volume = _number(volume_list[index] if index < len(volume_list) else None)
        if normalized_price is not None and normalized_price > 0 and normalized_volume is not None:
            result.append({"price": normalized_price, "volume": normalized_volume})
    return result


def _number(value: Any) -> float | None:
    try:
        number = float(value)
        return number if number == number and number not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _time(value: Any) -> str:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, (int, float)) and value > 0:
        # xtquant commonly returns milliseconds since epoch.
        seconds = float(value) / 1000 if value > 2_000_000_000 else float(value)
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
