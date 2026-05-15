#!/usr/bin/env python3
import json
import math
import sys
from typing import Any


SAFE_BUILTINS = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "pow": pow,
    "range": range,
    "round": round,
    "sum": sum,
    "zip": zip,
}


def _normalize_signal(raw: Any, n: int, name: str) -> list[bool]:
    if raw is None:
        return [False] * n
    if not isinstance(raw, list):
        raise ValueError(f"{name} must be list[bool], got {type(raw).__name__}")
    if len(raw) != n:
        raise ValueError(f"{name} length mismatch: expected {n}, got {len(raw)}")
    return [bool(x) for x in raw]


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        bars = payload.get("bars") or []
        code = str(payload.get("indicatorCode") or "")
        buy_key = str(payload.get("buyKey") or "buy")
        sell_key = str(payload.get("sellKey") or "sell")
        if not isinstance(bars, list) or len(bars) == 0:
            raise ValueError("bars is required")
        if not code.strip():
            raise ValueError("indicatorCode is required")
        closes = [float((b or {}).get("close", 0.0)) for b in bars]
        highs = [float((b or {}).get("high", 0.0)) for b in bars]
        lows = [float((b or {}).get("low", 0.0)) for b in bars]
        volumes = [float((b or {}).get("volume", 0.0)) for b in bars]

        output: dict[str, Any] = {}
        local_ctx: dict[str, Any] = {
            "bars": bars,
            "closes": closes,
            "highs": highs,
            "lows": lows,
            "volumes": volumes,
            "output": output,
        }
        global_ctx: dict[str, Any] = {"__builtins__": SAFE_BUILTINS, "math": math}
        exec(code, global_ctx, local_ctx)
        out_obj = local_ctx.get("output", output)
        if (
            isinstance(out_obj, dict)
            and buy_key in out_obj
            and sell_key in out_obj
        ):
            buy = _normalize_signal(out_obj.get(buy_key), len(bars), buy_key)
            sell = _normalize_signal(out_obj.get(sell_key), len(bars), sell_key)
        elif buy_key in local_ctx and sell_key in local_ctx:
            buy = _normalize_signal(local_ctx.get(buy_key), len(bars), buy_key)
            sell = _normalize_signal(local_ctx.get(sell_key), len(bars), sell_key)
        else:
            raise ValueError("signal code must set output{buy,sell} or buy/sell arrays")
        sys.stdout.write(json.dumps({"ok": True, "buy": buy, "sell": sell}))
        return
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "error": str(e)}))
        return


if __name__ == "__main__":
    main()
