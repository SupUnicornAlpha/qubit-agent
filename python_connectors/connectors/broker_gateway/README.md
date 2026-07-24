# Broker Gateway — Paper / Live Trading Runbook

Bun runtime 通过 `qubit-broker` connector → `executeIntentLive` → 这个 HTTP bridge（`python_connectors/broker_http_server.py`）→ 这里的 adapter 调真实券商。

## 支持的 Provider

| Provider | 资产 | Paper 模式 | 文件 | 状态 |
|---|---|---|---|---|
| `alpaca` | 美股 | Alpaca paper trading | `alpaca.py` | ✅ 注册即用、无身份证 |
| `futu` | 港 / 美股 | 富途模拟账号 | `futu.py` | ✅ 需装 OpenD + 富途账号 |
| `ib` | 全资产含期权 | IB Paper Trading | `ib.py` | ✅ 需装 TWS/IB Gateway + IB 账号 |
| `ccxt` | 加密 | Exchange testnet | `ccxt_adapter.py` | ✅ 注册即用 |
| `supermind` | A 股 | 取决于同花顺账户权限 | `supermind.py` | ✅ 需 SuperMind 客户端与交易权限 |
| `eastmoney_emt` | A 股 | 取决于 EMT 柜台权限 | `eastmoney_emt.py` | ✅ Windows + VeighNa EMT |

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
python broker_http_server.py
```

健康检查：

```bash
curl 'http://127.0.0.1:18765/health?provider=alpaca'
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
  'http://127.0.0.1:18765',
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
python broker_http_server.py
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
  'http://127.0.0.1:18765',
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
python broker_http_server.py
```

---

## 4. 同花顺 SuperMind

同花顺接入使用 SuperMind 本地 `TradeAPI`。HTTP Sidecar 必须运行在已安装 SuperMind SDK、
已登录客户端且已开通交易权限的环境中；SDK 缺失时健康检查会明确返回 `down`，不会模拟成功。

```json
{
  "provider": "supermind",
  "accountRef": "ths-live",
  "mode": "live",
  "baseUrl": "http://127.0.0.1:18765",
  "providerConfig": {
    "accountId": "你的资金账户",
    "market": "CN"
  }
}
```

在 SuperMind Python 环境启动：

```bash
cd python_connectors
python broker_http_server.py
```

支持健康检查、委托、撤单、订单查询、成交查询和持仓查询。A 股卖出数量由适配器转换为负数；
限价单必须提供 `limitPrice`。市价委托默认调用 SuperMind 的最新价下单；如需智能委托，
可配置官方 `pricetype`（例如 `3` 为最新价、`17` 为市价）。

## 5. 东方财富 EMT

东方财富接入基于 VeighNa `vnpy_emt.EmtGateway`。该网关依赖东方财富 EMT 柜台授权和
Windows 原生交易 SDK，因此建议在 Windows 主机单独运行 Sidecar，QUBIT 主进程仍可运行在
macOS/Linux，通过内网 HTTP 调用。

```powershell
pip install vnpy vnpy_emt
$env:QUBIT_EMT_CONNECTION_JSON='{"用户名":"...","密码":"...","客户端号":1}'
$env:QUBIT_BROKER_HOST='0.0.0.0'
$env:QUBIT_BROKER_AUTH_TOKEN='生成一个高强度随机值'
python broker_http_server.py
```

账户配置：

```json
{
  "provider": "eastmoney_emt",
  "accountRef": "emt-live",
  "mode": "live",
  "baseUrl": "http://windows-sidecar:18765",
  "providerConfig": {
    "connectionSettingEnv": "QUBIT_EMT_CONNECTION_JSON",
    "connectWaitSeconds": 2,
    "market": "CN"
  }
}
```

`connectionSetting` 的字段名称随 EMT/VeighNa 插件版本变化，必须以当前环境
`EmtGateway.default_setting` 为准。生产环境推荐 `connectionSettingEnv`，避免把密码写入
SQLite；管理界面仍支持直接填写 JSON，便于本地联调。跨主机监听时请在 QUBIT 后端与
Windows Sidecar 同时配置相同的 `QUBIT_BROKER_AUTH_TOKEN`，只开放可信内网，并通过主机
防火墙限制 QUBIT 服务端 IP；默认仍只监听 `127.0.0.1`。

## 6. 切换 / 同时跑多 provider

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

## 7. 调试 / 常见问题

| 现象 | 排查 |
|---|---|
| `simulated healthy` | 缺 key 或缺 SDK；装包 + 配 env |
| `attempt to write a readonly database` | broker_http_server 是 read-only，不应该写 DB；写 DB 是 bun runtime 干的事，检查是不是配错 |
| Alpaca 401 | API key/secret 错；注意 paper key 与 live key 不通用 |
| Alpaca 422 unprocessable | `qty` 必须是字符串，limit_price 也是字符串；symbol 大写 |
| Futu `ret=-1 OpenD not found` | OpenD 没启动 / 端口不对 |
| IB `Connection refused` | TWS/Gateway 没开 / API 没启用 |
| SuperMind SDK 不可用 | Sidecar 不在 SuperMind Python 环境，或客户端/交易权限未开通 |
| EMT SDK 不可用 | 必须在 Windows 安装 `vnpy`、`vnpy_emt` 并申请 EMT 柜台权限 |
| EMT connectionSetting required | 配置 `connectionSettingEnv`，或按 `EmtGateway.default_setting` 填 JSON |
