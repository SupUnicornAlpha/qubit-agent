#!/usr/bin/env python3
"""Incremental on_bar strategy runtime (ScriptStrategy-style)."""

from __future__ import annotations

import json
import sys
from typing import Any

SAFE_BUILTINS = {
    "abs": abs,
    "bool": bool,
    "dict": dict,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "range": range,
    "sum": sum,
}


class StrategyScriptContext:
    def __init__(self) -> None:
        self._position: float = 0.0
        self.signals: list[dict[str, Any]] = []

    def buy(self, qty: float = 1.0) -> None:
        self.signals.append({"action": "buy", "qty": float(qty)})

    def sell(self, qty: float = 1.0) -> None:
        self.signals.append({"action": "sell", "qty": float(qty)})

    @property
    def position(self) -> float:
        return self._position


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        code = str(payload.get("strategyCode") or "")
        bars = payload.get("bars") or []
        if not code.strip():
            raise ValueError("strategyCode is required")
        if not isinstance(bars, list) or not bars:
            raise ValueError("bars is required")

        local_ctx: dict[str, Any] = {"__builtins__": SAFE_BUILTINS}
        exec(code, local_ctx, local_ctx)

        on_init = local_ctx.get("on_init")
        on_bar = local_ctx.get("on_bar")
        if not callable(on_bar):
            raise ValueError("on_bar(ctx, bar) is required in strategy code")

        ctx = StrategyScriptContext()
        if callable(on_init):
            on_init(ctx)

        last_bar = bars[-1]
        on_bar(ctx, last_bar)

        last_signals = ctx.signals[-3:] if ctx.signals else []
        buy = any(s.get("action") == "buy" for s in last_signals)
        sell = any(s.get("action") == "sell" for s in last_signals)

        print(
            json.dumps(
                {
                    "ok": True,
                    "buy": buy,
                    "sell": sell,
                    "barTime": last_bar.get("time") if isinstance(last_bar, dict) else None,
                    "signals": last_signals,
                }
            )
        )
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
