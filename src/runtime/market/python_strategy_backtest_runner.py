#!/usr/bin/env python3
"""
Bar-by-bar 策略回测 runtime。

约定（与前端 IDE 默认模板一致）：
- 用户脚本必须定义 on_bar(ctx, bar)；可选 on_init(ctx)。
- ctx.buy(qty=1.0)：开多 / 加仓（按当前 close 入场，受手续费/可用资金限制）。
- ctx.sell(qty=1.0)：平掉指定数量多头；qty<=0 视为全平。
- ctx.close()：全平当前持仓。
- ctx.position：当前持仓股数（float，long-only 简化版）。
- ctx.cash：当前现金。
- ctx.equity：当前权益（cash + position * close）。
- bar = { open, high, low, close, volume, timestamp }
- 工具函数：ctx.sma(closes, period) / ctx.ema(closes, period) / ctx.atr(highs, lows, closes, period)

输入 JSON（stdin）:
{
  "strategyCode": "<python source>",
  "bars": [...],
  "initialCapital": 10000,
  "commission": 0.001
}

输出 JSON（stdout）:
{
  "ok": true,
  "equityCurve": [{"time": "...", "equity": 1234.5}, ...],
  "trades": [{"time": "...", "side": "buy"|"sell", "qty": ..., "price": ..., "fee": ...}, ...],
  "metrics": {
    "totalReturnPct": ...,
    "maxDrawdownPct": ...,
    "sharpeApprox": ...,
    "tradeCount": ...,
    "bars": ...,
    "lastPosition": ...
  },
  "stderrText": "<runtime print buffer>"
}
失败:
{ "ok": false, "error": "..." , "stderrText": "..." }
"""

from __future__ import annotations

import io
import json
import math
import sys
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


def _sma(values: list[float], period: int) -> float:
    if period <= 0 or len(values) < period:
        return float("nan")
    window = values[-period:]
    return sum(window) / period


def _ema(values: list[float], period: int) -> float:
    if period <= 0 or len(values) == 0:
        return float("nan")
    k = 2.0 / (period + 1.0)
    e = values[0]
    for v in values[1:]:
        e = v * k + e * (1.0 - k)
    return e


def _atr(highs: list[float], lows: list[float], closes: list[float], period: int) -> float:
    n = min(len(highs), len(lows), len(closes))
    if period <= 0 or n < period + 1:
        return float("nan")
    trs: list[float] = []
    for i in range(n - period, n):
        if i <= 0:
            tr = highs[i] - lows[i]
        else:
            tr = max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]),
            )
        trs.append(tr)
    return sum(trs) / period if trs else float("nan")


class StrategyContext:
    def __init__(self, initial_cash: float, commission: float):
        self._initial_cash = float(initial_cash)
        self._cash = float(initial_cash)
        self._position: float = 0.0
        self._commission = float(max(0.0, commission))
        self._last_close: float = 0.0
        self._last_time: str = ""
        self._pending: list[dict[str, Any]] = []
        self.trades: list[dict[str, Any]] = []
        self.equity_curve: list[dict[str, Any]] = []
        self.state: dict[str, Any] = {}  # 给用户做跨 bar 状态用

    # ---- 信号 API ----
    def buy(self, qty: float = 1.0) -> None:
        try:
            qty_f = float(qty)
        except Exception:
            qty_f = 1.0
        if qty_f <= 0:
            return
        self._pending.append({"side": "buy", "qty": qty_f})

    def sell(self, qty: float = 1.0) -> None:
        try:
            qty_f = float(qty)
        except Exception:
            qty_f = 0.0
        self._pending.append({"side": "sell", "qty": qty_f})

    def close(self) -> None:
        self._pending.append({"side": "sell", "qty": 0.0})  # qty<=0 => 全平

    # ---- 状态属性 ----
    @property
    def position(self) -> float:
        return self._position

    @property
    def cash(self) -> float:
        return self._cash

    @property
    def equity(self) -> float:
        return self._cash + self._position * self._last_close

    # ---- 指标工具 ----
    @staticmethod
    def sma(values: list[float], period: int) -> float:
        return _sma(list(values), int(period))

    @staticmethod
    def ema(values: list[float], period: int) -> float:
        return _ema(list(values), int(period))

    @staticmethod
    def atr(highs: list[float], lows: list[float], closes: list[float], period: int) -> float:
        return _atr(list(highs), list(lows), list(closes), int(period))

    # ---- 内部：把 pending 信号按收盘价撮合 ----
    def _settle(self, bar_time: str, bar_close: float) -> None:
        self._last_close = float(bar_close)
        self._last_time = bar_time
        for sig in self._pending:
            side = sig["side"]
            qty = float(sig["qty"])
            if side == "buy":
                # 用 (cash * (1-fee)) / price 限定可买数量
                if bar_close <= 0 or self._cash <= 0:
                    continue
                # qty 视为相对单位：qty=1.0 表示用全部可用现金 all-in
                budget = self._cash * min(max(qty, 0.0), 1.0)
                fee = budget * self._commission
                shares = (budget - fee) / bar_close
                if shares <= 0:
                    continue
                self._cash -= budget
                self._position += shares
                self.trades.append(
                    {
                        "time": bar_time,
                        "side": "buy",
                        "qty": shares,
                        "price": bar_close,
                        "fee": fee,
                    }
                )
            elif side == "sell":
                if self._position <= 0:
                    continue
                # qty<=0 => 全平；否则 qty 视为相对比例
                ratio = 1.0 if qty <= 0 else min(qty, 1.0)
                shares = self._position * ratio
                gross = shares * bar_close
                fee = gross * self._commission
                self._cash += gross - fee
                self._position -= shares
                self.trades.append(
                    {
                        "time": bar_time,
                        "side": "sell",
                        "qty": shares,
                        "price": bar_close,
                        "fee": fee,
                    }
                )
        self._pending.clear()


