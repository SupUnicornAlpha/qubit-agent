from __future__ import annotations

"""Alpaca stock market-data bridge.

This deliberately uses Alpaca's HTTP market-data endpoints instead of inventing
an order book.  Alpaca's stock API can provide a latest quote and trade; depth
is a separate entitlement/product and is therefore emitted only when a future
provider can supply it.
"""

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from market_bridge.protocol import event_payload, normalize_symbol

logger = logging.getLogger("market_bridge.alpaca")
EmitFn = Callable[[dict[str, Any]], None]


class AlpacaQuoteProvider:
    """Poll authenticated Alpaca latest quote/trade endpoints once per second."""

    id = "alpaca"

    def __init__(self, emit: EmitFn) -> None:
        self._emit = emit
        self._key = os.environ.get("QUBIT_ALPACA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY_ID", "")
        self._secret = os.environ.get("QUBIT_ALPACA_API_SECRET") or os.environ.get("ALPACA_API_SECRET", "")
        self._feed = (os.environ.get("QUBIT_ALPACA_DATA_FEED") or "iex").strip()
        self._subs: dict[str, dict[str, Any]] = {}
        self._seen_trades: dict[str, str] = {}
        self._unavailable: set[tuple[str, str]] = set()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._seq = 0

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._poll_loop, name="alpaca-quote", daemon=True)
        self._thread.start()
        logger.info("alpaca quote bridge started feed=%s", self._feed)

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)

    def subscribe(self, subscription: dict[str, Any]) -> None:
        symbol = self._symbol(subscription.get("symbol", ""))
        if not symbol:
            return
        with self._lock:
            self._subs[symbol] = subscription
        self._emit_status(symbol, "subscribed")

    def unsubscribe(self, subscription: dict[str, Any]) -> None:
        symbol = self._symbol(subscription.get("symbol", ""))
        with self._lock:
            self._subs.pop(symbol, None)
            self._seen_trades.pop(symbol, None)

    @staticmethod
    def _symbol(raw: Any) -> str:
        symbol = normalize_symbol(str(raw)).split(".", 1)[0]
        return symbol.replace("/", "")

    def _next(self, kind: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._seq += 1
            sequence = self._seq
        self._emit(event_payload(kind=kind, sequence=sequence, data=data))

    def _emit_status(self, symbol: str, status: str, **extra: Any) -> None:
        self._next("status", {"status": status, "provider": self.id, "symbol": symbol, **extra})

    def _poll_loop(self) -> None:
        while not self._stop.wait(1.0):
            with self._lock:
                symbols = list(self._subs)
            if not symbols:
                continue
            if not self._key or not self._secret:
                for symbol in symbols:
                    self._emit_status(
                        symbol,
                        "waiting_credentials",
                        message="Set QUBIT_ALPACA_API_KEY_ID and QUBIT_ALPACA_API_SECRET; no quote pushed",
                    )
                continue
            for symbol in symbols:
                self._pull_symbol(symbol)

    def _request(self, path: str, query: dict[str, str]) -> dict[str, Any] | None:
        url = "https://data.alpaca.markets" + path + "?" + urlencode(query)
        request = Request(
            url,
            headers={
                "APCA-API-KEY-ID": self._key,
                "APCA-API-SECRET-KEY": self._secret,
                "Accept": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=6) as response:  # nosec B310: fixed HTTPS origin
                parsed = json.loads(response.read().decode("utf-8"))
                return parsed if isinstance(parsed, dict) else None
        except HTTPError as error:
            logger.warning("alpaca market request %s: HTTP %s", path, error.code)
        except (URLError, TimeoutError, ValueError) as error:
            logger.warning("alpaca market request %s: %s", path, error)
        return None

    def _pull_symbol(self, symbol: str) -> None:
        query = {"feed": self._feed}
        trade_payload = self._request(f"/v2/stocks/{symbol}/trades/latest", query)
        trade = trade_payload.get("trade") if trade_payload else None
        trade = trade if isinstance(trade, dict) else {}
        last_price = _number(trade.get("p"))
        quote_payload = self._request(f"/v2/stocks/{symbol}/quotes/latest", query)
        quote = quote_payload.get("quote") if quote_payload else None
        if isinstance(quote, dict):
            bid = _number(quote.get("bp"))
            ask = _number(quote.get("ap"))
            if bid is not None or ask is not None:
                self._next(
                    "quote",
                    {
                        "symbol": symbol,
                        "exchange": "US",
                        "bidPrice": bid,
                        "askPrice": ask,
                        "bidSize": _number(quote.get("bs")),
                        "askSize": _number(quote.get("as")),
                        "lastPrice": last_price,
                        "timestamp": str(quote.get("t") or _now()),
                        "feed": self._feed,
                    },
                )

        if not trade:
            return
        price = _number(trade.get("p"))
        size = _number(trade.get("s"))
        if price is None or size is None:
            return
        trade_id = str(trade.get("i") or f"{trade.get('t')}:{price}:{size}")
        if self._seen_trades.get(symbol) == trade_id:
            return
        self._seen_trades[symbol] = trade_id
        self._next(
            "trade",
            {
                "id": f"alpaca:{symbol}:{trade_id}",
                "symbol": symbol,
                "exchange": "US",
                "price": price,
                "volume": size,
                "timestamp": str(trade.get("t") or _now()),
                "conditions": trade.get("c"),
                "feed": self._feed,
            },
        )


def _number(value: Any) -> float | None:
    try:
        out = float(value)
        return out if out == out and out not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
