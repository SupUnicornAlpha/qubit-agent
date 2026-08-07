# @param period int 20 MA period range=5:100:5
# @param target_pct float 0.95 Target weight range=0.1:1.0:0.05
"""
Qubit Strategy API V2 — MA cross demo (Prime 06).

Compile: strategy.compile / POST /api/v1/quant/strategy-contract/compile
Backtest: strategy.contract_backtest
Paper: strategy.paper_deploy → strategy.paper_run (fixed paper capital)
"""


def initialize(context):
    g.symbol = "US:SPY"
    context.set_universe([g.symbol])
    context.subscribe(frequency="1d", fields=["open", "high", "low", "close", "volume"])
    context.set_warmup(60)
    context.set_benchmark("US:SPY")
    context.set_metadata(name="ma_cross_spy", demo=True)


def handle_data(context, data):
    period = int(context.params["period"])
    bars = get_history(period + 1, "1d", "close", g.symbol)
    if len(bars) < period:
        return
    price = float(bars["close"].iloc[-1])
    ma = float(bars["close"].tail(period).mean())
    pos = get_position(g.symbol)
    desired = float(context.params["target_pct"]) if price > ma else 0.0
    if desired > 0 and pos.amount <= 0:
        order_target_percent(g.symbol, desired, reason="ma_entry")
    elif desired == 0 and pos.amount > 0:
        order_target_percent(g.symbol, 0.0, reason="ma_exit")
