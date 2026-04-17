"""
Base class for all Python connectors.

Each concrete connector module must expose a `get_connector()` function
that returns an instance of a class implementing this interface.
"""

from abc import ABC, abstractmethod
from typing import Any


class BaseConnector(ABC):
    """Abstract base class for all Python-side connectors."""

    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @property
    @abstractmethod
    def version(self) -> str:
        ...

    @abstractmethod
    def init(self, config: dict[str, Any]) -> None:
        """Initialize with config dict. Called once at startup."""
        ...

    @abstractmethod
    def healthcheck(self) -> dict[str, Any]:
        """Return health status: {"healthy": bool, "message": str}"""
        ...

    @abstractmethod
    def execute(self, operation: str, payload: dict[str, Any]) -> Any:
        """Dispatch an operation with payload. Returns serializable result."""
        ...

    def shutdown(self) -> None:
        """Graceful teardown. Override if needed."""
        pass