def _compute_metrics(equity_curve: list[dict[str, Any]], initial: float, trades: int) -> dict[str, Any]:
    if not equity_curve:
        return {
            "totalReturnPct": 0.0,
            "maxDrawdownPct": 0.0,
            "sharpeApprox": 0.0,
            "tradeCount": trades,
            "bars": 0,
        }
    first = float(equity_curve[0]["equity"]) or initial
    last = float(equity_curve[-1]["equity"])
    total_return = ((last - first) / first) * 100.0 if first > 0 else 0.0
    peak = first
    max_dd = 0.0
    for p in equity_curve:
        eq = float(p["equity"])
        if eq > peak:
            peak = eq
        dd = (peak - eq) / peak if peak > 0 else 0.0
        if dd > max_dd:
            max_dd = dd
    rets: list[float] = []
    for i in range(1, len(equity_curve)):
        a = float(equity_curve[i - 1]["equity"])
        b = float(equity_curve[i]["equity"])
        if a > 1e-8:
            rets.append((b - a) / a)
    sharpe = 0.0
    if len(rets) > 2:
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / len(rets)
        std = math.sqrt(var) if var > 0 else 1e-9
        sharpe = (mean / std) * math.sqrt(min(252, len(rets)))
    return {
        "totalReturnPct": total_return,
        "maxDrawdownPct": max_dd * 100.0,
        "sharpeApprox": sharpe,
        "tradeCount": trades,
        "bars": len(equity_curve),
    }


def main() -> None:
    raw_stderr = io.StringIO()

    try:
        payload = json.loads(sys.stdin.read() or "{}")
        code = str(payload.get("strategyCode") or "").strip()
        bars = payload.get("bars") or []
        initial = float(payload.get("initialCapital") or 10_000)
        commission = float(payload.get("commission") or 0.0)
        if not code:
            raise ValueError("strategyCode is required")
        if not isinstance(bars, list) or not bars:
            raise ValueError("bars is required")

        ctx = StrategyContext(initial_cash=initial, commission=commission)

        # 暴露给用户的全局：受限 builtins + math + ctx helpers
        # 注意：必须把 globals 和 locals 用同一个 dict，否则在用户脚本顶层定义的全局变量
        # 不会被脚本内函数的 __globals__ 看到（典型 exec 双 dict 坑）。
        user_ns: dict[str, Any] = {
            "__builtins__": SAFE_BUILTINS,
            "math": math,
        }

        # 重定向 print 到缓冲（避免污染 stdout 的 JSON 输出）
        original_stdout = sys.stdout
        sys.stdout = raw_stderr
        try:
            exec(code, user_ns)
        finally:
            sys.stdout = original_stdout

        on_init: Callable[[Any], None] | None = user_ns.get("on_init")
        on_bar: Callable[[Any, Any], None] | None = user_ns.get("on_bar")
        if not callable(on_bar):
            raise ValueError("脚本必须定义 on_bar(ctx, bar)")

        sys.stdout = raw_stderr
        try:
            if callable(on_init):
                on_init(ctx)

            for bar in bars:
                if not isinstance(bar, dict):
                    continue
                bar_time = str(bar.get("timestamp") or bar.get("time") or "")
                bar_close = float(bar.get("close") or 0.0)
                on_bar(ctx, bar)
                ctx._settle(bar_time, bar_close)
                ctx.equity_curve.append({"time": bar_time, "equity": ctx.equity})
        finally:
            sys.stdout = original_stdout

        metrics = _compute_metrics(ctx.equity_curve, initial, len(ctx.trades))
        metrics["lastPosition"] = ctx.position

        sys.stdout.write(
            json.dumps(
                {
                    "ok": True,
                    "equityCurve": ctx.equity_curve,
                    "trades": ctx.trades,
                    "metrics": metrics,
                    "stderrText": raw_stderr.getvalue()[-4000:],
                }
            )
        )
    except Exception as e:  # noqa: BLE001
        sys.stdout.write(
            json.dumps(
                {
                    "ok": False,
                    "error": str(e),
                    "stderrText": raw_stderr.getvalue()[-4000:],
                }
            )
        )


if __name__ == "__main__":
    main()
