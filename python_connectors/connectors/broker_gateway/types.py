from __future__ import annotations

from typing import Any, TypedDict


class OrderResult(TypedDict, total=False):
    provider: str
    brokerOrderId: str
    status: str
    actualPrice: float
    actualQuantity: float
    executionTimeMs: int
    raw: dict[str, Any]
    paper: bool


class HealthResult(TypedDict, total=False):
    healthy: bool
    message: str
    simulated: bool
    accounts_preview: str
    accounts: list[str]
