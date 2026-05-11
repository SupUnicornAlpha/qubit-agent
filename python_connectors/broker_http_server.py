#!/usr/bin/env python3
"""
Minimal HTTP bridge so the Bun runtime can call real brokers via `broker_account.base_url`.

Endpoints (match `HttpBrokerConnector` in TypeScript):
  GET  /health?provider=futu|ib&accountRef=...
  POST /orders  JSON body:
       { "ticker", "side", "quantity", "orderType", "limitPrice", "provider", "accountRef", "paper"? }

Environment:
  QUBIT_BROKER_PORT            default 18765
  QUBIT_BROKER_PROVIDER      futu | ib
  QUBIT_FUTU_OPEND_HOST      default 127.0.0.1
  QUBIT_FUTU_OPEND_PORT      default 11111
  QUBIT_BROKER_PAPER         1 = simulation / paper where supported
  QUBIT_IB_HOST / QUBIT_IB_PORT / QUBIT_IB_CLIENT_ID

Start:
  python broker_http_server.py
"""

from __future__ import annotations

import json
import logging
import os
import sys

_ROOT = os.path.dirname(os.path.abspath(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

logging.basicConfig(level=logging.INFO, format="[broker_http] %(message)s")
logger = logging.getLogger("broker_http")


def _connector() -> Any:
    from connectors.broker_gateway import get_connector

    c = get_connector()
    c.init(
        {
            "provider": os.environ.get("QUBIT_BROKER_PROVIDER", "futu"),
            "opend_host": os.environ.get("QUBIT_FUTU_OPEND_HOST", "127.0.0.1"),
            "opend_port": int(os.environ.get("QUBIT_FUTU_OPEND_PORT", "11111")),
            "paper": os.environ.get("QUBIT_BROKER_PAPER", "1") in ("1", "true", "yes"),
        }
    )
    return c


_CONN: Any | None = None


def get_conn() -> Any:
    global _CONN
    if _CONN is None:
        _CONN = _connector()
    return _CONN


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        logger.info("%s - %s", self.address_string(), fmt % args)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/health":
            self.send_error(404)
            return
        qs = parse_qs(parsed.query)
        provider = (qs.get("provider") or [os.environ.get("QUBIT_BROKER_PROVIDER", "futu")])[0]
        os.environ["QUBIT_BROKER_PROVIDER"] = str(provider)
        conn = get_conn()
        conn.init({"provider": provider})
        h = conn.healthcheck()
        status = h.get("healthy") or h.get("simulated")
        body = {
            "status": "healthy" if status else "down",
            "message": h.get("message", ""),
            "provider": provider,
            **{k: v for k, v in h.items() if k not in ("healthy", "message")},
        }
        self._json(200 if status else 503, body)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path not in ("/orders", "/v1/orders"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return
        provider = str(payload.get("provider") or os.environ.get("QUBIT_BROKER_PROVIDER", "futu"))
        os.environ["QUBIT_BROKER_PROVIDER"] = provider
        conn = get_conn()
        conn.init({"provider": provider})
        paper = payload.get("paper")
        if paper is None:
            paper = os.environ.get("QUBIT_BROKER_PAPER", "1") in ("1", "true", "yes")
        out = conn.execute(
            "submit_order",
            {
                "ticker": payload.get("ticker"),
                "side": payload.get("side", "buy"),
                "quantity": payload.get("quantity", 0),
                "limitPrice": payload.get("limitPrice"),
                "orderType": payload.get("orderType", "limit"),
                "paper": paper,
            },
        )
        self._json(200, out)

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
    logger.info("listening on http://127.0.0.1:%s (GET /health, POST /orders)", port)
    server.serve_forever()


if __name__ == "__main__":
    main()
