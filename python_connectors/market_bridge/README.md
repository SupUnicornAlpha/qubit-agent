# Qubit broker market-data bridge

券商**行情** WebSocket 桥，与交易 HTTP 桥（`broker_http_server.py`）分离。

## 为何分离

| 路径 | 进程 | 职责 |
|------|------|------|
| 交易 | `broker_http_server.py` → `broker_gateway/*` | 下单、撤单、持仓、成交 |
| 行情 | `market_bridge.server` → `providers/*` | quote / trade / status 推流 |

同一券商（如 Futu）可同时跑两个进程：OpenD 交易上下文 ≠ OpenQuote 行情订阅。

## 启动（Futu）

```bash
cd python_connectors
pip install websockets futu-api
# OpenD 已启动且有行情权限
export QUBIT_FUTU_OPEND_HOST=127.0.0.1
export QUBIT_FUTU_OPEND_PORT=11111
python -m market_bridge.server --provider futu --port 8765
```

Bun / 运行时：

```bash
export QUBIT_FUTU_MARKET_WS_URL=ws://127.0.0.1:8765
# 可选强制：
export QUBIT_MARKET_STREAM_PROVIDER=futu
```

## 扩展新券商

1. 在 `providers/` 实现 `start/stop/subscribe/unsubscribe`，通过 `emit(event)` 推送。
2. 在 `server.py` `_build_provider` 注册 id。
3. 在 TS `broker-market-bridge.ts` 的 `BUILTIN`（或 `registerBrokerMarketBridge`）增加描述符与 env key。
4. 控制面自动出现对应 `*_bridge` L2 源（见 `market-data-source-control.ts`）。

事件契约见仓库根目录 `docs/market-data-realtime.md`。

## 同花顺 / IB

当前为**槽位 stub**：可连上 WS、收 subscribe、回 status，不伪造价格。交易仍走 `provider=supermind|ib`。
