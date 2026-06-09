"""
Alpaca broker adapter (paper / live).

Alpaca 自带 paper trading 服务（独立 base_url），不需要本地撮合：
- paper base_url: https://paper-api.alpaca.markets
- live  base_url: https://api.alpaca.markets

注册：https://alpaca.markets → Dashboard → API Keys → Generate
拿到 APCA-API-KEY-ID + APCA-API-SECRET-KEY，放到 env 或 provider_config_json。

依赖：仅 requests（不依赖 alpaca-py SDK，避免拖入 trade-api 全栈）。

环境变量：
  ALPACA_API_KEY_ID
  ALPACA_API_SECRET
  ALPACA_BASE_URL          可选，覆盖 paper/live 自动选择
  QUBIT_BROKER_PAPER       1/true → 用 paper base_url

provider_config_json 可覆盖（来源：broker_account 表）：
  {"baseUrl": "...", "apiKeyEnv": "ALPACA_API_KEY_ID", "secretEnv": "ALPACA_API_SECRET"}
"""

from __future__ import annotations

import datetime as _dt
import logging
import os
from typing import Any

logger = logging.getLogger("broker_gateway.alpaca")


_DEFAULT_PAPER_BASE = "https://paper-api.alpaca.markets"
_DEFAULT_LIVE_BASE = "https://api.alpaca.markets"
_HTTP_TIMEOUT_SEC = 15.0


def _resolve_base_url(paper: bool, cfg: dict[str, Any]) -> str:
    explicit = cfg.get("baseUrl") or os.environ.get("ALPACA_BASE_URL")
    if explicit:
        return str(explicit).rstrip("/")
    return _DEFAULT_PAPER_BASE if paper else _DEFAULT_LIVE_BASE


def _resolve_credentials(cfg: dict[str, Any]) -> tuple[str, str]:
    key_env = str(cfg.get("apiKeyEnv") or "ALPACA_API_KEY_ID")
    sec_env = str(cfg.get("secretEnv") or "ALPACA_API_SECRET")
    api_key = str(cfg.get("apiKey") or os.environ.get(key_env, ""))
    api_secret = str(cfg.get("apiSecret") or os.environ.get(sec_env, ""))
    return api_key, api_secret


def _headers(cfg: dict[str, Any]) -> dict[str, str]:
    key, secret = _resolve_credentials(cfg)
    return {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
        "Content-Type": "application/json",
    }


def _request(method: str, base_url: str, path: str, cfg: dict[str, Any], **kwargs: Any) -> Any:
    """Thin wrapper around requests with sane error handling.

    返回 (status_code, body_dict | text | None)；调用方判 status_code。
    """
    try:
        import requests  # type: ignore
    except ImportError as e:
        raise RuntimeError("requests package not installed; pip install requests") from e

    url = f"{base_url}{path}"
    timeout = kwargs.pop("timeout", _HTTP_TIMEOUT_SEC)
    resp = requests.request(method, url, headers=_headers(cfg), timeout=timeout, **kwargs)
    try:
        body = resp.json()
    except ValueError:
        body = resp.text
    return resp.status_code, body


def healthcheck(cfg: dict[str, Any]) -> dict[str, Any]:
    """探测 /v2/account；缺 key 时降级为 simulated 不报错（保持 dev 体验）。"""
    api_key, api_secret = _resolve_credentials(cfg)
    if not api_key or not api_secret:
        return {
            "healthy": True,
            "message": "alpaca credentials missing; simulated healthy. set ALPACA_API_KEY_ID + ALPACA_API_SECRET",
            "simulated": True,
        }

    paper = bool(cfg.get("paper", True))
    base_url = _resolve_base_url(paper, cfg)
    try:
        status, body = _request("GET", base_url, "/v2/account", cfg)
        if 200 <= status < 300 and isinstance(body, dict):
            return {
                "healthy": True,
                "message": f"alpaca {('paper' if paper else 'live')} ok",
                "account_status": body.get("status"),
                "buying_power": body.get("buying_power"),
                "cash": body.get("cash"),
            }
        return {"healthy": False, "message": f"alpaca account status={status} body={body}"}
    except Exception as e:  # noqa: BLE001
        logger.exception("alpaca health")
        return {"healthy": False, "message": str(e)}


def _ticker_to_symbol(ticker: str) -> str:
    """Alpaca 的 symbol 就是裸 ticker（'AAPL'）；去掉常见后缀。"""
    if "." in ticker:  # e.g. AAPL.US
        return ticker.split(".", 1)[0].upper()
    return ticker.upper()


