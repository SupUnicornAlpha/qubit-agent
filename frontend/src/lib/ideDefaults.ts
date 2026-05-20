/**
 * 指标 IDE 默认示例脚本：对应后端 python_strategy_backtest_runner.py 的协议。
 * - on_init(ctx) 可选，用来准备跨 bar 状态（写到 ctx.state）。
 * - on_bar(ctx, bar) 在每根 K 线被调用，可读取 ctx.position/cash/equity，
 *   并通过 ctx.buy(qty 比例, 0~1) / ctx.sell(qty 比例) / ctx.close() 下单（按当根 close 撮合）。
 * - 工具：ctx.sma(values, period) / ctx.ema(values, period) / ctx.atr(highs, lows, closes, period)。
 */
export const DEFAULT_IDE_STRATEGY_SOURCE = `# AAPL 趋势跟随 + ATR 风控 示例
# - 入场：close 上穿 20MA 且偏离不超过 1.5%
# - 加止损：止损位 = entry - ATR(14) * 2，跌破后全平
# - 加止盈：盈利达 ATR(14) * 3.5 后全平

CLOSES, HIGHS, LOWS = [], [], []

def on_init(ctx):
    # 用 ctx.state 记录跨 bar 的入场价/止损/止盈
    ctx.state["entry_price"] = 0.0
    ctx.state["stop"] = 0.0
    ctx.state["target"] = 0.0

def on_bar(ctx, bar):
    CLOSES.append(float(bar["close"]))
    HIGHS.append(float(bar["high"]))
    LOWS.append(float(bar["low"]))
    n = len(CLOSES)
    if n < 25:  # 暖机
        return

    ma20 = ctx.sma(CLOSES, 20)
    atr14 = ctx.atr(HIGHS, LOWS, CLOSES, 14)
    price = CLOSES[-1]

    # 平仓判断
    if ctx.position > 0:
        if price <= ctx.state["stop"] or price >= ctx.state["target"]:
            ctx.close()
            ctx.state["entry_price"] = 0.0
            ctx.state["stop"] = 0.0
            ctx.state["target"] = 0.0
        return

    # 入场判断
    if price > ma20 and abs(price - ma20) / ma20 <= 0.015:
        ctx.buy(qty=1.0)  # all-in（按当根 close 撮合，commission 自动扣）
        ctx.state["entry_price"] = price
        ctx.state["stop"] = price - atr14 * 2.0
        ctx.state["target"] = price + atr14 * 3.5
`;

/** 与 POST /api/v1/market/backtests/python 一致的 Python 信号模板（output["buy"] / output["sell"]） */
export const DEFAULT_PYTHON_SIGNAL_STRATEGY = `# output 必须写入 buy/sell 两个等长 bool 数组
# bars: [{ open, high, low, close, volume, timestamp }, ...]
closes = [float(x.get("close", 0.0)) for x in bars]

def sma(xs, period):
    out = [False] * len(xs)
    vals = [0.0] * len(xs)
    if period <= 0:
        return vals
    for i in range(len(xs)):
        if i + 1 < period:
            vals[i] = 0.0
        else:
            s = 0.0
            for j in range(period):
                s += xs[i - j]
            vals[i] = s / period
    return vals

fast = sma(closes, 5)
slow = sma(closes, 20)
buy = [False] * len(closes)
sell = [False] * len(closes)
for i in range(1, len(closes)):
    cross_up = fast[i - 1] <= slow[i - 1] and fast[i] > slow[i]
    cross_down = fast[i - 1] >= slow[i - 1] and fast[i] < slow[i]
    buy[i] = bool(cross_up)
    sell[i] = bool(cross_down)

output["buy"] = buy
output["sell"] = sell
`;

