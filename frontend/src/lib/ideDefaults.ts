/** 指标 IDE 默认示例脚本（占位，后续可接 Monaco / 策略执行） */
export const DEFAULT_IDE_STRATEGY_SOURCE = `# 示例：双均线信号（与回测引擎 SMA 交叉语义相近，仅供编辑/带入对话）
def on_bar(bar, ctx):
    fast = ctx.series("close").ema(5)
    slow = ctx.series("close").ema(20)
    if fast > slow:
        return "long"
    if fast < slow:
        return "flat"
    return None
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

