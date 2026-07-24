from __future__ import annotations

import logging
import threading
from collections.abc import Iterable
from typing import Any

logger = logging.getLogger("broker_gateway.supermind")

_lock = threading.Lock()
_api: Any | None = None
_account_id = ""


def _load_trade_api_class() -> Any:
    try:
        from tick_trade_api.api import TradeAPI  # type: ignore

        return TradeAPI
    except ImportError:
        try:
            from tick_trade_api import TradeAPI  # type: ignore

            return TradeAPI
        except ImportError as error:
            raise RuntimeError(
                "同花顺 SuperMind SDK 不可用：请在已开通交易权限且登录客户端的 "
                "SuperMind Python 环境中运行 broker_http_server.py。"
            ) from error


def _resolve_account_id(provider_config: dict[str, Any]) -> str:
    account_id = str(
        provider_config.get("accountId")
        or provider_config.get("account_id")
        or provider_config.get("fundAccount")
        or ""
    ).strip()
    if not account_id:
        raise ValueError("supermind providerConfig.accountId is required")
    return account_id


def _get_api(provider_config: dict[str, Any]) -> Any:
    global _api, _account_id
    account_id = _resolve_account_id(provider_config)
    with _lock:
        if _api is None or _account_id != account_id:
            trade_api_class = _load_trade_api_class()
            _api = trade_api_class(account_id=account_id)
            _account_id = account_id
        return _api


def _as_rows(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, dict):
        for key in ("data", "orders", "trades", "positions"):
            nested = value.get(key)
            if isinstance(nested, (list, tuple)):
                return list(nested)
        return [value]
    if isinstance(value, (list, tuple)):
        return list(value)
    if isinstance(value, Iterable) and not isinstance(value, (str, bytes)):
        try:
            return list(value)
        except TypeError:
            pass
    return [value]


def _field(row: Any, *names: str, default: Any = None) -> Any:
    if isinstance(row, dict):
        for name in names:
            if name in row:
                return row[name]
        return default
    for name in names:
        if hasattr(row, name):
            return getattr(row, name)
    return default


def _status(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if any(token in raw for token in ("已成", "全部成交", "filled", "success")):
        return "filled"
    if any(token in raw for token in ("部分成交", "部成", "partial")):
        return "partially_filled"
    if any(token in raw for token in ("已撤", "cancel")):
        return "cancelled"
    if any(token in raw for token in ("废单", "拒绝", "失败", "reject", "error")):
        return "rejected"
    return "submitted"


def healthcheck(provider_config: dict[str, Any]) -> dict[str, Any]:
    try:
        api = _get_api(provider_config)
        portfolio = getattr(api, "portfolio", None)
        return {
            "healthy": portfolio is not None,
            "message": "supermind TradeAPI connected" if portfolio is not None else "TradeAPI portfolio unavailable",
            "accountId": _resolve_account_id(provider_config),
        }
    except Exception as error:  # noqa: BLE001
        logger.warning("supermind health failed: %s", error)
        return {"healthy": False, "message": str(error)}


def submit_order(
    ticker: str,
    side: str,
    qty: float,
    limit_price: float,
    order_type: str,
    paper: bool,
    provider_config: dict[str, Any],
) -> dict[str, Any]:
    del paper
    api = _get_api(provider_config)
    signed_qty = int(abs(qty)) if side == "buy" else -int(abs(qty))
    if signed_qty == 0:
        raise ValueError("quantity must be greater than zero")
    kwargs: dict[str, Any] = {"symbol": ticker, "amount": signed_qty}
    if order_type == "market":
        market_price_type = provider_config.get("marketPriceType")
        if market_price_type is not None:
            kwargs.update({"price": 0, "pricetype": int(market_price_type)})
    else:
        if limit_price <= 0:
            raise ValueError("limitPrice must be greater than zero for limit orders")
        kwargs["price"] = float(limit_price)
        limit_price_type = provider_config.get("limitPriceType")
        if limit_price_type is not None:
            kwargs["pricetype"] = int(limit_price_type)
    result = api.order(**kwargs)
    broker_order_id = str(
        _field(result, "order_id", "orderId", "entrust_no", "entrustNo", default=result) or ""
    )
    if not broker_order_id:
        raise RuntimeError(f"SuperMind order did not return an order id: {result!r}")
    return {
        "provider": "supermind",
        "brokerOrderId": broker_order_id,
        "status": _status(_field(result, "status", "order_status", default="submitted")),
        "actualPrice": float(limit_price or 0),
        "actualQuantity": float(abs(qty)),
        "executionTimeMs": 0,
        "raw": {"result": str(result)},
        "paper": False,
    }


def cancel_order(broker_order_id: str, paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    del paper
    api = _get_api(provider_config)
    result = api.cancel_order(broker_order_id)
    return {"ok": result is not False, "raw": {"result": str(result)}}


def get_order(broker_order_id: str, paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    del paper
    api = _get_api(provider_config)
    getter = getattr(api, "get_orders", None)
    if not callable(getter):
        raise RuntimeError("SuperMind TradeAPI.get_orders is unavailable")
    for row in _as_rows(getter(order_id=broker_order_id)):
        row_id = str(_field(row, "order_id", "orderId", "entrust_no", "entrustNo", default=""))
        if row_id and row_id != str(broker_order_id):
            continue
        return {
            "brokerOrderId": broker_order_id,
            "status": _status(_field(row, "status", "order_status", "entrust_status")),
            "actualPrice": float(_field(row, "price", "order_price", default=0) or 0),
            "actualQuantity": float(_field(row, "amount", "quantity", "order_qty", default=0) or 0),
        }
    return {
        "brokerOrderId": broker_order_id,
        "status": "submitted",
        "actualPrice": 0,
        "actualQuantity": 0,
    }


def get_fills(broker_order_id: str, paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    del paper
    api = _get_api(provider_config)
    getter = getattr(api, "get_tradelogs", None)
    if not callable(getter):
        raise RuntimeError("SuperMind TradeAPI.get_tradelogs is unavailable")
    fills = []
    for row in _as_rows(getter()):
        row_id = str(_field(row, "order_id", "orderId", "entrust_no", "entrustNo", default=""))
        if row_id != str(broker_order_id):
            continue
        fills.append(
            {
                "brokerOrderId": broker_order_id,
                "fillQty": float(_field(row, "amount", "quantity", "business_amount", default=0) or 0),
                "fillPrice": float(_field(row, "price", "business_price", default=0) or 0),
                "filledAt": str(_field(row, "time", "business_time", "datetime", default="")),
            }
        )
    return {"fills": fills}


def get_positions(paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    del paper
    api = _get_api(provider_config)
    raw_positions = getattr(api, "positions", {})
    rows = raw_positions.values() if isinstance(raw_positions, dict) else _as_rows(raw_positions)
    positions = []
    for row in rows:
        symbol = str(_field(row, "symbol", "security", "stock_code", default=""))
        if not symbol:
            continue
        positions.append(
            {
                "symbol": symbol,
                "qty": float(_field(row, "amount", "quantity", "total_amount", default=0) or 0),
                "avgPrice": float(_field(row, "avg_cost", "cost_basis", "cost_price", default=0) or 0),
                "market": "CN",
            }
        )
    return {"positions": positions}
