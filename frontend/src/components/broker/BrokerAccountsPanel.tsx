import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useState } from "react";
import { checkBrokerHealth, listBrokerAccounts, listBrokerEvents, upsertBrokerAccount } from "../../api/backend";
import type {
  BrokerAccountRecord,
  BrokerOrderEventRecord,
  BrokerProviderConfig,
  CcxtProviderConfig,
  FutuProviderConfig,
  IbProviderConfig,
} from "../../api/types";

const wrap: CSSProperties = {
  maxWidth: 960,
};

const title: CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  margin: "0 0 8px",
  color: "var(--qb-body-fg, #fafafa)",
};

const lead: CSSProperties = {
  fontSize: 13,
  color: "var(--qb-main-meta, #a1a1aa)",
  margin: "0 0 20px",
  lineHeight: 1.55,
};

const row: CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "flex-end",
  flexWrap: "wrap",
  marginBottom: 14,
};

const field: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 120 };

const label: CSSProperties = {
  fontSize: 11,
  color: "var(--qb-main-meta, #a1a1aa)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const input: CSSProperties = {
  background: "var(--qb-main-input-bg, #18181b)",
  border: "1px solid var(--qb-main-input-border, #3f3f46)",
  borderRadius: 6,
  color: "var(--qb-main-input-fg, #e4e4e7)",
  padding: "8px 10px",
  fontSize: 13,
  minWidth: 140,
};

const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 };

const th: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--qb-main-input-border, #3f3f46)",
  color: "var(--qb-main-meta, #a1a1aa)",
  fontWeight: 600,
};

const td: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--qb-sidebar-border, #27272a)",
  color: "var(--qb-body-fg, #d4d4d8)",
  verticalAlign: "top",
};

const sectionTitle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--qb-body-fg, #e4e4e7)",
  margin: "24px 0 8px",
};

const statusColor = (s: BrokerAccountRecord["healthStatus"]): string => {
  switch (s) {
    case "healthy":
      return "#22c55e";
    case "degraded":
      return "#f59e0b";
    case "down":
      return "#ef4444";
    default:
      return "#71717a";
  }
};

function buildProviderConfig(
  provider: "futu" | "ib" | "ccxt",
  futu: FutuProviderConfig,
  ib: IbProviderConfig,
  ccxt: CcxtProviderConfig
): BrokerProviderConfig {
  if (provider === "futu") {
    return {
      opendHost: futu.opendHost?.trim() || "127.0.0.1",
      opendPort: futu.opendPort ?? 11111,
      market: futu.market,
      accId: futu.accId?.trim() || undefined,
    };
  }
  if (provider === "ccxt") {
    return {
      exchangeId: ccxt.exchangeId?.trim() || "binance",
      sandbox: ccxt.sandbox ?? false,
      defaultType: ccxt.defaultType ?? "spot",
      market: "CRYPTO",
      apiKeyRef: ccxt.apiKeyRef?.trim() || undefined,
    };
  }
  return {
    host: ib.host?.trim() || "127.0.0.1",
    port: ib.port ?? 7497,
    clientId: ib.clientId ?? 1,
    accountId: ib.accountId?.trim() || undefined,
  };
}

