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
    """OpenQuoteContext → normalized quote/trade events.

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
            self._subscribe_sdk(symbol)
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

    def _subscribe_sdk(self, symbol: str) -> None:
        assert self._ctx is not None
        try:
            from futu import RET_OK, SubType  # type: ignore

            code = self._to_futu_code(symbol)
            ret, err = self._ctx.subscribe([code], [SubType.QUOTE, SubType.TICKER])
            if ret != RET_OK:
                logger.warning("futu subscribe %s failed: %s", code, err)
        except Exception:  # noqa: BLE001
            logger.exception("futu subscribe error for %s", symbol)

    @staticmethod
    def _to_futu_code(symbol: str) -> str:
        s = symbol.upper().replace(".SH", "").replace(".SZ", "").replace(".HK", "")
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
            for symbol, _ in subs:
                self._pull_quote(ctx, symbol)

    def _pull_quote(self, ctx: Any, symbol: str) -> None:
        try:
            from futu import RET_OK  # type: ignore

            code = self._to_futu_code(symbol)
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
                    "providerCode": code,
                },
            )
        except Exception:  # noqa: BLE001
            logger.exception("futu get_stock_quote %s", symbol)
            time.sleep(0.5)
