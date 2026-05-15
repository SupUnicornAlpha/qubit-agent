#!/usr/bin/env python3
"""
HTTP bridge so the Bun runtime can call real brokers via `broker_account.base_url`.

Endpoints:
  GET  /health?provider=futu|ib&accountRef=...&providerConfig={json}
  POST /orders
  GET  /orders?brokerOrderId=...
  POST /orders/cancel
  GET  /fills?brokerOrderId=...
  GET  /positions
"""

from __future__ import annotations

import json
import logging
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

_ROOT = os.path.dirname(os.path.abspath(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

logging.basicConfig(level=logging.INFO, format="[broker_http] %(message)s")
logger = logging.getLogger("broker_http")


def _parse_provider_config(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def _connector() -> Any:
    from connectors.broker_gateway import get_connector

    return get_connector()


_CONN: Any | None = None


def get_conn() -> Any:
    global _CONN
    if _CONN is None:
        _CONN = _connector()
    return _CONN


def _init_conn(payload: dict[str, Any]) -> Any:
    conn = get_conn()
    provider = str(payload.get("provider") or os.environ.get("QUBIT_BROKER_PROVIDER", "futu"))
    os.environ["QUBIT_BROKER_PROVIDER"] = provider
    paper = payload.get("paper")
    if paper is None:
        paper = os.environ.get("QUBIT_BROKER_PAPER", "1") in ("1", "true", "yes")
    pc = payload.get("providerConfig") or payload.get("provider_config")
    if isinstance(pc, str):
        pc = _parse_provider_config(pc)
    conn.init(
        {
            "provider": provider,
            "paper": paper,
            "providerConfig": pc if isinstance(pc, dict) else {},
        }
    )
    return conn


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        logger.info("%s - %s", self.address_string(), fmt % args)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == "/health":
            provider = (qs.get("provider") or [os.environ.get("QUBIT_BROKER_PROVIDER", "futu")])[0]
            pc_raw = (qs.get("providerConfig") or ["{}"])[0]
            conn = _init_conn(
                {
                    "provider": provider,
                    "providerConfig": _parse_provider_config(str(pc_raw)),
                }
            )
            h = conn.healthcheck()
            status = h.get("healthy") or h.get("simulated")
            body = {
                "status": "healthy" if status else "down",
                "message": h.get("message", ""),
                "provider": provider,
                **{k: v for k, v in h.items() if k not in ("healthy", "message")},
            }
            self._json(200 if status else 503, body)
            return

        if parsed.path == "/orders":
            broker_order_id = (qs.get("brokerOrderId") or [""])[0]
            provider = (qs.get("provider") or [os.environ.get("QUBIT_BROKER_PROVIDER", "futu")])[0]
            pc_raw = (qs.get("providerConfig") or ["{}"])[0]
            paper = (qs.get("paper") or ["true"])[0] in ("1", "true", "yes")
            conn = _init_conn(
                {
                    "provider": provider,
                    "paper": paper,
                    "providerConfig": _parse_provider_config(str(pc_raw)),
                }
            )
            out = conn.execute(
                "get_order",
                {"brokerOrderId": broker_order_id, "paper": paper, "providerConfig": _parse_provider_config(str(pc_raw))},
            )
            self._json(200, out)
            return

        if parsed.path == "/fills":
            broker_order_id = (qs.get("brokerOrderId") or [""])[0]
            provider = (qs.get("provider") or [os.environ.get("QUBIT_BROKER_PROVIDER", "futu")])[0]
            pc_raw = (qs.get("providerConfig") or ["{}"])[0]
            paper = (qs.get("paper") or ["true"])[0] in ("1", "true", "yes")
            conn = _init_conn(
                {
                    "provider": provider,
                    "paper": paper,
                    "providerConfig": _parse_provider_config(str(pc_raw)),
                }
            )
            out = conn.execute(
                "get_fills",
                {"brokerOrderId": broker_order_id, "paper": paper, "providerConfig": _parse_provider_config(str(pc_raw))},
            )
            self._json(200, out)
            return

        if parsed.path == "/positions":
            provider = (qs.get("provider") or [os.environ.get("QUBIT_BROKER_PROVIDER", "futu")])[0]
            pc_raw = (qs.get("providerConfig") or ["{}"])[0]
            paper = (qs.get("paper") or ["true"])[0] in ("1", "true", "yes")
            conn = _init_conn(
                {
                    "provider": provider,
                    "paper": paper,
                    "providerConfig": _parse_provider_config(str(pc_raw)),
                }
            )
            out = conn.execute(
                "get_positions",
                {"paper": paper, "providerConfig": _parse_provider_config(str(pc_raw))},
            )
            self._json(200, out)
            return

        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return

        if parsed.path in ("/orders", "/v1/orders"):
            conn = _init_conn(payload)
            out = conn.execute(
                "submit_order",
                {
                    "ticker": payload.get("ticker"),
                    "side": payload.get("side", "buy"),
                    "quantity": payload.get("quantity", 0),
                    "limitPrice": payload.get("limitPrice"),
                    "orderType": payload.get("orderType", "limit"),
                    "paper": payload.get("paper"),
                    "providerConfig": payload.get("providerConfig") or payload.get("provider_config") or {},
                },
            )
            self._json(200, out)
            return

        if parsed.path == "/orders/cancel":
            conn = _init_conn(payload)
            out = conn.execute(
                "cancel_order",
                {
                    "brokerOrderId": payload.get("brokerOrderId"),
                    "paper": payload.get("paper"),
                    "providerConfig": payload.get("providerConfig") or {},
                },
            )
            self._json(200, out)
            return

        self.send_error(404)

    def _json(self, code: int, obj: dict[str, Any]) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    port = int(os.environ.get("QUBIT_BROKER_PORT", "18765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    logger.info(
        "listening on http://127.0.0.1:%s (GET /health /orders /fills /positions, POST /orders /orders/cancel)",
        port,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
