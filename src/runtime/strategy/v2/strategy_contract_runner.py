#!/usr/bin/env python3
"""
Qubit Strategy Contract runner (Prime 06).

Actions (stdin JSON):
  - compile: { "action": "compile", "strategyCode": "..." }
  - backtest: {
      "action": "backtest",
      "strategyCode": "...",
      "bars": [{timestamp,open,high,low,close,volume}, ...],
      "params": {},
      "initialCapital": 100000,
      "commission": 0.001,
      "symbol": "SPY"   # optional override of primary universe symbol for bar series
    }

Compile runs initialize() under DiscoveryContext (declaration APIs only).
Backtest binds the same handlers to a SimBroker with next-open fills for
target_* intents produced during handle_data.
"""

from __future__ import annotations

import ast
import hashlib
import io
import json
import math
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Callable


SAFE_BUILTINS: dict[str, Any] = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "float": float,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "pow": pow,
    "print": print,
    "range": range,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
    "True": True,
    "False": False,
    "None": None,
}

PARAM_RE = re.compile(
    r"^#\s*@param\s+(\w+)\s+(\w+)\s+(\S+)(?:\s+(.*))?$",
    re.MULTILINE,
)

FORBIDDEN_IN_INITIALIZE = {
    "get_history",
    "get_position",
    "get_positions",
    "order",
    "order_value",
    "order_target",
    "order_target_value",
    "order_target_percent",
    "set_default_protection",
}


class ContractError(Exception):
    pass


