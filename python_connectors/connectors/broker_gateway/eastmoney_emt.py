from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from typing import Any

logger = logging.getLogger("broker_gateway.eastmoney_emt")

_lock = threading.Lock()
_engines: dict[str, tuple[Any, str]] = {}


def _connection_setting(provider_config: dict[str, Any], default_setting: dict[str, Any]) -> dict[str, Any]:
    explicit = provider_config.get("connectionSetting") or provider_config.get("connection_setting")
    env_name = str(provider_config.get("connectionSettingEnv") or "").strip()
    if not explicit and env_name:
        raw = os.environ.get(env_name, "")
        try:
            explicit = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(f"{env_name} must contain a JSON object") from error
    if not isinstance(explicit, dict):
        raise ValueError(
            "eastmoney_emt providerConfig.connectionSetting or connectionSettingEnv is required; "
            "use the keys shown by EmtGateway.default_setting for your EMT SDK version"
        )
    setting = dict(default_setting)
    setting.update(explicit)
    return setting


def _get_engine(provider_config: dict[str, Any]) -> tuple[Any, str]:
    env_name = str(provider_config.get("connectionSettingEnv") or "").strip()
    fingerprint_source = json.dumps(provider_config, ensure_ascii=False, sort_keys=True, default=str)
    if env_name:
        fingerprint_source += os.environ.get(env_name, "")
    fingerprint = hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()
    with _lock:
        cached = _engines.get(fingerprint)
        if cached is not None:
            return cached
        try:
            from vnpy.event import EventEngine  # type: ignore
            from vnpy.trader.engine import MainEngine  # type: ignore
            from vnpy_emt import EmtGateway  # type: ignore
        except ImportError as error:
            raise RuntimeError(
                "东方财富 EMT SDK 不可用：请在 Windows Sidecar 安装 vnpy>=3.4 和 vnpy_emt，"
                "并从东方财富证券申请 EMT 柜台权限。"
            ) from error
        event_engine = EventEngine()
        engine = MainEngine(event_engine)
        gateway = engine.add_gateway(EmtGateway)
        gateway_name = str(getattr(gateway, "gateway_name", getattr(EmtGateway, "default_name", "EMT")))
        defaults = getattr(gateway, "default_setting", getattr(EmtGateway, "default_setting", {}))
        setting = _connection_setting(provider_config, defaults if isinstance(defaults, dict) else {})
        engine.connect(setting, gateway_name)
        wait_seconds = max(0.0, min(30.0, float(provider_config.get("connectWaitSeconds") or 2.0)))
        if wait_seconds:
            time.sleep(wait_seconds)
        resolved = (engine, gateway_name)
        _engines[fingerprint] = resolved
        return resolved


def _exchange_for_symbol(symbol: str) -> tuple[str, Any]:
    try:
        from vnpy.trader.constant import Exchange  # type: ignore
    except ImportError as error:
        raise RuntimeError("vnpy is required for eastmoney_emt") from error
    raw = symbol.strip().upper()
    if "." in raw:
        code, suffix = raw.rsplit(".", 1)
    else:
        code = raw
        suffix = "SH" if raw.startswith(("5", "6", "9")) else "SZ"
    exchange_map = {
        "SH": Exchange.SSE,
        "SSE": Exchange.SSE,
        "SS": Exchange.SSE,
        "SZ": Exchange.SZSE,
        "SZSE": Exchange.SZSE,
        "BJ": Exchange.BSE,
        "BSE": Exchange.BSE,
    }
    exchange = exchange_map.get(suffix)
    if exchange is None:
        raise ValueError(f"unsupported A-share symbol suffix: {symbol}")
    return code, exchange


def _status(value: Any) -> str:
    raw = str(getattr(value, "value", value) or "").lower()
    if any(token in raw for token in ("全部成交", "filled", "all traded")):
        return "filled"
    if any(token in raw for token in ("部分成交", "partial")):
        return "partially_filled"
    if any(token in raw for token in ("已撤销", "cancel")):
        return "cancelled"
    if any(token in raw for token in ("拒单", "reject")):
        return "rejected"
    return "submitted"


