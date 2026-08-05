"""Broker market-data WebSocket bridges (quote / book / trade).

Separate from `broker_http_server.py` (orders / positions). Bun connects via
`QUBIT_<PROVIDER>_MARKET_WS_URL` and speaks the protocol in docs/market-data-realtime.md.
"""

__version__ = "0.1.0"