@dataclass
class GState:
    data: dict[str, Any] = field(default_factory=dict)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            return object.__getattribute__(self, name)
        return self.data.get(name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name in {"data"} or name.startswith("_"):
            object.__setattr__(self, name, value)
        else:
            self.data[name] = value


@dataclass
class InstrumentSpec:
    instrument_id: str

    def to_json(self) -> dict[str, Any]:
        market, _, symbol = self.instrument_id.partition(":")
        if not symbol:
            symbol = market
            market = "UNKNOWN"
        return {
            "market": market,
            "symbol": symbol,
            "instrumentId": self.instrument_id,
        }


@dataclass
class DiscoveryContext:
    universe: list[str] = field(default_factory=list)
    subscriptions: list[dict[str, Any]] = field(default_factory=list)
    schedules: list[dict[str, Any]] = field(default_factory=list)
    warmup_bars: int = 0
    benchmark: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    params: dict[str, Any] = field(default_factory=dict)

    def set_universe(self, symbols: list[str] | str | None = None, **kwargs: Any) -> None:
        """Accept list or single symbol string; normalize US-NVDA → US:NVDA."""
        raw: list[str] = []
        if isinstance(symbols, str):
            raw = [symbols]
        elif symbols:
            raw = [str(s) for s in symbols]
        if raw:
            normalized: list[str] = []
            for s in raw:
                t = str(s).strip()
                if not t:
                    continue
                # Common LLM slip: US-NVDA instead of US:NVDA
                if "-" in t and ":" not in t and t.upper()[:3] in (
                    "US-",
                    "HK-",
                    "CN-",
                    "SH-",
                    "SZ-",
                ):
                    mkt, _, rest = t.partition("-")
                    t = f"{mkt.upper()}:{rest}"
                normalized.append(t)
            self.universe = normalized
        elif "index" in kwargs:
            self.universe = [f"INDEX:{kwargs['index']}"]
        elif "pool" in kwargs:
            self.universe = [f"POOL:{kwargs['pool']}"]

    def subscribe(
        self,
        frequency: str = "1d",
        fields: list[str] | None = None,
        symbols: list[str] | str | None = None,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        # Tolerate LLM slips: subscribe("1d"), subscribe(factor_id), subscribe(["close"])
        if args and not fields and symbols is None:
            first = args[0]
            if isinstance(first, str) and first in ("1d", "1h", "5m", "15m", "30m", "1m", "1w"):
                frequency = first
            elif isinstance(first, list):
                fields = [str(x) for x in first]
            # else ignore bogus factor uuid etc.
        if isinstance(symbols, str):
            symbols = [symbols]
        self.subscriptions.append(
            {
                "frequency": frequency,
                "fields": list(fields or ["open", "high", "low", "close", "volume"]),
                "instruments": list(symbols) if symbols else None,
            }
        )

    def set_warmup(self, n: int) -> None:
        self.warmup_bars = int(n)

    def set_benchmark(self, symbol: str) -> None:
        self.benchmark = str(symbol)

    def allow_leverage(self, max_leverage: float = 1.0) -> None:
        self.metadata["maxLeverage"] = float(max_leverage)
        self.metadata["leverageAllowed"] = float(max_leverage) > 1.0

    def set_metadata(self, **kwargs: Any) -> None:
        self.metadata.update(kwargs)


def parse_params(code: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in PARAM_RE.finditer(code):
        name, typ, default, rest = m.group(1), m.group(2), m.group(3), m.group(4) or ""
        desc = rest
        range_spec = None
        rm = re.search(r"range=([^\s]+)", rest)
        if rm:
            range_spec = rm.group(1)
            desc = (rest[: rm.start()] + rest[rm.end() :]).strip()
        coerced: Any = default
        if typ == "int":
            try:
                coerced = int(float(default))
            except ValueError:
                coerced = default
        elif typ == "float":
            try:
                coerced = float(default)
            except ValueError:
                coerced = default
        elif typ == "bool":
            coerced = default.lower() in {"1", "true", "yes"}
        out.append(
            {
                "name": name,
                "type": typ,
                "default": coerced,
                "description": desc,
                "range": range_spec,
            }
        )
    return out


def _check_initialize_forbidden(code: str) -> None:
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise ContractError(f"syntax error: {e}") from e
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "initialize":
            for child in ast.walk(node):
                if isinstance(child, ast.Call):
                    fn = child.func
                    name = None
                    if isinstance(fn, ast.Name):
                        name = fn.id
                    elif isinstance(fn, ast.Attribute):
                        name = fn.attr
                    if name in FORBIDDEN_IN_INITIALIZE:
                        raise ContractError(
                            f"initialize() must not call `{name}` (declaration only)"
                        )
                    if (
                        isinstance(fn, ast.Attribute)
                        and isinstance(fn.value, ast.Name)
                        and fn.value.id == "context"
                        and fn.attr == "params"
                    ):
                        raise ContractError(
                            "initialize() must not read context.params"
                        )
            return
    raise ContractError("missing required function initialize(context)")


def _has_handler(namespace: dict[str, Any]) -> list[str]:
    handlers = []
    for name in ("handle_data", "on_rebalance", "before_trading_start", "after_trading_end"):
        if callable(namespace.get(name)):
            handlers.append(name)
    return handlers


def compile_strategy(code: str) -> dict[str, Any]:
    _check_initialize_forbidden(code)
    params_schema = parse_params(code)
    g = GState()
    ctx = DiscoveryContext()
    schedules: list[dict[str, Any]] = []

    def run_daily(fn: Callable[..., Any], time: str = "09:31") -> None:
        schedules.append({"frequency": "daily", "callback": getattr(fn, "__name__", "run_daily"), "time": time})

    def run_weekly(fn: Callable[..., Any], time: str = "09:31", weekday: int = 1) -> None:
        schedules.append(
            {
                "frequency": "weekly",
                "callback": getattr(fn, "__name__", "run_weekly"),
                "time": time,
                "weekday": weekday,
            }
        )

    def run_monthly(fn: Callable[..., Any], time: str = "09:31", monthday: int = 1) -> None:
        schedules.append(
            {
                "frequency": "monthly",
                "callback": getattr(fn, "__name__", "run_monthly"),
                "time": time,
                "monthday": monthday,
            }
        )

    def stub(*_a: Any, **_k: Any) -> Any:
        raise ContractError("runtime API unavailable during compile/discovery")

    ns: dict[str, Any] = {
        "__builtins__": SAFE_BUILTINS,
        "g": g,
        "run_daily": run_daily,
        "run_weekly": run_weekly,
        "run_monthly": run_monthly,
        "get_history": stub,
        "get_position": stub,
        "get_positions": stub,
        "order": stub,
        "order_value": stub,
        "order_target": stub,
        "order_target_value": stub,
        "order_target_percent": stub,
        "set_default_protection": stub,
        "data": None,
    }
    try:
        exec(compile(code, "<strategy>", "exec"), ns, ns)
    except ContractError:
        raise
    except Exception as e:
        raise ContractError(f"exec failed: {e}") from e

    init = ns.get("initialize")
    if not callable(init):
        raise ContractError("initialize(context) is required")
    try:
        init(ctx)
    except ContractError:
        raise
    except Exception as e:
        raise ContractError(f"initialize() failed: {e}") from e

    handlers = _has_handler(ns)
    if not any(h in handlers for h in ("handle_data", "on_rebalance")) and not schedules:
        raise ContractError(
            "need handle_data and/or on_rebalance and/or scheduled callbacks"
        )
    if not ctx.universe:
        raise ContractError("initialize() must call context.set_universe([...])")
    if not ctx.subscriptions:
        # default daily ohlcv on universe
        ctx.subscribe(frequency="1d")

    strategy_type = (
        "portfolio"
        if len(ctx.universe) > 1 or "on_rebalance" in handlers
        else "cta"
    )
    code_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()
    primary_freq = ctx.subscriptions[0]["frequency"] if ctx.subscriptions else "1d"
    manifest = {
        "apiVersion": 2,
        "codeHash": code_hash,
        "strategyType": strategy_type,
        "universe": {
            "kind": "static",
            "instruments": [InstrumentSpec(u).to_json() for u in ctx.universe],
        },
        "subscriptions": ctx.subscriptions,
        "schedules": schedules,
        "benchmark": InstrumentSpec(ctx.benchmark).to_json() if ctx.benchmark else None,
        "handlers": handlers,
        "factorDependencies": [],
        "fundamentalDependencies": [],
        "warmupBars": ctx.warmup_bars,
        "leverageAllowed": bool(ctx.metadata.get("leverageAllowed", False)),
        "maxLeverage": float(ctx.metadata.get("maxLeverage", 1.0)),
        "primaryFrequency": primary_freq,
        "metadata": ctx.metadata,
        "paramsSchema": params_schema,
        "gState": g.data,
    }
    return {"ok": True, "manifest": manifest}


@dataclass
class Position:
    amount: float = 0.0
    avg_cost: float = 0.0


@dataclass
class OrderIntent:
    symbol: str
    kind: str
    value: float
    reason: str = ""
    signal_time: str | None = None


class SimBroker:
    def __init__(self, initial_cash: float, commission: float):
        self.cash = float(initial_cash)
        self.initial_cash = float(initial_cash)
        self.commission = float(commission)
        self.positions: dict[str, Position] = {}
        self.trades: list[dict[str, Any]] = []
        self.intents_log: list[dict[str, Any]] = []

    def equity(self, marks: dict[str, float]) -> float:
        eq = self.cash
        for sym, pos in self.positions.items():
            px = marks.get(sym, pos.avg_cost)
            eq += pos.amount * px
        return eq

    def get_position(self, symbol: str) -> Position:
        return self.positions.get(symbol, Position())

    def execute(
        self,
        intent: OrderIntent,
        price: float,
        ts: str,
        marks: dict[str, float],
    ) -> None:
        self.intents_log.append(
            {
                "time": ts,
                "symbol": intent.symbol,
                "kind": intent.kind,
                "value": intent.value,
                "reason": intent.reason,
                "fillPrice": price,
            }
        )
        pos = self.positions.setdefault(intent.symbol, Position())
        if intent.kind == "target_percent":
            eq = self.equity(marks)
            target_notional = eq * float(intent.value)
            target_qty = 0.0 if price <= 0 else target_notional / price
        elif intent.kind == "target_quantity":
            target_qty = float(intent.value)
        elif intent.kind == "quantity":
            target_qty = pos.amount + float(intent.value)
        elif intent.kind == "target_value":
            target_qty = 0.0 if price <= 0 else float(intent.value) / price
        elif intent.kind == "value":
            delta_qty = 0.0 if price <= 0 else float(intent.value) / price
            target_qty = pos.amount + delta_qty
        else:
            raise ContractError(f"unsupported intent kind: {intent.kind}")

        # long-only simplified fill
        target_qty = max(0.0, target_qty)
        delta = target_qty - pos.amount
        if abs(delta) < 1e-12:
            return
        fee = abs(delta) * price * self.commission
        if delta > 0:
            cost = delta * price + fee
            if cost > self.cash + 1e-9:
                # scale to afford
                afford = max(0.0, (self.cash) / (price * (1 + self.commission)))
                delta = afford
                if delta <= 1e-12:
                    return
                fee = delta * price * self.commission
                cost = delta * price + fee
            self.cash -= cost
            new_amt = pos.amount + delta
            if new_amt > 0:
                pos.avg_cost = (
                    (pos.avg_cost * pos.amount + price * delta) / new_amt
                    if pos.amount > 0
                    else price
                )
            pos.amount = new_amt
            self.trades.append(
                {
                    "time": ts,
                    "side": "buy",
                    "qty": delta,
                    "price": price,
                    "fee": fee,
                    "symbol": intent.symbol,
                    "reason": intent.reason,
                }
            )
        else:
            sell_qty = min(pos.amount, -delta)
            if sell_qty <= 1e-12:
                return
            proceeds = sell_qty * price - fee
            self.cash += proceeds
            pos.amount -= sell_qty
            if pos.amount <= 1e-12:
                pos.amount = 0.0
                pos.avg_cost = 0.0
            self.trades.append(
                {
                    "time": ts,
                    "side": "sell",
                    "qty": sell_qty,
                    "price": price,
                    "fee": fee,
                    "symbol": intent.symbol,
                    "reason": intent.reason,
                }
            )


def _metrics(equity_curve: list[dict[str, Any]], trade_count: int) -> dict[str, Any]:
    if not equity_curve:
        return {
            "totalReturnPct": 0.0,
            "maxDrawdownPct": 0.0,
            "sharpeApprox": 0.0,
            "tradeCount": 0,
            "bars": 0,
        }
    eq0 = float(equity_curve[0]["equity"])
    eqn = float(equity_curve[-1]["equity"])
    total_ret = 0.0 if eq0 <= 0 else (eqn / eq0 - 1.0) * 100.0
    peak = eq0
    max_dd = 0.0
    rets: list[float] = []
    prev = eq0
    for pt in equity_curve:
        e = float(pt["equity"])
        peak = max(peak, e)
        if peak > 0:
            max_dd = max(max_dd, (peak - e) / peak)
        if prev > 0:
            rets.append(e / prev - 1.0)
        prev = e
    sharpe = 0.0
    if len(rets) > 1:
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
        std = math.sqrt(var) if var > 0 else 0.0
        if std > 0:
            sharpe = (mean / std) * math.sqrt(252.0)
    return {
        "totalReturnPct": total_ret,
        "maxDrawdownPct": max_dd * 100.0,
        "sharpeApprox": sharpe,
        "tradeCount": trade_count,
        "bars": len(equity_curve),
        "lastPosition": None,
    }


def backtest_strategy(payload: dict[str, Any]) -> dict[str, Any]:
    code = str(payload.get("strategyCode") or "")
    compiled = compile_strategy(code)
    manifest = compiled["manifest"]
    bars = payload.get("bars") or []
    if not isinstance(bars, list) or len(bars) < 2:
        raise ContractError("backtest requires bars[] with length >= 2")

    primary = str(payload.get("symbol") or "").strip()
    if not primary:
        inst = manifest["universe"]["instruments"][0]
        primary = inst.get("instrumentId") or inst.get("symbol") or ""
    # Normalize US:SPY → use same key in broker
    symbol_key = primary

    params_defaults = {
        p["name"]: p["default"] for p in manifest.get("paramsSchema") or []
    }
    user_params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    params = {**params_defaults, **(user_params or {})}

    broker = SimBroker(
        float(payload.get("initialCapital") or 100_000),
        float(payload.get("commission") or 0.001),
    )
    pending: list[OrderIntent] = []
    history_closes: list[float] = []
    history_bars: list[dict[str, Any]] = []

    # Rebuild namespace with runtime bindings
    g = GState()
    g.data = dict(manifest.get("gState") or {})

    class DataView:
        pass

    data_view = DataView()

    def get_history(count: int, _freq: str, field: str, _symbol: str | None = None):
        n = int(count)
        rows = history_bars[-n:] if n > 0 else []
        # tiny DataFrame-like
        class _ILoc:
            def __init__(self, values: list[float]):
                self._v = values

            def __getitem__(self, idx: int) -> float:
                return self._v[idx]

        class Col:
            def __init__(self, values: list[float]):
                self._v = values
                self.iloc = _ILoc(values)

            def tail(self, k: int) -> "Col":
                return Col(self._v[-k:])

            def mean(self) -> float:
                return sum(self._v) / len(self._v) if self._v else float("nan")

            def __len__(self) -> int:
                return len(self._v)

        class Frame:
            def __init__(self, values: list[float]):
                self.close = Col(values)
                self.open = Col(values)
                self.high = Col(values)
                self.low = Col(values)
                self.volume = Col([0.0] * len(values))
                self._len = len(values)

            def __len__(self) -> int:
                return self._len

            def __getitem__(self, key: str) -> Col:
                if key == "close":
                    return self.close
                if key == "open":
                    return self.open
                if key == "high":
                    return self.high
                if key == "low":
                    return self.low
                if key == "volume":
                    return self.volume
                raise KeyError(key)

        if field != "close":
            # still return close series for simplicity in P0
            pass
        vals = [float(r.get("close") or 0) for r in rows]
        return Frame(vals)

    def get_position(symbol: str) -> Position:
        return broker.get_position(symbol)

    def get_positions() -> dict[str, Position]:
        return dict(broker.positions)

    def _queue(kind: str, symbol: str, value: float, reason: str = "") -> None:
        pending.append(
            OrderIntent(symbol=symbol, kind=kind, value=float(value), reason=reason or "")
        )

    def order_target_percent(symbol: str, pct: float, reason: str = "", **_k: Any) -> None:
        _queue("target_percent", symbol, pct, reason)

    def order_target(symbol: str, qty: float, reason: str = "", **_k: Any) -> None:
        _queue("target_quantity", symbol, qty, reason)

    def order_target_value(symbol: str, value: float, reason: str = "", **_k: Any) -> None:
        _queue("target_value", symbol, value, reason)

    def order(symbol: str, qty: float, reason: str = "", **_k: Any) -> None:
        _queue("quantity", symbol, qty, reason)

    def order_value(symbol: str, value: float, reason: str = "", **_k: Any) -> None:
        _queue("value", symbol, value, reason)

    def set_default_protection(**_k: Any) -> None:
        return None

    class RuntimeContext:
        def __init__(self) -> None:
            self.params = params

        def set_universe(self, *_a: Any, **_k: Any) -> None:
            return None

        def subscribe(self, *_a: Any, **_k: Any) -> None:
            return None

        def set_warmup(self, *_a: Any, **_k: Any) -> None:
            return None

        def set_benchmark(self, *_a: Any, **_k: Any) -> None:
            return None

        def allow_leverage(self, *_a: Any, **_k: Any) -> None:
            return None

        def set_metadata(self, **_k: Any) -> None:
            return None

    ns: dict[str, Any] = {
        "__builtins__": SAFE_BUILTINS,
        "g": g,
        "run_daily": lambda *a, **k: None,
        "run_weekly": lambda *a, **k: None,
        "run_monthly": lambda *a, **k: None,
        "get_history": get_history,
        "get_position": get_position,
        "get_positions": get_positions,
        "order": order,
        "order_value": order_value,
        "order_target": order_target,
        "order_target_value": order_target_value,
        "order_target_percent": order_target_percent,
        "set_default_protection": set_default_protection,
        "data": data_view,
    }
    exec(compile(code, "<strategy>", "exec"), ns, ns)
    handle_data = ns.get("handle_data")
    if not callable(handle_data):
        raise ContractError("backtest requires handle_data(context, data)")

    ctx = RuntimeContext()
    equity_curve: list[dict[str, Any]] = []
    warmup = int(manifest.get("warmupBars") or 0)

    for i, bar in enumerate(bars):
        ts = str(bar.get("timestamp") or bar.get("time") or i)
        o = float(bar.get("open") or bar.get("close") or 0)
        c = float(bar.get("close") or 0)
        marks = {symbol_key: c}

        # fill previous pending at open
        if pending:
            to_fill = pending
            pending = []
            for intent in to_fill:
                fill_px = o if o > 0 else c
                marks_open = {symbol_key: fill_px}
                broker.execute(intent, fill_px, ts, marks_open)

        history_bars.append(bar)
        history_closes.append(c)

        if i + 1 < warmup:
            equity_curve.append({"time": ts, "equity": broker.equity(marks)})
            continue

        try:
            handle_data(ctx, data_view)
        except Exception as e:
            raise ContractError(f"handle_data failed at {ts}: {e}") from e

        equity_curve.append({"time": ts, "equity": broker.equity(marks)})

    # drop leftover pending (no next open)
    metrics = _metrics(equity_curve, len(broker.trades))
    metrics["lastPosition"] = broker.get_position(symbol_key).amount
    return {
        "ok": True,
        "manifest": manifest,
        "equityCurve": equity_curve,
        "trades": broker.trades,
        "intents": broker.intents_log,
        # The final bar's instructions have no following open in a historical
        # replay, so they are deliberately not included in `trades`. Expose
        # them separately for the persistent paper/sandbox runtime.
        "pendingIntents": [
            {
                "symbol": intent.symbol,
                "kind": intent.kind,
                "value": intent.value,
                "reason": intent.reason,
            }
            for intent in pending
        ],
        "metrics": metrics,
        "primarySymbol": symbol_key,
    }


def main() -> None:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"invalid json: {e}"}))
        sys.exit(1)

    action = str(payload.get("action") or "compile").strip().lower()
    code = str(payload.get("strategyCode") or "")
    buf = io.StringIO()
    old = sys.stdout
    try:
        # keep protocol stdout clean — prints from strategy go to stderr capture via redirection? 
        # Strategy print hits real stdout; we accept stderrText empty for P0.
        if action == "compile":
            result = compile_strategy(code)
        elif action == "backtest":
            result = backtest_strategy(payload)
        else:
            result = {"ok": False, "error": f"unknown action: {action}"}
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result.get("ok") else 1)
    except ContractError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"internal: {e}"}, ensure_ascii=False))
        sys.exit(1)
    finally:
        sys.stdout = old


if __name__ == "__main__":
    main()