export const BrokerAccountsPanel: FC = () => {
  const [provider, setProvider] = useState<"futu" | "ib" | "ccxt">("futu");
  const [accountRef, setAccountRef] = useState("default");
  const [mode, setMode] = useState<"mock" | "sandbox" | "live">("mock");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:18765");
  const [isDefault, setIsDefault] = useState(true);
  const [futuConfig, setFutuConfig] = useState<FutuProviderConfig>({
    opendHost: "127.0.0.1",
    opendPort: 11111,
    market: "HK",
  });
  const [ibConfig, setIbConfig] = useState<IbProviderConfig>({
    host: "127.0.0.1",
    port: 7497,
    clientId: 1,
  });
  const [ccxtConfig, setCcxtConfig] = useState<CcxtProviderConfig>({
    exchangeId: "binance",
    sandbox: true,
    defaultType: "spot",
    market: "CRYPTO",
  });
  const [accounts, setAccounts] = useState<BrokerAccountRecord[]>([]);
  const [events, setEvents] = useState<BrokerOrderEventRecord[]>([]);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [acc, ev] = await Promise.all([listBrokerAccounts(), listBrokerEvents(undefined, 40)]);
      setAccounts(acc);
      setEvents(ev);
      setStatusLine(null);
    } catch (e) {
      setStatusLine(`加载失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadAccountIntoForm = (a: BrokerAccountRecord) => {
    setProvider(a.provider);
    setAccountRef(a.accountRef);
    setMode(a.mode);
    setBaseUrl(a.baseUrl ?? "");
    setIsDefault(a.isDefault ?? false);
    const cfg = a.providerConfigJson ?? {};
    if (a.provider === "futu") {
      setFutuConfig({
        opendHost: (cfg as FutuProviderConfig).opendHost ?? "127.0.0.1",
        opendPort: (cfg as FutuProviderConfig).opendPort ?? 11111,
        market: (cfg as FutuProviderConfig).market ?? "HK",
        accId: (cfg as FutuProviderConfig).accId,
      });
    } else if (a.provider === "ccxt") {
      setCcxtConfig({
        exchangeId: (cfg as CcxtProviderConfig).exchangeId ?? "binance",
        sandbox: (cfg as CcxtProviderConfig).sandbox ?? true,
        defaultType: (cfg as CcxtProviderConfig).defaultType ?? "spot",
        market: "CRYPTO",
        apiKeyRef: (cfg as CcxtProviderConfig).apiKeyRef,
      });
    } else {
      setIbConfig({
        host: (cfg as IbProviderConfig).host ?? "127.0.0.1",
        port: (cfg as IbProviderConfig).port ?? 7497,
        clientId: (cfg as IbProviderConfig).clientId ?? 1,
        accountId: (cfg as IbProviderConfig).accountId,
      });
    }
  };

  const saveAccount = async () => {
    setStatusLine(null);
    try {
      await upsertBrokerAccount({
        provider,
        accountRef: accountRef.trim() || "default",
        mode,
        baseUrl: mode === "mock" ? undefined : baseUrl.trim() || undefined,
        providerConfig: buildProviderConfig(provider, futuConfig, ibConfig, ccxtConfig),
        isDefault,
        enabled: true,
      });
      await refresh();
      setStatusLine("已保存券商账户配置。");
    } catch (e) {
      setStatusLine(`保存失败：${(e as Error).message}`);
    }
  };

  const runHealthCheck = async () => {
    setStatusLine(null);
    try {
      const out = await checkBrokerHealth({
        provider,
        accountRef: accountRef.trim() || "default",
      });
      setStatusLine(`健康检查 · ${out.provider} · ${out.status} · ${out.message}`);
      await refresh();
    } catch (e) {
      setStatusLine(`健康检查失败：${(e as Error).message}`);
    }
  };

  return (
    <div style={wrap}>
      <h2 style={title}>券商账户配置</h2>
      <p style={lead}>
        登记富途（Futu OpenD）、盈透（IB Gateway）或加密货币（CCXT / Binance 等）连接参数。{" "}
        <strong>mock</strong> 为后端本地模拟；<strong>sandbox</strong> 对应富途模拟盘（TrdEnv.SIMULATE）；{" "}
        <strong>live</strong> 为实盘。非 mock 模式需填写 HTTP 桥地址（默认{" "}
        <code style={{ fontSize: 12 }}>http://127.0.0.1:18765</code>）并运行{" "}
        <code style={{ fontSize: 12 }}>python broker_http_server.py</code>。
      </p>

      <div style={row}>
        <div style={field}>
          <span style={label}>券商</span>
          <select
            style={input}
            value={provider}
            onChange={(e) => setProvider(e.target.value as "futu" | "ib" | "ccxt")}
          >
            <option value="futu">Futu 富途</option>
            <option value="ib">Interactive Brokers</option>
            <option value="ccxt">CCXT 加密货币</option>
          </select>
        </div>
        <div style={field}>
          <span style={label}>账户引用</span>
          <input
            style={input}
            value={accountRef}
            onChange={(e) => setAccountRef(e.target.value)}
            placeholder="default"
            autoComplete="off"
          />
        </div>
        <div style={field}>
          <span style={label}>运行模式</span>
          <select style={input} value={mode} onChange={(e) => setMode(e.target.value as "mock" | "sandbox" | "live")}>
            <option value="mock">mock · 本地模拟</option>
            <option value="sandbox">sandbox · 券商模拟盘</option>
            <option value="live">live · 实盘</option>
          </select>
        </div>
        <label style={{ ...field, flexDirection: "row", alignItems: "center", gap: 8, minWidth: "auto" }}>
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          <span style={{ ...label, textTransform: "none" }}>默认账户</span>
        </label>
      </div>

      {provider === "futu" ? (
        <div style={row}>
          <div style={field}>
            <span style={label}>OpenD Host</span>
            <input
              style={input}
              value={futuConfig.opendHost ?? ""}
              onChange={(e) => setFutuConfig((c) => ({ ...c, opendHost: e.target.value }))}
              placeholder="127.0.0.1"
            />
          </div>
          <div style={field}>
            <span style={label}>OpenD Port</span>
            <input
              style={input}
              type="number"
              value={futuConfig.opendPort ?? 11111}
              onChange={(e) => setFutuConfig((c) => ({ ...c, opendPort: Number(e.target.value) }))}
            />
          </div>
          <div style={field}>
            <span style={label}>市场</span>
            <select
              style={input}
              value={futuConfig.market ?? "HK"}
              onChange={(e) => setFutuConfig((c) => ({ ...c, market: e.target.value as "HK" | "US" | "CN" }))}
            >
              <option value="HK">HK</option>
              <option value="US">US</option>
              <option value="CN">CN</option>
            </select>
          </div>
          <div style={{ ...field, flex: 1 }}>
            <span style={label}>综合账户 ID（可选）</span>
            <input
              style={{ ...input, width: "100%" }}
              value={futuConfig.accId ?? ""}
              onChange={(e) => setFutuConfig((c) => ({ ...c, accId: e.target.value }))}
              placeholder="acc_id"
            />
          </div>
        </div>
      ) : provider === "ccxt" ? (
        <div style={row}>
          <div style={field}>
            <span style={label}>交易所 ID</span>
            <input
              style={input}
              value={ccxtConfig.exchangeId ?? "binance"}
              onChange={(e) => setCcxtConfig((c) => ({ ...c, exchangeId: e.target.value }))}
              placeholder="binance"
            />
          </div>
          <div style={field}>
            <span style={label}>合约类型</span>
            <select
              style={input}
              value={ccxtConfig.defaultType ?? "spot"}
              onChange={(e) =>
                setCcxtConfig((c) => ({ ...c, defaultType: e.target.value as "spot" | "future" }))
              }
            >
              <option value="spot">spot · 现货</option>
              <option value="future">future · 合约</option>
            </select>
          </div>
          <label style={{ ...field, flexDirection: "row", alignItems: "center", gap: 8, minWidth: "auto" }}>
            <input
              type="checkbox"
              checked={ccxtConfig.sandbox ?? false}
              onChange={(e) => setCcxtConfig((c) => ({ ...c, sandbox: e.target.checked }))}
            />
            <span style={{ ...label, textTransform: "none" }}>沙盒 / 测试网</span>
          </label>
          <div style={{ ...field, flex: 1 }}>
            <span style={label}>API Key 引用（可选）</span>
            <input
              style={{ ...input, width: "100%" }}
              value={ccxtConfig.apiKeyRef ?? ""}
              onChange={(e) => setCcxtConfig((c) => ({ ...c, apiKeyRef: e.target.value }))}
              placeholder="QUBIT_CCXT_API_KEY"
            />
          </div>
        </div>
      ) : (
        <div style={row}>
          <div style={field}>
            <span style={label}>IB Host</span>
            <input
              style={input}
              value={ibConfig.host ?? ""}
              onChange={(e) => setIbConfig((c) => ({ ...c, host: e.target.value }))}
            />
          </div>
          <div style={field}>
            <span style={label}>IB Port</span>
            <input
              style={input}
              type="number"
              value={ibConfig.port ?? 7497}
              onChange={(e) => setIbConfig((c) => ({ ...c, port: Number(e.target.value) }))}
            />
          </div>
          <div style={field}>
            <span style={label}>Client ID</span>
            <input
              style={input}
              type="number"
              value={ibConfig.clientId ?? 1}
              onChange={(e) => setIbConfig((c) => ({ ...c, clientId: Number(e.target.value) }))}
            />
          </div>
        </div>
      )}

      {mode !== "mock" ? (
        <div style={row}>
          <div style={{ ...field, flex: 1, minWidth: 200 }}>
            <span style={label}>HTTP 桥 Base URL</span>
            <input
              style={{ ...input, width: "100%", minWidth: 200 }}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://127.0.0.1:18765"
            />
          </div>
        </div>
      ) : null}

      <div style={{ ...row, marginBottom: 20 }}>
        <button type="button" className="qb-btn-primary-brand" onClick={() => void saveAccount()}>
          保存账户
        </button>
        <button type="button" className="qb-btn-secondary" onClick={() => void runHealthCheck()}>
          健康检查
        </button>
        <button type="button" className="qb-btn-secondary" onClick={() => void refresh()} disabled={loading}>
          {loading ? "刷新中…" : "刷新列表"}
        </button>
      </div>

      {statusLine ? (
        <div
          role="status"
          style={{
            marginBottom: 16,
            fontSize: 13,
            whiteSpace: "pre-wrap",
            padding: "10px 12px",
            borderRadius: 8,
            background: "var(--qb-stream-box-bg, #18181b)",
            border: "1px solid var(--qb-stream-box-border, #3f3f46)",
            color: "var(--qb-stream-box-fg, #d4d4d8)",
            lineHeight: 1.5,
          }}
        >
          {statusLine}
        </div>
      ) : null}

      <h3 style={sectionTitle}>已登记账户</h3>
      {accounts.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--qb-main-meta, #71717a)" }}>暂无记录，填写上方表单并保存即可写入数据库。</p>
      ) : (
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>券商</th>
              <th style={th}>账户</th>
              <th style={th}>模式</th>
              <th style={th}>默认</th>
              <th style={th}>健康</th>
              <th style={th}>Base URL</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td style={td}>{a.provider}</td>
                <td style={td}>{a.accountRef}</td>
                <td style={td}>{a.mode}</td>
                <td style={td}>{a.isDefault ? "是" : "—"}</td>
                <td style={{ ...td, color: statusColor(a.healthStatus) }}>
                  {a.healthStatus}
                  {a.healthMessage ? ` · ${a.healthMessage}` : ""}
                </td>
                <td style={td}>{a.baseUrl ?? "—"}</td>
                <td style={td}>
                  <button type="button" className="qb-btn-secondary" onClick={() => loadAccountIntoForm(a)}>
                    载入
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={sectionTitle}>近期 Broker 事件</h3>
      {events.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--qb-main-meta, #71717a)" }}>暂无事件日志。</p>
      ) : (
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>时间</th>
              <th style={th}>类型</th>
              <th style={th}>券商</th>
              <th style={th}>状态</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id}>
                <td style={td}>{new Date(ev.eventAt).toLocaleString()}</td>
                <td style={td}>{ev.eventType}</td>
                <td style={td}>{ev.provider}</td>
                <td style={td}>{ev.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
