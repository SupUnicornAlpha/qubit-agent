"""
Broker gateway — optional real Futu / IB adapters behind a stable JSON-RPC interface.

Requires (user installs as needed):
  pip install futu-api        # Futu OpenD must be running locally
  pip install ib-insync       # IB Gateway / TWS must be reachable

Without SDKs the connector still runs in "simulated" mode for health/smoke tests.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from connectors.base import BaseConnector

logger = logging.getLogger("broker_gateway")


class BrokerGatewayConnector(BaseConnector):
    _provider: str
    _host: str
    _port: int
    _paper: bool

    @property
    def name(self) -> str:
        return "broker_gateway"

    @property
    def version(self) -> str:
        return "0.2.0"

    def init(self, config: dict[str, Any]) -> None:
        self._provider = str(config.get("provider") or os.environ.get("QUBIT_BROKER_PROVIDER", "futu")).lower()
        self._host = str(config.get("opend_host") or os.environ.get("QUBIT_FUTU_OPEND_HOST", "127.0.0.1"))
        self._port = int(config.get("opend_port") or os.environ.get("QUBIT_FUTU_OPEND_PORT", "11111"))
        self._paper = bool(config.get("paper", os.environ.get("QUBIT_BROKER_PAPER", "1") in ("1", "true", "yes")))

    def healthcheck(self) -> dict[str, Any]:
        if self._provider == "futu":
            return self._health_futu()
        if self._provider == "ib":
            return self._health_ib()
        return {"healthy": False, "message": f"unknown provider {self._provider}"}

    def execute(self, operation: str, payload: dict[str, Any]) -> Any:
        if operation == "health":
            return self.healthcheck()
        if operation == "submit_order":
            return self._submit_order(payload)
        raise ValueError(f"unknown operation: {operation}")

    def _health_futu(self) -> dict[str, Any]:
        try:
            from futu import OpenSecTradeContext  # type: ignore

            ctx = OpenSecTradeContext(host=self._host, port=self._port)
            try:
                ret, data = ctx.get_acc_list()
                ok = ret == 0
                msg = "futu opend ok" if ok else f"futu get_acc_list ret={ret}"
                return {"healthy": ok, "message": msg, "accounts_preview": str(data)[:500] if data is not None else ""}
            finally:
                ctx.close()
        except ImportError:
            return {
                "healthy": True,
                "message": "futu-api not installed; simulated healthy. pip install futu-api + start OpenD for real trading.",
                "simulated": True,
            }
        except Exception as e:  # noqa: BLE001
            logger.exception("futu health")
            return {"healthy": False, "message": str(e)}

    def _health_ib(self) -> dict[str, Any]:
        try:
            from ib_insync import IB  # type: ignore

            host = os.environ.get("QUBIT_IB_HOST", "127.0.0.1")
            port = int(os.environ.get("QUBIT_IB_PORT", "7497"))
            client_id = int(os.environ.get("QUBIT_IB_CLIENT_ID", "1"))
            ib = IB()
            ib.connect(host, port, clientId=client_id, timeout=5)
            try:
                return {"healthy": True, "message": "ib connected", "accounts": [a for a in ib.managedAccounts()]}
            finally:
                ib.disconnect()
        except ImportError:
            return {
                "healthy": True,
                "message": "ib_insync not installed; simulated healthy. pip install ib-insync + run IB Gateway/TWS.",
                "simulated": True,
            }
        except Exception as e:  # noqa: BLE001
            logger.exception("ib health")
            return {"healthy": False, "message": str(e)}

    def _submit_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        ticker = str(payload.get("ticker", ""))
        side = str(payload.get("side", "buy")).lower()
        qty = float(payload.get("quantity", 0))
        limit_price = float(payload.get("limitPrice") or payload.get("limit_price") or 0)
        order_type = str(payload.get("orderType") or payload.get("order_type") or "limit").lower()
        paper = bool(payload.get("paper", self._paper))

        if self._provider == "futu":
            return self._submit_futu(ticker, side, qty, limit_price, order_type, paper)
        if self._provider == "ib":
            return self._submit_ib(ticker, side, qty, limit_price, order_type, paper)
        raise ValueError(f"unsupported provider {self._provider}")

    def _submit_futu(
        self, ticker: str, side: str, qty: float, limit_price: float, order_type: str, paper: bool
    ) -> dict[str, Any]:
        try:
            from futu import OpenSecTradeContext, OrderType, TrdEnv, TrdSide  # type: ignore

            ctx = OpenSecTradeContext(host=self._host, port=self._port)
            try:
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
            finally:
                ctx.close()
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
        except Exception as e:  # noqa: BLE001
            logger.exception("futu submit")
            raise

    def _submit_ib(
        self, ticker: str, side: str, qty: float, limit_price: float, order_type: str, paper: bool
    ) -> dict[str, Any]:
        try:
            from ib_insync import IB, LimitOrder, MarketOrder, Stock  # type: ignore

            host = os.environ.get("QUBIT_IB_HOST", "127.0.0.1")
            port = int(os.environ.get("QUBIT_IB_PORT", "7497"))
            client_id = int(os.environ.get("QUBIT_IB_CLIENT_ID", "1"))
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
                "raw": {"simulated": True, "note": "install ib-insync for real orders"},
                "paper": True,
            }
        except Exception as e:  # noqa: BLE001
            logger.exception("ib submit")
            raise


def get_connector() -> BaseConnector:
    return BrokerGatewayConnector()
