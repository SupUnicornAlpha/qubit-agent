from __future__ import annotations

import logging
from typing import Any, Callable

from market_bridge.protocol import event_payload, normalize_symbol

logger = logging.getLogger("market_bridge.ib")

EmitFn = Callable[[dict[str, Any]], None]


class IbQuoteProvider:
    """IB market-data stub — slot for ib_insync reqMktData when wired.

    Prefer pointing `QUBIT_IB_MARKET_WS_URL` at a dedicated IB quote bridge once
    implemented; until then this emits status-only events.
    """

    id = "ib"

    def __init__(self, emit: EmitFn) -> None:
        self._emit = emit
        self._seq = 0
        self._subs: dict[str, dict[str, Any]] = {}

    def start(self) -> None:
        logger.info("ib quote bridge started (stub)")

    def stop(self) -> None:
        self._subs.clear()

    def subscribe(self, subscription: dict[str, Any]) -> None:
        symbol = normalize_symbol(subscription.get("symbol", ""))
        if not symbol:
            return
        self._subs[symbol] = subscription
        self._seq += 1
        self._emit(
            event_payload(
                kind="status",
                sequence=self._seq,
                data={
                    "status": "stub_waiting_ib_insync",
                    "provider": self.id,
                    "symbol": symbol,
                    "message": "IB quote bridge slot ready; implement reqMktData push next.",
                },
            )
        )

    def unsubscribe(self, subscription: dict[str, Any]) -> None:
        symbol = normalize_symbol(subscription.get("symbol", ""))
        self._subs.pop(symbol, None)
