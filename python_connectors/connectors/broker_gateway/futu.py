from __future__ import annotations

import logging
import threading
from typing import Any

logger = logging.getLogger("broker_gateway.futu")

_lock = threading.Lock()
_ctx: Any | None = None
_host = "127.0.0.1"
_port = 11111


def configure(host: str, port: int) -> None:
    global _host, _port, _ctx
    with _lock:
        if host != _host or port != _port:
            _close_unlocked()
            _host = host
            _port = port


def _close_unlocked() -> None:
    global _ctx
    if _ctx is not None:
        try:
            _ctx.close()
        except Exception:  # noqa: BLE001
            pass
        _ctx = None


def _get_ctx():
    global _ctx
    with _lock:
        if _ctx is None:
            from futu import OpenSecTradeContext  # type: ignore

            _ctx = OpenSecTradeContext(host=_host, port=_port)
        return _ctx


def healthcheck(provider_config: dict[str, Any]) -> dict[str, Any]:
    host = str(provider_config.get("opendHost") or provider_config.get("opend_host") or "127.0.0.1")
    port = int(provider_config.get("opendPort") or provider_config.get("opend_port") or 11111)
    configure(host, port)
    try:
        from futu import OpenSecTradeContext  # type: ignore

        ctx = OpenSecTradeContext(host=host, port=port)
        try:
            ret, data = ctx.get_acc_list()
            ok = ret == 0
            msg = "futu opend ok" if ok else f"futu get_acc_list ret={ret}"
            return {
                "healthy": ok,
                "message": msg,
                "accounts_preview": str(data)[:500] if data is not None else "",
            }
        finally:
            ctx.close()
    except ImportError:
        return {
            "healthy": True,
            "message": "futu-api not installed; simulated healthy. pip install futu-api + start OpenD.",
            "simulated": True,
        }
    except Exception as e:  # noqa: BLE001
        logger.exception("futu health")
        return {"healthy": False, "message": str(e)}


def submit_order(
    ticker: str,
    side: str,
    qty: float,
    limit_price: float,
    order_type: str,
    paper: bool,
    provider_config: dict[str, Any],
) -> dict[str, Any]:
    host = str(provider_config.get("opendHost") or provider_config.get("opend_host") or "127.0.0.1")
    port = int(provider_config.get("opendPort") or provider_config.get("opend_port") or 11111)
    configure(host, port)
    try:
        from futu import OpenSecTradeContext, OrderType, TrdEnv, TrdSide  # type: ignore

        ctx = _get_ctx()
        trd_env = TrdEnv.SIMULATE if paper else TrdEnv.REAL
        trd_side = TrdSide.BUY if side == "buy" else TrdSide.SELL
        ot = OrderType.MARKET if order_type == "market" else OrderType.NORMAL
        ret, data = ctx.place_order(
            price=limit_price if order_type != "market" else 0,
            qty=int(qty),
            code=ticker,
            trd_side=trd_side,
            order_type=ot,
            trd_env=trd_env,
        )
        broker_order_id = str(data) if data is not None else ""
        ok = ret == 0
        return {
            "provider": "futu",
            "brokerOrderId": broker_order_id or f"futu-{ret}",
            "status": "submitted" if ok else "rejected",
            "actualPrice": limit_price,
            "actualQuantity": qty,
            "executionTimeMs": 0,
            "raw": {"ret": ret, "data": str(data)},
            "paper": paper,
        }
    except ImportError:
        return {
            "provider": "futu",
            "brokerOrderId": f"futu-sim-{ticker}",
            "status": "filled",
            "actualPrice": limit_price or 100.0,
            "actualQuantity": qty,
            "executionTimeMs": 50,
            "raw": {"simulated": True, "note": "install futu-api and OpenD for real orders"},
            "paper": True,
        }
    except Exception:  # noqa: BLE001
        logger.exception("futu submit")
        raise


