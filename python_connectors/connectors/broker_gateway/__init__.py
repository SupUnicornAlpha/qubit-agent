"""
Broker gateway — Futu / IB adapters behind a stable execute() interface.

Requires (user installs as needed):
  pip install futu-api        # Futu OpenD must be running locally
  pip install ib-insync       # IB Gateway / TWS must be reachable
"""

from __future__ import annotations

import logging
import os
from typing import Any

from connectors.base import BaseConnector
from connectors.broker_gateway import futu as futu_adapter
from connectors.broker_gateway import ib as ib_adapter

logger = logging.getLogger("broker_gateway")


class BrokerGatewayConnector(BaseConnector):
    _provider: str = "futu"
    _paper: bool = True
    _provider_config: dict[str, Any]

    def __init__(self) -> None:
        self._provider_config = {}

    @property
    def name(self) -> str:
        return "broker_gateway"

    @property
    def version(self) -> str:
        return "0.3.0"

    def init(self, config: dict[str, Any]) -> None:
        self._provider = str(config.get("provider") or os.environ.get("QUBIT_BROKER_PROVIDER", "futu")).lower()
        self._paper = bool(config.get("paper", os.environ.get("QUBIT_BROKER_PAPER", "1") in ("1", "true", "yes")))
        cfg = config.get("providerConfig") or config.get("provider_config")
        if isinstance(cfg, dict):
            self._provider_config = cfg
        elif isinstance(cfg, str):
            import json

            try:
                self._provider_config = json.loads(cfg)
            except json.JSONDecodeError:
                self._provider_config = {}
        else:
            self._provider_config = {
                "opendHost": config.get("opend_host") or os.environ.get("QUBIT_FUTU_OPEND_HOST", "127.0.0.1"),
                "opendPort": int(config.get("opend_port") or os.environ.get("QUBIT_FUTU_OPEND_PORT", "11111")),
            }

    def healthcheck(self) -> dict[str, Any]:
        if self._provider == "futu":
            return futu_adapter.healthcheck(self._provider_config)
        if self._provider == "ib":
            return ib_adapter.healthcheck(self._provider_config)
        return {"healthy": False, "message": f"unknown provider {self._provider}"}

    def execute(self, operation: str, payload: dict[str, Any]) -> Any:
        if operation == "health":
            return self.healthcheck()
        if operation == "submit_order":
            return self._submit_order(payload)
        if operation == "cancel_order":
            return self._cancel_order(payload)
        if operation == "get_order":
            return self._get_order(payload)
        if operation == "get_fills":
            return self._get_fills(payload)
        if operation == "get_positions":
            return self._get_positions(payload)
        raise ValueError(f"unknown operation: {operation}")

    def _resolve_paper(self, payload: dict[str, Any]) -> bool:
        if "paper" in payload:
            return bool(payload["paper"])
        return self._paper

    def _cfg(self, payload: dict[str, Any]) -> dict[str, Any]:
        pc = payload.get("providerConfig") or payload.get("provider_config")
        if isinstance(pc, dict) and pc:
            return pc
        return self._provider_config

    def _submit_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        ticker = str(payload.get("ticker", ""))
        side = str(payload.get("side", "buy")).lower()
        qty = float(payload.get("quantity", 0))
        limit_price = float(payload.get("limitPrice") or payload.get("limit_price") or 0)
        order_type = str(payload.get("orderType") or payload.get("order_type") or "limit").lower()
        paper = self._resolve_paper(payload)
        cfg = self._cfg(payload)
        if self._provider == "futu":
            return futu_adapter.submit_order(ticker, side, qty, limit_price, order_type, paper, cfg)
        if self._provider == "ib":
            return ib_adapter.submit_order(ticker, side, qty, limit_price, order_type, paper, cfg)
        raise ValueError(f"unsupported provider {self._provider}")

    def _cancel_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        broker_order_id = str(payload.get("brokerOrderId") or payload.get("broker_order_id") or "")
        paper = self._resolve_paper(payload)
        cfg = self._cfg(payload)
        if self._provider == "futu":
            return futu_adapter.cancel_order(broker_order_id, paper, cfg)
        if self._provider == "ib":
            return ib_adapter.cancel_order(broker_order_id, paper, cfg)
        raise ValueError(f"unsupported provider {self._provider}")

    def _get_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        broker_order_id = str(payload.get("brokerOrderId") or payload.get("broker_order_id") or "")
        paper = self._resolve_paper(payload)
        cfg = self._cfg(payload)
        if self._provider == "futu":
            return futu_adapter.get_order(broker_order_id, paper, cfg)
        if self._provider == "ib":
            return ib_adapter.get_order(broker_order_id, paper, cfg)
        raise ValueError(f"unsupported provider {self._provider}")

    def _get_fills(self, payload: dict[str, Any]) -> dict[str, Any]:
        broker_order_id = str(payload.get("brokerOrderId") or payload.get("broker_order_id") or "")
        paper = self._resolve_paper(payload)
        cfg = self._cfg(payload)
        if self._provider == "futu":
            return futu_adapter.get_fills(broker_order_id, paper, cfg)
        if self._provider == "ib":
            return ib_adapter.get_fills(broker_order_id, paper, cfg)
        raise ValueError(f"unsupported provider {self._provider}")

    def _get_positions(self, payload: dict[str, Any]) -> dict[str, Any]:
        paper = self._resolve_paper(payload)
        cfg = self._cfg(payload)
        if self._provider == "futu":
            return futu_adapter.get_positions(paper, cfg)
        if self._provider == "ib":
            return ib_adapter.get_positions(paper, cfg)
        raise ValueError(f"unsupported provider {self._provider}")


def get_connector() -> BaseConnector:
    return BrokerGatewayConnector()