def healthcheck(provider_config: dict[str, Any]) -> dict[str, Any]:
    try:
        engine, gateway_name = _get_engine(provider_config)
        accounts = engine.get_all_accounts()
        account_ids = [
            account_id
            for account in accounts
            if (account_id := str(getattr(account, "accountid", "")).strip())
        ]
        return {
            "healthy": bool(account_ids),
            "message": (
                "eastmoney EMT gateway connected"
                if account_ids
                else "eastmoney EMT gateway has no account snapshot"
            ),
            "gateway": gateway_name,
            "accounts": account_ids,
        }
    except Exception as error:  # noqa: BLE001
        logger.warning("EMT health failed: %s", error)
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
    from vnpy.trader.constant import Direction, Offset, OrderType  # type: ignore
    from vnpy.trader.object import OrderRequest  # type: ignore

    engine, gateway_name = _get_engine(provider_config)
    symbol, exchange = _exchange_for_symbol(ticker)
    if qty <= 0:
        raise ValueError("quantity must be greater than zero")
    if order_type != "market" and limit_price <= 0:
        raise ValueError("limitPrice must be greater than zero for limit orders")
    request = OrderRequest(
        symbol=symbol,
        exchange=exchange,
        direction=Direction.LONG if side == "buy" else Direction.SHORT,
        type=OrderType.MARKET if order_type == "market" else OrderType.LIMIT,
        volume=float(qty),
        price=float(limit_price or 0),
        offset=Offset.NONE,
    )
    vt_orderid = str(engine.send_order(request, gateway_name) or "")
    if not vt_orderid:
        raise RuntimeError("EMT send_order returned an empty order id")
    return {
        "provider": "eastmoney_emt",
        "brokerOrderId": vt_orderid,
        "status": "submitted",
        "actualPrice": float(limit_price or 0),
        "actualQuantity": float(qty),
        "executionTimeMs": 0,
        "raw": {"gateway": gateway_name},
        "paper": False,
    }


def cancel_order(broker_order_id: str, paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    del paper
    engine, gateway_name = _get_engine(provider_config)
    order = engine.get_order(broker_order_id)
    if order is None:
        return {"ok": False, "message": "order not found"}
    engine.cancel_order(order.create_cancel_request(), getattr(order, "gateway_name", gateway_name))
    return {"ok": True}


def get_order(broker_order_id: str, paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    del paper
    engine, _ = _get_engine(provider_config)
    order = engine.get_order(broker_order_id)
    if order is None:
        return {
            "brokerOrderId": broker_order_id,
            "status": "submitted",
            "actualPrice": 0,
            "actualQuantity": 0,
        }
    return {
        "brokerOrderId": broker_order_id,
        "status": _status(getattr(order, "status", "")),
        "actualPrice": float(getattr(order, "price", 0) or 0),
        "actualQuantity": float(getattr(order, "volume", 0) or 0),
    }


def get_fills(broker_order_id: str, paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    del paper
    engine, _ = _get_engine(provider_config)
    fills = []
    for trade in engine.get_all_trades():
        if str(getattr(trade, "vt_orderid", "")) != str(broker_order_id):
            continue
        fills.append(
            {
                "brokerOrderId": broker_order_id,
                "fillQty": float(getattr(trade, "volume", 0) or 0),
                "fillPrice": float(getattr(trade, "price", 0) or 0),
                "filledAt": str(getattr(trade, "datetime", "") or getattr(trade, "time", "")),
            }
        )
    return {"fills": fills}


def get_positions(paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    del paper
    engine, _ = _get_engine(provider_config)
    positions = []
    for position in engine.get_all_positions():
        exchange = getattr(getattr(position, "exchange", None), "value", "")
        symbol = str(getattr(position, "symbol", ""))
        positions.append(
            {
                "symbol": f"{symbol}.{exchange}" if exchange else symbol,
                "qty": float(getattr(position, "volume", 0) or 0),
                "avgPrice": float(getattr(position, "price", 0) or 0),
                "market": "CN",
            }
        )
    return {"positions": positions}