def cancel_order(broker_order_id: str, paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    host = str(provider_config.get("opendHost") or "127.0.0.1")
    port = int(provider_config.get("opendPort") or 11111)
    configure(host, port)
    try:
        from futu import ModifyOrderOp, OpenSecTradeContext, TrdEnv  # type: ignore

        ctx = OpenSecTradeContext(host=host, port=port)
        try:
            trd_env = TrdEnv.SIMULATE if paper else TrdEnv.REAL
            ret, data = ctx.modify_order(
                modify_order_op=ModifyOrderOp.CANCEL,
                order_id=broker_order_id,
                qty=0,
                price=0,
                trd_env=trd_env,
            )
            return {"ok": ret == 0, "raw": {"ret": ret, "data": str(data)}}
        finally:
            ctx.close()
    except ImportError:
        return {"ok": True, "simulated": True}
    except Exception:  # noqa: BLE001
        logger.exception("futu cancel")
        raise


def get_order(broker_order_id: str, paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    try:
        from futu import OpenSecTradeContext, TrdEnv  # type: ignore

        host = str(provider_config.get("opendHost") or "127.0.0.1")
        port = int(provider_config.get("opendPort") or 11111)
        ctx = OpenSecTradeContext(host=host, port=port)
        try:
            trd_env = TrdEnv.SIMULATE if paper else TrdEnv.REAL
            ret, data = ctx.order_list_query(trd_env=trd_env)
            if ret != 0 or data is None:
                return {
                    "brokerOrderId": broker_order_id,
                    "status": "submitted",
                    "actualPrice": 0,
                    "actualQuantity": 0,
                }
            row = data[data["order_id"].astype(str) == str(broker_order_id)]
            if row.empty:
                return {
                    "brokerOrderId": broker_order_id,
                    "status": "submitted",
                    "actualPrice": 0,
                    "actualQuantity": 0,
                }
            r = row.iloc[0]
            return {
                "brokerOrderId": broker_order_id,
                "status": str(r.get("order_status", "submitted")),
                "actualPrice": float(r.get("price", 0) or 0),
                "actualQuantity": float(r.get("qty", 0) or 0),
            }
        finally:
            ctx.close()
    except ImportError:
        return {
            "brokerOrderId": broker_order_id,
            "status": "filled",
            "actualPrice": 100,
            "actualQuantity": 100,
            "simulated": True,
        }


def get_fills(broker_order_id: str, paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    try:
        from futu import OpenSecTradeContext, TrdEnv  # type: ignore

        host = str(provider_config.get("opendHost") or "127.0.0.1")
        port = int(provider_config.get("opendPort") or 11111)
        ctx = OpenSecTradeContext(host=host, port=port)
        try:
            trd_env = TrdEnv.SIMULATE if paper else TrdEnv.REAL
            ret, data = ctx.deal_list_query(trd_env=trd_env)
            if ret != 0 or data is None:
                return {"fills": []}
            rows = data[data["order_id"].astype(str) == str(broker_order_id)]
            fills = []
            for _, r in rows.iterrows():
                fills.append(
                    {
                        "brokerOrderId": broker_order_id,
                        "fillQty": float(r.get("qty", 0) or 0),
                        "fillPrice": float(r.get("price", 0) or 0),
                        "filledAt": str(r.get("create_time", "")),
                    }
                )
            return {"fills": fills}
        finally:
            ctx.close()
    except ImportError:
        return {
            "fills": [
                {
                    "brokerOrderId": broker_order_id,
                    "fillQty": 100,
                    "fillPrice": 100,
                    "filledAt": "",
                    "simulated": True,
                }
            ]
        }


def get_positions(paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    try:
        from futu import OpenSecTradeContext, TrdEnv  # type: ignore

        host = str(provider_config.get("opendHost") or "127.0.0.1")
        port = int(provider_config.get("opendPort") or 11111)
        ctx = OpenSecTradeContext(host=host, port=port)
        try:
            trd_env = TrdEnv.SIMULATE if paper else TrdEnv.REAL
            ret, data = ctx.position_list_query(trd_env=trd_env)
            if ret != 0 or data is None:
                return {"positions": []}
            positions = []
            for _, r in data.iterrows():
                positions.append(
                    {
                        "symbol": str(r.get("code", "")),
                        "qty": float(r.get("qty", 0) or 0),
                        "avgPrice": float(r.get("cost_price", 0) or 0),
                        "market": str(r.get("position_market", "")),
                    }
                )
            return {"positions": positions}
        finally:
            ctx.close()
    except ImportError:
        return {"positions": [], "simulated": True}
