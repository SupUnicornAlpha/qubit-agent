"""QMT / xtquant A-share broker adapter.

This adapter deliberately talks only to a broker-authorised, locally logged-in
miniQMT runtime.  QMT is distributed by participating brokers, so credentials
are never sent to QUBIT; the Windows sidecar receives an account id and the
``userdata_mini`` path only.
"""

from __future__ import annotations

import hashlib
import logging
import threading
from collections.abc import Iterable
from typing import Any

logger = logging.getLogger("broker_gateway.qmt")

_lock = threading.Lock()
_clients: dict[str, tuple[Any, Any]] = {}


def _value(row: Any, *names: str, default: Any = None) -> Any:
    if isinstance(row, dict):
        for name in names:
            if name in row:
                return row[name]
        return default
    for name in names:
        if hasattr(row, name):
            return getattr(row, name)
    return default


def _rows(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    if isinstance(value, Iterable) and not isinstance(value, (str, bytes, dict)):
        return list(value)
    return [value]


def _symbol(ticker: str) -> str:
    raw = ticker.strip().upper()
    if not raw:
        raise ValueError("ticker is required")
    if "." in raw:
        return raw
    return f"{raw}.SH" if raw.startswith(("5", "6", "9")) else f"{raw}.SZ"


def _account_config(config: dict[str, Any]) -> tuple[str, str, int, str]:
    account_id = str(config.get("accountId") or config.get("account_id") or "").strip()
    qmt_path = str(config.get("qmtPath") or config.get("qmt_path") or "").strip()
    if not account_id:
        raise ValueError("qmt providerConfig.accountId is required")
    if not qmt_path:
        raise ValueError("qmt providerConfig.qmtPath is required (miniQMT userdata_mini path)")
    account_type = str(config.get("accountType") or config.get("account_type") or "STOCK").upper()
    session_id = int(config.get("sessionId") or config.get("session_id") or 0)
    if not session_id:
        digest = hashlib.sha1(f"{qmt_path}:{account_id}".encode()).hexdigest()  # nosec B324: cache key only
        session_id = int(digest[:7], 16)
    return account_id, qmt_path, session_id, account_type


def _connection(config: dict[str, Any]) -> tuple[Any, Any]:
    account_id, qmt_path, session_id, account_type = _account_config(config)
    key = f"{qmt_path}|{account_id}|{account_type}|{session_id}"
    with _lock:
        cached = _clients.get(key)
        if cached:
            return cached
        try:
            from xtquant.xttrader import XtQuantTrader  # type: ignore
            from xtquant.xttype import StockAccount  # type: ignore
        except ImportError as error:
            raise RuntimeError(
                "QMT / xtquant SDK 不可用：请在已开通 QMT 的 Windows miniQMT 环境运行 broker_http_server.py。"
            ) from error
        trader = XtQuantTrader(qmt_path, session_id)
        trader.start()
        result = trader.connect()
        if result not in (0, None, True):
            raise RuntimeError(f"QMT connect failed: {result}")
        account = StockAccount(account_id, account_type)
        subscribed = trader.subscribe(account)
        if subscribed not in (0, None, True):
            raise RuntimeError(f"QMT account subscribe failed: {subscribed}")
        _clients[key] = (trader, account)
        return trader, account


def _status(value: Any) -> str:
    raw = str(value or "").lower()
    if any(token in raw for token in ("全部成交", "filled", "all traded")):
        return "filled"
    if any(token in raw for token in ("部分成交", "partial")):
        return "partially_filled"
    if any(token in raw for token in ("已撤", "cancel")):
        return "cancelled"
    if any(token in raw for token in ("废单", "拒绝", "reject", "error")):
        return "rejected"
    return "submitted"


def healthcheck(config: dict[str, Any]) -> dict[str, Any]:
    try:
        trader, account = _connection(config)
        asset = trader.query_stock_asset(account)
        return {
            "healthy": asset is not None,
            "message": "QMT miniQMT account connected" if asset is not None else "QMT asset snapshot unavailable",
            "accountId": _account_config(config)[0],
        }
    except Exception as error:  # noqa: BLE001
        logger.warning("QMT health failed: %s", error)
        return {"healthy": False, "message": str(error)}


def submit_order(
    ticker: str, side: str, qty: float, limit_price: float, order_type: str, paper: bool, config: dict[str, Any]
) -> dict[str, Any]:
    del paper  # miniQMT account selection determines live/simulation; never emulate it here.
    if qty <= 0:
        raise ValueError("quantity must be greater than zero")
    try:
        from xtquant import xtconstant  # type: ignore
    except ImportError as error:
        raise RuntimeError("QMT / xtquant SDK is unavailable") from error
    trader, account = _connection(config)
    if order_type == "market":
        price_type = int(config.get("marketPriceType") or xtconstant.LATEST_PRICE)
        price = float(config.get("marketProtectionPrice") or -1)
    else:
        if limit_price <= 0:
            raise ValueError("limitPrice must be greater than zero for limit orders")
        price_type = int(config.get("limitPriceType") or xtconstant.FIX_PRICE)
        price = float(limit_price)
    side_value = xtconstant.STOCK_BUY if side == "buy" else xtconstant.STOCK_SELL
    order_id = trader.order_stock(
        account,
        _symbol(ticker),
        side_value,
        int(qty),
        price_type,
        price,
        str(config.get("strategyName") or "qubit"),
        str(config.get("orderRemark") or "qubit")[:20],
    )
    if not isinstance(order_id, int) or order_id <= 0:
        raise RuntimeError(f"QMT order rejected: {order_id}")
    return {
        "provider": "qmt",
        "brokerOrderId": str(order_id),
        "status": "submitted",
        "actualPrice": price,
        "actualQuantity": float(qty),
        "executionTimeMs": 0,
        "paper": False,
    }


def cancel_order(order_id: str, paper: bool, config: dict[str, Any]) -> dict[str, Any]:
    del paper
    trader, account = _connection(config)
    result = trader.cancel_order_stock(account, int(order_id))
    return {"ok": result in (0, None, True), "raw": {"result": result}}


def _order_row(row: Any) -> dict[str, Any]:
    return {
        "brokerOrderId": str(_value(row, "order_id", "orderId", "order_sysid", default="")),
        "status": _status(_value(row, "order_status", "status", default="submitted")),
        "actualPrice": float(_value(row, "price", "order_price", default=0) or 0),
        "actualQuantity": float(_value(row, "order_volume", "order_qty", "volume", default=0) or 0),
    }


def get_order(order_id: str, paper: bool, config: dict[str, Any]) -> dict[str, Any]:
    del paper
    trader, account = _connection(config)
    for row in _rows(trader.query_stock_orders(account, False)):
        row_id = str(_value(row, "order_id", "orderId", "order_sysid", default=""))
        if row_id == str(order_id):
            return _order_row(row)
    return {"brokerOrderId": str(order_id), "status": "submitted", "actualPrice": 0, "actualQuantity": 0}


def get_open_orders(paper: bool, config: dict[str, Any]) -> dict[str, Any]:
    del paper
    trader, account = _connection(config)
    return {"orders": [_order_row(row) for row in _rows(trader.query_stock_orders(account, True))]}


def get_fills(order_id: str, paper: bool, config: dict[str, Any]) -> dict[str, Any]:
    del paper
    trader, account = _connection(config)
    fills = []
    for row in _rows(trader.query_stock_trades(account)):
        row_id = str(_value(row, "order_id", "orderId", "order_sysid", default=""))
        if row_id != str(order_id):
            continue
        fills.append({
            "brokerOrderId": str(order_id),
            "fillQty": float(_value(row, "traded_volume", "volume", "business_amount", default=0) or 0),
            "fillPrice": float(_value(row, "traded_price", "price", "business_price", default=0) or 0),
            "filledAt": str(_value(row, "traded_time", "trade_time", "time", default="")),
        })
    return {"fills": fills}


def get_positions(paper: bool, config: dict[str, Any]) -> dict[str, Any]:
    del paper
    trader, account = _connection(config)
    positions = []
    for row in _rows(trader.query_stock_positions(account)):
        symbol = str(_value(row, "stock_code", "symbol", default=""))
        positions.append({
            "symbol": symbol,
            "qty": float(_value(row, "volume", "total_volume", default=0) or 0),
            "avgPrice": float(_value(row, "avg_price", "open_price", "cost_price", default=0) or 0),
            "market": "CN",
        })
    return {"positions": positions}


def get_balances(paper: bool, config: dict[str, Any]) -> dict[str, Any]:
    del paper
    trader, account = _connection(config)
    asset = trader.query_stock_asset(account)
    if asset is None:
        return {"balances": []}
    return {"balances": [{
        "currency": "CNY",
        "cash": float(_value(asset, "cash", "enable_balance", default=0) or 0),
        "available": float(_value(asset, "enable_balance", "cash", default=0) or 0),
        "equity": float(_value(asset, "total_asset", "total_balance", default=0) or 0),
    }]}


def get_margin(paper: bool, config: dict[str, Any]) -> dict[str, Any]:
    del paper
    trader, account = _connection(config)
    asset = trader.query_stock_asset(account)
    if asset is None:
        return {"currency": "CNY"}
    return {
        "currency": "CNY",
        "buyingPower": float(_value(asset, "enable_balance", "cash", default=0) or 0),
        "availableMargin": float(_value(asset, "enable_balance", "cash", default=0) or 0),
    }
