from __future__ import annotations

import logging
from typing import Any, Callable

from market_bridge.protocol import event_payload, normalize_symbol

logger = logging.getLogger("market_bridge.supermind")

EmitFn = Callable[[dict[str, Any]], None]


class SupermindQuoteProvider:
    """Tonghuashun SuperMind quote stub.

    SuperMind's public Python surface today is trade-oriented (`tick_trade_api`).
    A dedicated quote feed is environment-specific; this adapter advertises the
    bridge slot and emits status until a real quote SDK path is wired.
    """

    id = "supermind"

    def __init__(self, emit: EmitFn) -> None:
        self._emit = emit
        self._seq = 0
        self._subs: dict[str, dict[str, Any]] = {}

    def start(self) -> None:
        logger.info(
            "supermind quote bridge started (stub). "
            "Wire vendor quote API when available; trading remains on broker_gateway.supermind."
        )

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
                    "status": "stub_waiting_vendor_quote_api",
                    "provider": self.id,
                    "symbol": symbol,
                    "message": (
                        "同花顺行情桥已注册但尚未接入独立行情 SDK；"
                        "交易请继续使用 broker_http_server provider=supermind。"
                    ),
                },
            )
        )

    def unsubscribe(self, subscription: dict[str, Any]) -> None:
        symbol = normalize_symbol(subscription.get("symbol", ""))
        self._subs.pop(symbol, None)
