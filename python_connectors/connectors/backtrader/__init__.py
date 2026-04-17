"""
Backtrader BacktestConnector stub.

Install: pip install backtrader
"""

from typing import Any
from ..base import BaseConnector


class BacktraderConnector(BaseConnector):
    name = "backtrader"
    version = "1.0.0"

    def __init__(self) -> None:
        self._bt: Any = None

    def init(self, config: dict[str, Any]) -> None:
        try:
            import backtrader as bt  # type: ignore[import]
            self._bt = bt
        except ImportError as e:
            raise ImportError("backtrader not installed. Run: pip install backtrader") from e

    def healthcheck(self) -> dict[str, Any]:
        if self._bt is None:
            return {"healthy": False, "message": "Not initialized"}
        return {"healthy": True}

    def execute(self, operation: str, payload: dict[str, Any]) -> Any:
        if self._bt is None:
            raise RuntimeError("BacktraderConnector not initialized")

        if operation == "run_backtest":
            return self._run_backtest(payload)
        elif operation == "get_status":
            return self._get_status(payload)
        elif operation == "cancel_run":
            return self._cancel_run(payload)
        else:
            raise ValueError(f"Unknown operation: {operation}")

    def _run_backtest(self, params: dict[str, Any]) -> dict[str, Any]:
        # TODO: implement full backtrader run
        raise NotImplementedError("BacktraderConnector.run_backtest is not yet implemented")

    def _get_status(self, params: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError("BacktraderConnector.get_status is not yet implemented")

    def _cancel_run(self, params: dict[str, Any]) -> None:
        raise NotImplementedError("BacktraderConnector.cancel_run is not yet implemented")


def get_connector() -> BacktraderConnector:
    return BacktraderConnector()
