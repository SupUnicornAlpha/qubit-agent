from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable

from market_bridge.protocol import event_payload, normalize_symbol

logger = logging.getLogger("market_bridge.futu_quote")

EmitFn = Callable[[dict[str, Any]], None]


class FutuQuoteProvider:
    """OpenQuoteContext → normalized quote, order-book and trade events.

    Requires `pip install futu-api` and a running OpenD with quote entitlement.
    Without the SDK, emits status-only simulated heartbeats (never fake prices).
    """

    id = "futu"

    def __init__(
        self,
        emit: EmitFn,
        *,
        host: str = "127.0.0.1",
        port: int = 11111,
    ) -> None:
        self._emit = emit
        self._host = host
        self._port = port
        self._lock = threading.Lock()
        self._ctx: Any | None = None
        self._subs: dict[str, dict[str, Any]] = {}
        self._seq = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._simulated = False
        self._seen_trade_ids: dict[str, set[str]] = {}
        self._unavailable_channels: set[tuple[str, str]] = set()

    def start(self) -> None:
        try:
            from futu import OpenQuoteContext  # type: ignore

            self._ctx = OpenQuoteContext(host=self._host, port=self._port)
            self._simulated = False
            logger.info("futu OpenQuoteContext connected %s:%s", self._host, self._port)
        except ImportError:
            self._ctx = None
            self._simulated = True
            logger.warning(
                "futu-api not installed; bridge runs in status-only mode "
                "(no synthetic prices). pip install futu-api + start OpenD."
            )
        except Exception as error:  # noqa: BLE001
            self._ctx = None
            self._simulated = True
            logger.exception("futu OpenQuote connect failed: %s", error)
        self._stop.clear()
        self._thread = threading.Thread(target=self._poll_loop, name="futu-quote", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        with self._lock:
            if self._ctx is not None:
                try:
                    self._ctx.close()
                except Exception:  # noqa: BLE001
                    pass
                self._ctx = None

    def subscribe(self, subscription: dict[str, Any]) -> None:
        symbol = normalize_symbol(subscription.get("symbol", ""))
        if not symbol:
            return
        with self._lock:
            self._subs[symbol] = subscription
        if self._ctx is not None:
            self._subscribe_sdk(symbol, subscription)
        self._next_emit(
            "status",
            {
                "status": "subscribed",
                "provider": self.id,
                "symbol": symbol,
                "simulated": self._simulated,
            },
        )

    def unsubscribe(self, subscription: dict[str, Any]) -> None:
        symbol = normalize_symbol(subscription.get("symbol", ""))
        with self._lock:
            self._subs.pop(symbol, None)

    def _subscribe_sdk(self, symbol: str, subscription: dict[str, Any]) -> None:
        assert self._ctx is not None
        try:
            from futu import RET_OK, SubType  # type: ignore

            code = self._to_futu_code(symbol, str(subscription.get("exchange") or ""))
            ret, err = self._ctx.subscribe(
                [code],
                [SubType.QUOTE, SubType.ORDER_BOOK, SubType.TICKER],
                subscribe_push=False,
            )
            if ret != RET_OK:
                logger.warning("futu subscribe %s failed: %s", code, err)
        except Exception:  # noqa: BLE001
            logger.exception("futu subscribe error for %s", symbol)

    @staticmethod
    def _to_futu_code(symbol: str, exchange: str = "") -> str:
        s = symbol.upper().replace(".SH", "").replace(".SZ", "").replace(".HK", "")
        market = str(exchange or "").strip().upper()
        if market in ("HK", "HKEX") and s.isdigit():
            return f"HK.{s.zfill(5)}"
        if market in ("US", "NASDAQ", "NYSE", "AMEX", "OPRA"):
            return f"US.{s}"
        if s.endswith("HK") and s[:-2].isdigit():
            return f"HK.{s[:-2].zfill(5)}"
        if s.isdigit() and len(s) == 6:
            if s.startswith(("5", "6", "9")):
                return f"SH.{s}"
            return f"SZ.{s}"
        if "." in symbol:
            return symbol
        return f"US.{s}"

    def _next_emit(self, kind: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._seq += 1
            seq = self._seq
        self._emit(event_payload(kind=kind, sequence=seq, data=data))

    def _poll_loop(self) -> None:
        while not self._stop.wait(1.0):
            with self._lock:
                subs = list(self._subs.items())
                ctx = self._ctx
            if not subs:
                continue
            if ctx is None:
                # Status-only: never invent lastPrice.
                for symbol, _ in subs:
                    self._next_emit(
                        "status",
                        {
                            "status": "waiting_opend",
                            "provider": self.id,
                            "symbol": symbol,
                            "message": "futu-api/OpenD unavailable; no quote pushed",
                        },
                    )
                continue
            for symbol, subscription in subs:
                self._pull_quote(ctx, symbol, subscription)
                self._pull_order_book(ctx, symbol, subscription)
                self._pull_trades(ctx, symbol, subscription)

    def _pull_quote(self, ctx: Any, symbol: str, subscription: dict[str, Any]) -> None:
        try:
            from futu import RET_OK  # type: ignore

            code = self._to_futu_code(symbol, str(subscription.get("exchange") or ""))
            ret, data = ctx.get_stock_quote([code])
            if ret != RET_OK or data is None or getattr(data, "empty", True):
                return
            row = data.iloc[0]
            last = float(row.get("last_price") or row.get("cur_price") or 0)
            if last <= 0:
                return
            ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            self._next_emit(
                "quote",
                {
                    "lastPrice": last,
                    "bidPrice": float(row.get("bid_price") or 0) or None,
                    "askPrice": float(row.get("ask_price") or 0) or None,
                    "volume": float(row.get("volume") or 0),
                    "turnover": float(row.get("turnover") or 0),
                    "timestamp": ts,
                    "symbol": symbol,
                    "exchange": str(subscription.get("exchange") or "").upper(),
                    "providerCode": code,
                },
            )
        except Exception:  # noqa: BLE001
            logger.exception("futu get_stock_quote %s", symbol)
            time.sleep(0.5)

    def _pull_order_book(self, ctx: Any, symbol: str, subscription: dict[str, Any]) -> None:
        """Emit depth only when the OpenD account has the needed entitlement."""
        try:
            from futu import RET_OK  # type: ignore

            code = self._to_futu_code(symbol, str(subscription.get("exchange") or ""))
            ret, data = ctx.get_order_book(code, num=5)
            if ret != RET_OK or not isinstance(data, dict):
                self._mark_unavailable(symbol, "order_book")
                return
            bids = self._levels(data.get("Bid"))
            asks = self._levels(data.get("Ask"))
            if not bids and not asks:
                return
            self._unavailable_channels.discard((symbol, "order_book"))
            self._next_emit(
                "order_book",
                {
                    "symbol": symbol,
                    "exchange": str(subscription.get("exchange") or "").upper(),
                    "providerCode": code,
                    "bids": bids,
                    "asks": asks,
                    "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                },
            )
        except Exception:  # noqa: BLE001
            self._mark_unavailable(symbol, "order_book")

    def _pull_trades(self, ctx: Any, symbol: str, subscription: dict[str, Any]) -> None:
        """Emit only unseen Futu ticker rows, preserving OpenD sequence IDs."""
        try:
            from futu import RET_OK  # type: ignore

            code = self._to_futu_code(symbol, str(subscription.get("exchange") or ""))
            ret, data = ctx.get_rt_ticker(code, num=20)
            if ret != RET_OK or data is None or getattr(data, "empty", True):
                self._mark_unavailable(symbol, "trade")
                return
            rows = [row.to_dict() for _, row in data.iterrows()]
            rows.sort(key=lambda row: _finite(row.get("sequence")) or 0)
            seen = self._seen_trade_ids.setdefault(symbol, set())
            emitted = 0
            for row in rows:
                price = _finite(row.get("price"))
                volume = _finite(row.get("volume"))
                if price is None or price <= 0 or volume is None or volume < 0:
                    continue
                sequence = row.get("sequence")
                trade_id = f"{code}:{sequence}" if sequence not in (None, "") else (
                    f"{code}:{row.get('time')}:{price}:{volume}:{row.get('turnover')}"
                )
                if trade_id in seen:
                    continue
                seen.add(trade_id)
                emitted += 1
                direction = str(row.get("ticker_direction") or "").lower()
                self._next_emit(
                    "trade",
                    {
                        "id": trade_id,
                        "sequence": sequence,
                        "symbol": symbol,
                        "exchange": str(subscription.get("exchange") or "").upper(),
                        "providerCode": code,
                        "price": price,
                        "volume": volume,
                        "turnover": _finite(row.get("turnover")),
                        "tickerDirection": direction,
                        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "brokerTime": str(row.get("time") or ""),
                    },
                )
            if emitted or rows:
                self._unavailable_channels.discard((symbol, "trade"))
            if len(seen) > 500:
                # `get_rt_ticker` is a rolling window; bounded dedupe protects
                # long-running bridge processes without synthesizing trades.
                self._seen_trade_ids[symbol] = set(sorted(seen)[-250:])
        except Exception:  # noqa: BLE001
            self._mark_unavailable(symbol, "trade")

    @staticmethod
    def _levels(raw: Any) -> list[dict[str, float | int]]:
        if not isinstance(raw, (list, tuple)):
            return []
        levels: list[dict[str, float | int]] = []
        for entry in raw[:5]:
            if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                continue
            price = _finite(entry[0])
            volume = _finite(entry[1])
            if price is None or price <= 0 or volume is None or volume < 0:
                continue
            level: dict[str, float | int] = {"price": price, "volume": volume}
            order_count = _finite(entry[2]) if len(entry) > 2 else None
            if order_count is not None:
                level["orderCount"] = int(order_count)
            levels.append(level)
        return levels

    def _mark_unavailable(self, symbol: str, channel: str) -> None:
        key = (symbol, channel)
        if key in self._unavailable_channels:
            return
        self._unavailable_channels.add(key)
        self._next_emit(
            "status",
            {
                "status": "capability_unavailable",
                "provider": self.id,
                "symbol": symbol,
                "channel": channel,
                "message": "OpenD did not provide this subscribed market-data capability",
            },
        )


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
        return number if number == number and number not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None
