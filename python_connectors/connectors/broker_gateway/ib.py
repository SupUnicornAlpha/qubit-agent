from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger("broker_gateway.ib")


def _ib_connect_params(provider_config: dict[str, Any]) -> tuple[str, int, int]:
    host = str(provider_config.get("host") or os.environ.get("QUBIT_IB_HOST", "127.0.0.1"))
    port = int(provider_config.get("port") or os.environ.get("QUBIT_IB_PORT", "7497"))
    client_id = int(provider_config.get("clientId") or os.environ.get("QUBIT_IB_CLIENT_ID", "1"))
    return host, port, client_id


def healthcheck(provider_config: dict[str, Any]) -> dict[str, Any]:
    try:
        from ib_insync import IB  # type: ignore

        host, port, client_id = _ib_connect_params(provider_config)
        ib = IB()
        ib.connect(host, port, clientId=client_id, timeout=5)
        try:
            return {"healthy": True, "message": "ib connected", "accounts": [a for a in ib.managedAccounts()]}
        finally:
            ib.disconnect()
    except ImportError:
        return {
            "healthy": True,
            "message": "ib_insync not installed; simulated healthy.",
            "simulated": True,
        }
    except Exception as e:  # noqa: BLE001
        logger.exception("ib health")
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
    try:
        from ib_insync import IB, LimitOrder, MarketOrder, Stock  # type: ignore

        host, port, client_id = _ib_connect_params(provider_config)
        ib = IB()
        ib.connect(host, port, clientId=client_id, timeout=10)
        try:
            contract = Stock(ticker, "SMART", "USD")
            ib.qualifyContracts(contract)
            if order_type == "market":
                order = MarketOrder("BUY" if side == "buy" else "SELL", int(qty))
            else:
                order = LimitOrder("BUY" if side == "buy" else "SELL", int(qty), limit_price)
            trade = ib.placeOrder(contract, order)
            ib.sleep(1)
            return {
                "provider": "ib",
                "brokerOrderId": str(trade.order.orderId),
                "status": "submitted",
                "actualPrice": limit_price,
                "actualQuantity": qty,
                "executionTimeMs": 100,
                "raw": {"paper": paper, "log": trade.log},
            }
        finally:
            ib.disconnect()
    except ImportError:
        return {
            "provider": "ib",
            "brokerOrderId": f"ib-sim-{ticker}",
            "status": "filled",
            "actualPrice": limit_price or 100.0,
            "actualQuantity": qty,
            "executionTimeMs": 80,
            "raw": {"simulated": True},
            "paper": True,
        }
    except Exception:  # noqa: BLE001
        logger.exception("ib submit")
        raise


def cancel_order(broker_order_id: str, paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    try:
        from ib_insync import IB  # type: ignore

        host, port, client_id = _ib_connect_params(provider_config)
        ib = IB()
        ib.connect(host, port, clientId=client_id, timeout=10)
        try:
            for trade in ib.openTrades():
                if str(trade.order.orderId) == str(broker_order_id):
                    ib.cancelOrder(trade.order)
                    ib.sleep(0.5)
                    return {"ok": True}
            return {"ok": False, "message": "order not found"}
        finally:
            ib.disconnect()
    except ImportError:
        return {"ok": True, "simulated": True}


def get_order(broker_order_id: str, _paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    try:
        from ib_insync import IB  # type: ignore

        host, port, client_id = _ib_connect_params(provider_config)
        ib = IB()
        ib.connect(host, port, clientId=client_id, timeout=10)
        try:
            for trade in ib.trades():
                if str(trade.order.orderId) == str(broker_order_id):
                    return {
                        "brokerOrderId": broker_order_id,
                        "status": trade.orderStatus.status.lower(),
                        "actualPrice": float(trade.order.lmtPrice or 0),
                        "actualQuantity": float(trade.order.totalQuantity or 0),
                    }
            return {
                "brokerOrderId": broker_order_id,
                "status": "submitted",
                "actualPrice": 0,
                "actualQuantity": 0,
            }
        finally:
            ib.disconnect()
    except ImportError:
        return {
            "brokerOrderId": broker_order_id,
            "status": "filled",
            "actualPrice": 100,
            "actualQuantity": 100,
            "simulated": True,
        }


def get_fills(broker_order_id: str, _paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    try:
        from ib_insync import IB  # type: ignore

        host, port, client_id = _ib_connect_params(provider_config)
        ib = IB()
        ib.connect(host, port, clientId=client_id, timeout=10)
        try:
            fills = []
            for trade in ib.trades():
                if str(trade.order.orderId) != str(broker_order_id):
                    continue
                for f in trade.fills:
                    fills.append(
                        {
                            "brokerOrderId": broker_order_id,
                            "fillQty": float(f.execution.shares),
                            "fillPrice": float(f.execution.price),
                            "filledAt": str(f.execution.time),
                        }
                    )
            return {"fills": fills}
        finally:
            ib.disconnect()
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


def get_positions(_paper: bool, provider_config: dict[str, Any]) -> dict[str, Any]:
    try:
        from ib_insync import IB  # type: ignore

        host, port, client_id = _ib_connect_params(provider_config)
        ib = IB()
        ib.connect(host, port, clientId=client_id, timeout=10)
        try:
            positions = []
            for p in ib.positions():
                positions.append(
                    {
                        "symbol": p.contract.symbol,
                        "qty": float(p.position),
                        "avgPrice": float(p.avgCost),
                        "market": p.contract.primaryExchange or "",
                    }
                )
            return {"positions": positions}
        finally:
            ib.disconnect()
    except ImportError:
        return {"positions": [], "simulated": True}