def submit_order(
    ticker: str,
    side: str,
    qty: float,
    limit_price: float,
    order_type: str,
    paper: bool,
    cfg: dict[str, Any],
) -> dict[str, Any]:
    base_url = _resolve_base_url(paper, cfg)
    symbol = _ticker_to_symbol(ticker)
    side_norm = "buy" if side.lower() == "buy" else "sell"
    type_norm = "market" if order_type.lower() == "market" else "limit"

    payload: dict[str, Any] = {
        "symbol": symbol,
        "qty": str(int(qty)) if qty == int(qty) else str(qty),
        "side": side_norm,
        "type": type_norm,
        "time_in_force": "day",
    }
    if type_norm == "limit":
        payload["limit_price"] = str(limit_price)

    started = _dt.datetime.now(_dt.timezone.utc)
    try:
        status, body = _request("POST", base_url, "/v2/orders", cfg, json=payload)
    except RuntimeError as e:
        return {
            "brokerOrderId": "",
            "status": "rejected",
            "actualPrice": 0.0,
            "actualQuantity": 0.0,
            "executionTimeMs": 0,
            "raw": {"error": str(e)},
        }

    latency = int((_dt.datetime.now(_dt.timezone.utc) - started).total_seconds() * 1000)
    if not (200 <= status < 300) or not isinstance(body, dict):
        return {
            "brokerOrderId": "",
            "status": "rejected",
            "actualPrice": 0.0,
            "actualQuantity": 0.0,
            "executionTimeMs": latency,
            "raw": {"http_status": status, "body": body},
        }

    return {
        "brokerOrderId": str(body.get("id") or ""),
        "status": _map_status(str(body.get("status") or "new")),
        "actualPrice": float(body.get("filled_avg_price") or limit_price or 0),
        "actualQuantity": float(body.get("filled_qty") or 0),
        "executionTimeMs": latency,
        "raw": body,
    }


def cancel_order(broker_order_id: str, paper: bool, cfg: dict[str, Any]) -> dict[str, Any]:
    base_url = _resolve_base_url(paper, cfg)
    try:
        status, body = _request("DELETE", base_url, f"/v2/orders/{broker_order_id}", cfg)
    except RuntimeError as e:
        return {"ok": False, "message": str(e)}
    return {"ok": 200 <= status < 300, "http_status": status, "body": body}


def get_order(broker_order_id: str, paper: bool, cfg: dict[str, Any]) -> dict[str, Any]:
    base_url = _resolve_base_url(paper, cfg)
    try:
        status, body = _request("GET", base_url, f"/v2/orders/{broker_order_id}", cfg)
    except RuntimeError as e:
        return {
            "brokerOrderId": broker_order_id,
            "status": "submitted",
            "actualPrice": 0.0,
            "actualQuantity": 0.0,
            "executionTimeMs": 0,
            "raw": {"error": str(e)},
        }

    if not (200 <= status < 300) or not isinstance(body, dict):
        return {
            "brokerOrderId": broker_order_id,
            "status": "submitted",
            "actualPrice": 0.0,
            "actualQuantity": 0.0,
            "executionTimeMs": 0,
            "raw": {"http_status": status, "body": body},
        }

    return {
        "brokerOrderId": str(body.get("id") or broker_order_id),
        "status": _map_status(str(body.get("status") or "new")),
        "actualPrice": float(body.get("filled_avg_price") or 0),
        "actualQuantity": float(body.get("filled_qty") or 0),
        "executionTimeMs": 0,
        "raw": body,
    }


def get_fills(broker_order_id: str, paper: bool, cfg: dict[str, Any]) -> dict[str, Any]:
    """Alpaca v2 没有专门的 /v2/orders/{id}/fills；我们直接读 order.filled_qty。"""
    order = get_order(broker_order_id, paper, cfg)
    filled_qty = float(order.get("actualQuantity") or 0)
    if filled_qty <= 0:
        return {"fills": []}
    return {
        "fills": [
            {
                "brokerOrderId": broker_order_id,
                "fillQty": filled_qty,
                "fillPrice": float(order.get("actualPrice") or 0),
                "filledAt": _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        ]
    }


def get_positions(paper: bool, cfg: dict[str, Any]) -> dict[str, Any]:
    base_url = _resolve_base_url(paper, cfg)
    try:
        status, body = _request("GET", base_url, "/v2/positions", cfg)
    except RuntimeError as e:
        return {"positions": [], "error": str(e)}

    if not (200 <= status < 300) or not isinstance(body, list):
        return {"positions": []}

    positions: list[dict[str, Any]] = []
    for row in body:
        if not isinstance(row, dict):
            continue
        positions.append(
            {
                "symbol": str(row.get("symbol") or ""),
                "qty": float(row.get("qty") or 0),
                "avgPrice": float(row.get("avg_entry_price") or 0),
                "market": "US",
            }
        )
    return {"positions": positions}


def _map_status(alpaca_status: str) -> str:
    """Alpaca order status → broker_order_event.status 收敛域。"""
    s = alpaca_status.lower()
    if s in ("filled",):
        return "filled"
    if s in ("canceled", "cancelled", "expired"):
        return "cancelled"
    if s in ("rejected",):
        return "rejected"
    return "submitted"
