"""CCXT broker adapter (optional dependency: pip install ccxt)."""

from __future__ import annotations

import os
from typing import Any


def _exchange(cfg: dict[str, Any]):
    try:
        import ccxt  # type: ignore
    except ImportError as e:
        raise RuntimeError("ccxt package not installed") from e

    exchange_id = str(cfg.get("exchangeId") or os.environ.get("QUBIT_CCXT_EXCHANGE", "binance")).lower()
    klass = getattr(ccxt, exchange_id, None)
    if klass is None:
        raise ValueError(f"unknown ccxt exchange: {exchange_id}")

    api_key = os.environ.get("QUBIT_CCXT_API_KEY", "")
    secret = os.environ.get("QUBIT_CCXT_SECRET", "")
    sandbox = bool(cfg.get("sandbox", os.environ.get("QUBIT_CCXT_SANDBOX", "1") in ("1", "true", "yes")))
    default_type = str(cfg.get("defaultType") or "spot")

    ex = klass(
        {
            "apiKey": api_key,
            "secret": secret,
            "enableRateLimit": True,
            "options": {"defaultType": default_type},
        }
    )
    if sandbox and hasattr(ex, "set_sandbox_mode"):
        ex.set_sandbox_mode(True)
    return ex


def healthcheck(cfg: dict[str, Any]) -> dict[str, Any]:
    try:
        ex = _exchange(cfg)
        ex.load_markets()
        return {"healthy": True, "message": f"ccxt {ex.id} ok"}
    except Exception as e:
        return {"healthy": False, "message": str(e)}


def submit_order(
    ticker: str,
    side: str,
    qty: float,
    limit_price: float,
    order_type: str,
    paper: bool,
    cfg: dict[str, Any],
) -> dict[str, Any]:
    if paper:
        return {
            "brokerOrderId": f"ccxt-paper-{ticker}-{side}",
            "status": "filled",
            "actualPrice": limit_price or 1.0,
            "actualQuantity": qty,
            "executionTimeMs": 50,
        }

    ex = _exchange(cfg)
    symbol = ticker.replace(".", "/").replace("-", "/")
    if "/" not in symbol and symbol.endswith("USDT"):
        symbol = symbol.replace("USDT", "/USDT")

    params: dict[str, Any] = {}
    if order_type == "market":
        order = ex.create_order(symbol, "market", side, qty, None, params)
    else:
        order = ex.create_order(symbol, "limit", side, qty, limit_price, params)

    filled = float(order.get("filled") or qty)
    price = float(order.get("average") or order.get("price") or limit_price or 0)
    status = str(order.get("status") or "submitted")
    mapped = "filled" if status in ("closed", "filled") else "submitted"
    return {
        "brokerOrderId": str(order.get("id") or order.get("clientOrderId") or ""),
        "status": mapped,
        "actualPrice": price,
        "actualQuantity": filled,
        "executionTimeMs": 0,
        "raw": order,
    }


def cancel_order(broker_order_id: str, paper: bool, cfg: dict[str, Any]) -> dict[str, Any]:
    if paper:
        return {"ok": True}
    ex = _exchange(cfg)
    ex.cancel_order(broker_order_id)
    return {"ok": True}


def get_order(broker_order_id: str, paper: bool, cfg: dict[str, Any]) -> dict[str, Any]:
    if paper:
        return {
            "brokerOrderId": broker_order_id,
            "status": "filled",
            "actualPrice": 1.0,
            "actualQuantity": 1.0,
            "executionTimeMs": 0,
        }
    ex = _exchange(cfg)
    order = ex.fetch_order(broker_order_id)
    status = str(order.get("status") or "submitted")
    mapped = "filled" if status in ("closed", "filled") else "submitted"
    return {
        "brokerOrderId": broker_order_id,
        "status": mapped,
        "actualPrice": float(order.get("average") or order.get("price") or 0),
        "actualQuantity": float(order.get("filled") or 0),
        "executionTimeMs": 0,
    }


def get_fills(broker_order_id: str, paper: bool, cfg: dict[str, Any]) -> dict[str, Any]:
    order = get_order(broker_order_id, paper, cfg)
    return {
        "fills": [
            {
                "brokerOrderId": broker_order_id,
                "fillQty": order["actualQuantity"],
                "fillPrice": order["actualPrice"],
                "filledAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            }
        ]
    }


def get_positions(paper: bool, cfg: dict[str, Any]) -> dict[str, Any]:
    if paper:
        return {"positions": []}
    ex = _exchange(cfg)
    bal = ex.fetch_balance()
    positions = []
    total = bal.get("total") or {}
    for sym, qty in total.items():
        if float(qty or 0) > 0:
            positions.append({"symbol": sym, "qty": float(qty), "avgPrice": 0.0, "market": "CRYPTO"})
    return {"positions": positions}
