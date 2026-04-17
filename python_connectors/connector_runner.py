#!/usr/bin/env python3
"""
connector_runner.py — JSON-RPC stdio bridge for Python connectors.

Protocol:
  stdin  ← JSON-RPC Request  {"id": "...", "method": "...", "params": {...}}
  stdout → JSON-RPC Response {"id": "...", "result": {...}}
             or error        {"id": "...", "error": {"code": -1, "message": "..."}}
  stderr → log stream (forwarded to platform logger, not part of protocol)

Usage:
  python connector_runner.py --connector tushare
  python connector_runner.py --connector akshare
  python connector_runner.py --connector backtrader
"""

import sys
import json
import argparse
import logging
import traceback
from typing import Any

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="[%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("connector_runner")


# ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

def send_response(id: Any, result: Any) -> None:
    payload = json.dumps({"id": id, "result": result})
    sys.stdout.write(payload + "\n")
    sys.stdout.flush()


def send_error(id: Any, code: int, message: str, data: Any = None) -> None:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    payload = json.dumps({"id": id, "error": error})
    sys.stdout.write(payload + "\n")
    sys.stdout.flush()


# ─── Connector dispatch ───────────────────────────────────────────────────────

def load_connector(name: str):
    """Dynamically import and return a connector instance by name."""
    try:
        module = __import__(f"connectors.{name}", fromlist=["get_connector"])
        return module.get_connector()
    except ImportError as e:
        raise ImportError(f"Connector '{name}' not found. Error: {e}") from e


def dispatch(connector: Any, method: str, params: Any) -> Any:
    """Dispatch a JSON-RPC method to the connector."""
    if method == "init":
        connector.init(params or {})
        return {"status": "ok"}
    elif method == "healthcheck":
        return connector.healthcheck()
    elif method == "execute":
        operation = params.get("operation")
        payload = params.get("payload", {})
        return connector.execute(operation, payload)
    elif method == "shutdown":
        connector.shutdown()
        return {"status": "ok"}
    else:
        raise ValueError(f"Unknown method: {method}")


# ─── Main loop ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="QUBIT Python Connector Bridge")
    parser.add_argument("--connector", required=True, help="Connector name to load")
    args = parser.parse_args()

    logger.info(f"Loading connector: {args.connector}")

    try:
        connector = load_connector(args.connector)
    except ImportError as e:
        logger.error(str(e))
        sys.exit(1)

    logger.info(f"Connector '{args.connector}' loaded. Listening on stdin...")

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            method = request.get("method")
            params = request.get("params")

            result = dispatch(connector, method, params)
            send_response(request_id, result)

        except json.JSONDecodeError as e:
            logger.warning(f"Malformed JSON: {e}")
            send_error(request_id, -32700, "Parse error", str(e))

        except Exception as e:
            logger.error(f"Error handling request: {traceback.format_exc()}")
            send_error(request_id, -32603, str(e), traceback.format_exc())


if __name__ == "__main__":
    main()
