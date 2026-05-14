import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useState } from "react";
import { checkBrokerHealth, listBrokerAccounts, listBrokerEvents, upsertBrokerAccount } from "../../api/backend";
import type { BrokerAccountRecord, BrokerOrderEventRecord } from "../../api/types";

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

export const BrokerAccountsPanel: FC = () => {
  const [provider, setProvider] = useState<"futu" | "ib">("futu");
  const [accountRef, setAccountRef] = useState("default");
  const [mode, setMode] = useState<"mock" | "sandbox" | "live">("mock");
  const [baseUrl, setBaseUrl] = useState("");
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

  const saveAccount = async () => {
    setStatusLine(null);
    try {
      await upsertBrokerAccount({
        provider,
        accountRef: accountRef.trim() || "default",
        mode,
        baseUrl: baseUrl.trim() || undefined,
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
        在此登记富途（Futu）或盈透（IB）等券商连接参数，供 REIA 执行链路在 <strong>mock</strong>（本地模拟）、
        <strong>sandbox</strong>（沙箱）与 <strong>live</strong>（实盘）模式下路由订单。保存后可在「研究团队」工作台联动意图执行；实盘前请在后端完成风控与双重确认策略。
      </p>

      <div style={row}>
        <div style={field}>
          <span style={label}>券商</span>
          <select style={input} value={provider} onChange={(e) => setProvider(e.target.value as "futu" | "ib")}>
            <option value="futu">Futu 富途</option>
            <option value="ib">Interactive Brokers</option>
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
            <option value="mock">mock · 模拟</option>
            <option value="sandbox">sandbox · 沙箱</option>
            <option value="live">live · 实盘</option>
          </select>
        </div>
        <div style={{ ...field, flex: 1, minWidth: 200 }}>
          <span style={label}>网关 Base URL（可选）</span>
          <input
            style={{ ...input, width: "100%", minWidth: 200 }}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="留空则使用后端默认 broker 适配地址"
          />
        </div>
      </div>
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
              <th style={th}>健康</th>
              <th style={th}>Base URL</th>
              <th style={th}>更新</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td style={td}>{a.provider}</td>
                <td style={td}>{a.accountRef}</td>
                <td style={td}>{a.mode}</td>
                <td style={{ ...td, color: statusColor(a.healthStatus) }}>
                  {a.healthStatus}
                  {a.healthMessage ? ` · ${a.healthMessage}` : ""}
                </td>
                <td style={td}>{a.baseUrl ?? "—"}</td>
                <td style={td}>{new Date(a.updatedAt).toLocaleString()}</td>
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
