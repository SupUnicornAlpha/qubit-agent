#!/usr/bin/env python3
"""
WebSocket market-data bridge for Bun `BridgeStreamSession`.

Usage:
  cd python_connectors
  pip install websockets futu-api   # futu-api optional but needed for real quotes
  python -m market_bridge.server --provider futu --host 127.0.0.1 --port 8765

Env:
  QUBIT_FUTU_OPEND_HOST / QUBIT_FUTU_OPEND_PORT  (default 127.0.0.1:11111)
  Then set in Bun: QUBIT_FUTU_MARKET_WS_URL=ws://127.0.0.1:8765
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from typing import Any

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

logging.basicConfig(level=logging.INFO, format="[market_bridge] %(message)s")
logger = logging.getLogger("market_bridge.server")


def _build_provider(provider: str, emit):
    host = os.environ.get("QUBIT_FUTU_OPEND_HOST", "127.0.0.1")
    port = int(os.environ.get("QUBIT_FUTU_OPEND_PORT", "11111"))
    name = provider.strip().lower()
    if name == "futu":
        from market_bridge.providers.futu_quote import FutuQuoteProvider

        return FutuQuoteProvider(emit, host=host, port=port)
    if name in ("supermind", "ths", "tonghuashun"):
        from market_bridge.providers.supermind_stub import SupermindQuoteProvider

        return SupermindQuoteProvider(emit)
    if name == "ib":
        from market_bridge.providers.ib_quote import IbQuoteProvider

        return IbQuoteProvider(emit)
    if name == "alpaca":
        from market_bridge.providers.alpaca_quote import AlpacaQuoteProvider

        return AlpacaQuoteProvider(emit)
    if name in ("qmt", "xtquant", "miniqmt"):
        from market_bridge.providers.qmt_quote import QmtQuoteProvider

        return QmtQuoteProvider(emit)
    raise SystemExit(f"unknown provider: {provider} (futu|ib|alpaca|qmt|supermind)")


async def _run(host: str, port: int, provider_name: str) -> None:
    try:
        import websockets
        from websockets.server import serve
    except ImportError as error:
        raise SystemExit(
            "websockets package required: pip install websockets\n" + str(error)
        ) from error

    clients: set[Any] = set()
    loop = asyncio.get_running_loop()

    def emit(payload: dict[str, Any]) -> None:
        text = json.dumps(payload, ensure_ascii=False)

        async def _broadcast() -> None:
            dead: list[Any] = []
            for ws in list(clients):
                try:
                    await ws.send(text)
                except Exception:  # noqa: BLE001
                    dead.append(ws)
            for ws in dead:
                clients.discard(ws)

        asyncio.run_coroutine_threadsafe(_broadcast(), loop)

    provider = _build_provider(provider_name, emit)
    provider.start()
    logger.info("provider=%s listening ws://%s:%s", provider_name, host, port)

    async def handler(websocket: Any) -> None:
        clients.add(websocket)
        logger.info("client connected (%s)", websocket.remote_address)
        try:
            async for raw in websocket:
                try:
                    msg = json.loads(raw) if isinstance(raw, str) else json.loads(raw.decode())
                except json.JSONDecodeError:
                    continue
                action = str(msg.get("action") or "").lower()
                if action == "ping":
                    await websocket.send(json.dumps({"kind": "heartbeat", "data": {"pong": True}}))
                    continue
                if action == "subscribe":
                    provider.subscribe(msg)
                    continue
                if action in ("unsubscribe", "unsubscribe_market"):
                    provider.unsubscribe(msg)
        finally:
            clients.discard(websocket)
            logger.info("client disconnected")

    async with serve(handler, host, port):
        await asyncio.Future()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Qubit broker market-data WS bridge")
    parser.add_argument("--provider", default=os.environ.get("QUBIT_MARKET_BRIDGE_PROVIDER", "futu"))
    parser.add_argument("--host", default=os.environ.get("QUBIT_MARKET_BRIDGE_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("QUBIT_MARKET_BRIDGE_PORT", "8765")),
    )
    args = parser.parse_args(argv)
    try:
        asyncio.run(_run(args.host, args.port, args.provider))
    except KeyboardInterrupt:
        logger.info("stopped")


if __name__ == "__main__":
    main()
