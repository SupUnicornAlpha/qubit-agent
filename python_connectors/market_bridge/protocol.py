from __future__ import annotations

from typing import Any, Protocol


class QuoteProvider(Protocol):
    """Provider that can push normalized market events for a subscription."""

    id: str

    def start(self) -> None: ...

    def stop(self) -> None: ...

    def subscribe(self, subscription: dict[str, Any]) -> None: ...

    def unsubscribe(self, subscription: dict[str, Any]) -> None: ...


def normalize_symbol(raw: str) -> str:
    return str(raw or "").strip().upper()


def event_payload(
    *,
    kind: str,
    sequence: int,
    data: dict[str, Any],
    timestamp: str | None = None,
) -> dict[str, Any]:
    from datetime import datetime, timezone

    ts = timestamp or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "kind": kind,
        "sequence": sequence,
        "timestamp": ts,
        "data": data,
    }
