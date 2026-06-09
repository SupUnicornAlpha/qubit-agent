# Broker Gateway — Paper / Live Trading Runbook

Bun runtime 通过 `qubit-broker` connector → `executeIntentLive` → 这个 HTTP bridge（`python_connectors/broker_http_server.py`）→ 这里的 adapter 调真实券商。

## 支持的 Provider

| Provider | 资产 | Paper 模式 | 文件 | 状态 |
|---|---|---|---|---|
| `alpaca` | 美股 | Alpaca paper trading | `alpaca.py` | ✅ 注册即用、无身份证 |
| `futu` | 港 / 美股 | 富途模拟账号 | `futu.py` | ✅ 需装 OpenD + 富途账号 |
| `ib` | 全资产含期权 | IB Paper Trading | `ib.py` | ✅ 需装 TWS/IB Gateway + IB 账号 |
| `ccxt` | 加密 | Exchange testnet | `ccxt_adapter.py` | ✅ 注册即用 |

---

## 1. Alpaca Paper Trading（推荐起步）

### 1.1 注册

1. 访问 https://alpaca.markets/
2. Sign Up → 填邮箱 → 不需身份证（paper 账号不需要 KYC）
3. Dashboard → Paper Trading → API Keys → **Generate New Key**
4. 拷贝 `APCA-API-KEY-ID`（PK 开头）和 `APCA-API-SECRET-KEY`

### 1.2 启动 broker_http_server

```bash
# 依赖
pip install requests

# env
export QUBIT_BROKER_PROVIDER=alpaca
export QUBIT_BROKER_PAPER=1
export ALPACA_API_KEY_ID=PKxxxxxxxxxxxxxxxxxx
export ALPACA_API_SECRET=xxxxxxxxxxxxxxxxxxxx
# 可选：覆盖 base_url，默认走 paper-api.alpaca.markets
# export ALPACA_BASE_URL=https://paper-api.alpaca.markets

# 启动
cd python_connectors
python broker_http_server.py --port 9100
```

健康检查：

```bash
curl 'http://127.0.0.1:9100/health?provider=alpaca'
# {"healthy":true,"message":"alpaca paper ok","account_status":"ACTIVE","buying_power":"100000",...}
```

### 1.3 配置 dev server 的 broker_account

```bash
DB="$HOME/Library/Application Support/app.qubit.agent/db/core.sqlite"

sqlite3 "$DB" <<SQL
INSERT OR REPLACE INTO broker_account (
  id, provider, account_ref, mode, base_url, provider_config_json, is_default, enabled
) VALUES (
  'alpaca-paper-default',
  'alpaca',
  'paper_default',
  'sandbox',
  'http://127.0.0.1:9100',
  '{"baseUrl":"https://paper-api.alpaca.markets"}',
  1, 1
);
SQL
```

### 1.4 验证：发一单

让 trader agent 出 intent，或者直接调内部 builtin tool：

```bash
# 等同于 trader_agent 调 order.create_intent + qubit-broker.submit_order
# 1) 先建 intent_order
INTENT_ID=$(uuidgen | tr A-Z a-z)
sqlite3 "$DB" "
INSERT INTO intent_order (id, workflow_run_id, ticker, direction, quantity, target_price, rationale, status, risk_approved_at)
VALUES ('$INTENT_ID', 'manual-test', 'AAPL', 'long', 1, 100, 'smoke test', 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
"

# 2) 调 qubit-broker.submit_order via dev server
curl -X POST http://127.0.0.1:17385/api/v1/tools/qubit-broker.submit_order \
  -H 'content-type: application/json' \
  -d "{
    \"id\": \"intent-$INTENT_ID\",
    \"ticker\": \"AAPL\",
    \"side\": \"buy\",
    \"quantity\": 1,
    \"orderType\": \"limit\",
    \"limitPrice\": 100,
    \"metadata\": {
      \"intentOrderId\": \"$INTENT_ID\",
      \"provider\": \"alpaca\",
      \"executionMode\": \"sandbox\"
    }
  }"
```

成功后查 `broker_order_event` / `execution_report` 表，应看到 `broker_order_id` 是 Alpaca 真返回的 UUID。

---

## 2. 富途 OpenD + 模拟账号

### 2.1 安装

1. 下载 OpenD：https://www.futunn.com/download/openAPI
2. 启动 OpenD → 登录富途账号（注册：https://www.futunn.com/）
3. OpenD 控制台 → 「模拟交易」开关打开
4. 默认监听 `127.0.0.1:11111`（不要改）

### 2.2 启动 broker_http_server

```bash
pip install futu-api requests
export QUBIT_BROKER_PROVIDER=futu
export QUBIT_BROKER_PAPER=1
export QUBIT_FUTU_OPEND_HOST=127.0.0.1
export QUBIT_FUTU_OPEND_PORT=11111

cd python_connectors
python broker_http_server.py --port 9100
```

### 2.3 配置 broker_account

```sql
INSERT OR REPLACE INTO broker_account (
  id, provider, account_ref, mode, base_url, provider_config_json, is_default, enabled
) VALUES (
  'futu-paper-default',
  'futu',
  'paper_default',
  'sandbox',
  'http://127.0.0.1:9100',
  '{"opendHost":"127.0.0.1","opendPort":11111,"market":"US"}',
  0, 1
);
```

---

## 3. IB Paper Trading（期权路线必备）

1. 注册 IB 账号（要 KYC）：https://www.interactivebrokers.com/
2. 在 Account Management 申请 paper account
3. 装 TWS 或 IB Gateway，启动后 paper 默认监听 `127.0.0.1:7497`
4. Settings → API → Enable ActiveX and Socket Clients

```bash
pip install ib_insync requests
export QUBIT_BROKER_PROVIDER=ib
export QUBIT_BROKER_PAPER=1
export QUBIT_IB_HOST=127.0.0.1
export QUBIT_IB_PORT=7497
export QUBIT_IB_CLIENT_ID=1

cd python_connectors
python broker_http_server.py --port 9100
```

---

## 4. 切换 / 同时跑多 provider

`broker_account` 是按 provider 唯一 default 的，可以同时配多个：

```sql
SELECT id, provider, mode, is_default, enabled FROM broker_account;
-- alpaca-paper-default | alpaca | sandbox | 1 | 1
-- futu-paper-default   | futu   | sandbox | 1 | 1
-- ib-paper-default     | ib     | sandbox | 1 | 1
```

调用方在 metadata 里传 `provider` 决定走哪个：

```ts
await qubitBroker.submitOrder(intent, {
  metadata: { provider: "alpaca", executionMode: "sandbox", intentOrderId },
});
```

不传时 `QUBIT_BROKER_PROVIDER` env 兜底。

---

## 5. 调试 / 常见问题

| 现象 | 排查 |
|---|---|
| `simulated healthy` | 缺 key 或缺 SDK；装包 + 配 env |
| `attempt to write a readonly database` | broker_http_server 是 read-only，不应该写 DB；写 DB 是 bun runtime 干的事，检查是不是配错 |
| Alpaca 401 | API key/secret 错；注意 paper key 与 live key 不通用 |
| Alpaca 422 unprocessable | `qty` 必须是字符串，limit_price 也是字符串；symbol 大写 |
| Futu `ret=-1 OpenD not found` | OpenD 没启动 / 端口不对 |
| IB `Connection refused` | TWS/Gateway 没开 / API 没启用 |

