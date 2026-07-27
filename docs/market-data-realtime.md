# 实时行情与微观结构

## HTTP API

- `GET /api/v1/market/quote`：最新价、买一卖一、成交量、成交额和新鲜度。
- `GET /api/v1/market/order-book`：统一五档盘口。
- `GET /api/v1/market/trades`：逐笔成交及主动买卖方向。
- `GET /api/v1/market/chip-distribution`：A 股筹码分布、获利比例、平均成本和 70%/90% 成本区间。
- `GET /api/v1/market/stream/metrics`：活跃流、监听者、重连、缺口、回补、平均/P95 延迟和陈旧事件。

所有接口遇到不支持的市场或不可用的数据源时显式失败，不生成虚假 Tick。

## WebSocket

连接后发送：

```json
{
  "action": "subscribe_market",
  "subscription": {
    "symbol": "BTCUSDT",
    "exchange": "CRYPTO",
    "timeframe": "1m",
    "channels": ["quote", "order_book", "trade", "bar"]
  }
}
```

取消订阅发送 `{"action":"unsubscribe_market"}`，保活发送 `{"action":"ping"}`。

服务端事件具有统一的 `kind`、`sequence`、`symbol`、`exchange`、`timeframe`、`source`、`emittedAt` 和 `data`。前端发现序列缺口时会重新加载历史 K 线；服务端在连接、重连和上游缺口后主动回补。

## Provider

- 加密货币默认连接 Binance 官方市场数据流 `wss://data-stream.binance.vision/stream`。
- A 股默认以东方财富报价、盘口和逐笔成交进行 2 秒轮询，历史接口失败时筹码计算回退到腾讯 K 线加东方财富流通股本。
- Futu 和 Interactive Brokers 通过外部行情桥接器接入：
  - `QUBIT_FUTU_MARKET_WS_URL`
  - `QUBIT_IB_MARKET_WS_URL`
  - `QUBIT_MARKET_STREAM_PROVIDER=futu|ib`
- 可用 `QUBIT_BINANCE_WS_URL` 覆盖 Binance WebSocket 地址。

Futu/IB 桥接器收到订阅消息后，应返回：

```json
{
  "kind": "quote",
  "sequence": 101,
  "timestamp": "2026-07-26T16:00:00.000Z",
  "data": {
    "lastPrice": 1297.41,
    "timestamp": "2026-07-26T16:00:00.000Z"
  }
}
```

桥接器断开时网关指数退避重连；序列或时间缺口触发历史回补。桥接器也会收到周期性 `ping`。
