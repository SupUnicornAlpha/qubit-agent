import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  checkMarketDataSources,
  listMarketDataSources,
  patchMarketDataSource,
} from "../../api/backend";
import type { MarketDataReadiness, MarketDataSourceRecord } from "../../api/types";

function compactTime(value: string | null): string {
  if (!value) return "尚未检查";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function healthTone(status: MarketDataSourceRecord["healthStatus"]): CSSProperties {
  if (status === "healthy") return { color: "var(--qb-success, #22c55e)" };
  if (status === "degraded") return { color: "var(--qb-warning, #f59e0b)" };
  if (status === "down") return { color: "var(--qb-danger, #ef4444)" };
  return { color: "var(--qb-text-muted, #71717a)" };
}

export const MarketDataSourcesPanel: FC = () => {
  const [rows, setRows] = useState<MarketDataSourceRecord[]>([]);
  const [readiness, setReadiness] = useState<MarketDataReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listMarketDataSources();
      setRows(result.data);
      setReadiness(result.readiness);
    } catch (e) {
      setError(`行情源加载失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runCheck = async (sourceId?: string) => {
    setChecking(sourceId ?? "all");
    setError(null);
    try {
      const result = await checkMarketDataSources(sourceId);
      setRows(result.data);
      setReadiness(result.readiness);
    } catch (e) {
      setError(`真实样本探针失败：${(e as Error).message}`);
    } finally {
      setChecking(null);
    }
  };

  const patch = async (
    source: MarketDataSourceRecord,
    next: { status?: "active" | "inactive"; priority?: number; isFallback?: boolean }
  ) => {
    setError(null);
    try {
      await patchMarketDataSource(source.id, next);
      await reload();
    } catch (e) {
      setError(`更新 ${source.name} 失败：${(e as Error).message}`);
    }
  };

  const readyTone =
    readiness?.status === "ready"
      ? styles.readinessReady
      : readiness?.status === "degraded"
        ? styles.readinessDegraded
        : styles.readinessDown;

  return (
    <section style={styles.shell} aria-labelledby="market-data-source-title">
      <header style={styles.header}>
        <div>
          <div id="market-data-source-title" style={styles.title}>行情数据源控制面</div>
          <div style={styles.subtitle}>
            这里展示真实上游，不等同于因子计算 Provider。健康检查会拉取样本行情，并驱动工具降级与行情页状态。
          </div>
        </div>
        <div style={styles.actions}>
          <button className="qb-btn-secondary" type="button" onClick={() => void reload()} disabled={loading || checking !== null}>
            刷新状态
          </button>
          <button className="qb-btn-primary-brand" type="button" onClick={() => void runCheck()} disabled={loading || checking !== null}>
            {checking === "all" ? "正在检查全部…" : "真实样本检查"}
          </button>
        </div>
      </header>

      {readiness ? (
        <div style={{ ...styles.readiness, ...readyTone }} role="status">
          <strong>{readiness.status.toUpperCase()}</strong>
          <span>{readiness.message}</span>
          <span style={styles.readinessMeta}>
            健康源 {readiness.healthySources.length} · 市场 {readiness.readyMarkets.join(" / ") || "无"} · {compactTime(readiness.checkedAt)}
          </span>
        </div>
      ) : null}
      {error ? <div style={styles.error} role="alert">{error}</div> : null}

      <div style={styles.tableWrap} aria-busy={loading}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>数据源</th>
              <th style={styles.th}>市场 / 周期</th>
              <th style={styles.th}>凭证</th>
              <th style={styles.th}>健康 / 熔断</th>
              <th style={styles.th}>成功率 / P95</th>
              <th style={styles.th}>最近检查 / 错误</th>
              <th style={styles.th}>优先级</th>
              <th style={styles.th}>策略</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr><td colSpan={8} style={styles.empty}>正在读取生产行情源状态…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} style={styles.empty}>没有注册行情源。请检查 migration 0095 和启动 bootstrap。</td></tr>
            ) : rows.map((source) => (
              <tr key={source.id} style={styles.tr}>
                <td style={styles.td}>
                  <div style={styles.sourceName}>{source.name}</div>
                  <code style={styles.code}>{source.id}</code>
                  <div style={styles.vendor}>{source.vendor}</div>
                </td>
                <td style={styles.td}>
                  <div style={styles.tags}>{source.supportedMarkets.map((v) => <span key={v} style={styles.tag}>{v}</span>)}</div>
                  <div style={styles.periods}>{source.supportedTimeframes.join(" · ")}</div>
                </td>
                <td style={styles.td}>
                  <div>{source.credentialMode === "none" ? "无需凭证" : source.credentialMode}</div>
                  <span style={source.credentialsReady ? styles.good : styles.bad}>
                    {source.credentialsReady ? "已就绪" : "缺失"}
                  </span>
                </td>
                <td style={styles.td}>
                  <strong style={healthTone(source.healthStatus)}>{source.healthStatus}</strong>
                  <div style={styles.muted}>circuit: {source.circuitState}</div>
                  <button type="button" className="qb-btn-secondary" style={styles.smallButton} disabled={checking !== null} onClick={() => void runCheck(source.id)}>
                    {checking === source.id ? "检查中…" : "检查"}
                  </button>
                </td>
                <td style={styles.td}>
                  <div>{source.successRate == null ? "—" : `${Math.round(source.successRate * 100)}%`}</div>
                  <div style={styles.muted}>P95 {source.p95LatencyMs == null ? "—" : `${source.p95LatencyMs}ms`}</div>
                </td>
                <td style={{ ...styles.td, ...styles.errorCell }}>
                  <div>{compactTime(source.lastHealthcheckAt)}</div>
                  <div style={source.lastError ? styles.lastError : styles.muted} title={source.lastError ?? undefined}>
                    {source.lastError ?? "无最近错误"}
                  </div>
                </td>
                <td style={styles.td}>
                  <div style={styles.priority}>
                    <button type="button" className="qb-btn-secondary" style={styles.stepButton} onClick={() => void patch(source, { priority: source.priority - 5 })}>−</button>
                    <strong>{source.priority}</strong>
                    <button type="button" className="qb-btn-secondary" style={styles.stepButton} onClick={() => void patch(source, { priority: source.priority + 5 })}>+</button>
                  </div>
                </td>
                <td style={styles.td}>
                  <label style={styles.toggleLabel}>
                    <input type="checkbox" checked={source.status === "active"} onChange={() => void patch(source, { status: source.status === "active" ? "inactive" : "active" })} />
                    启用
                  </label>
                  <label style={styles.toggleLabel}>
                    <input type="checkbox" checked={source.isFallback} onChange={() => void patch(source, { isFallback: !source.isFallback })} />
                    fallback
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const styles: Record<string, CSSProperties> = {
  shell: { display: "flex", flexDirection: "column", gap: 12 },
  header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" },
  title: { fontSize: 16, fontWeight: 700 },
  subtitle: { marginTop: 4, maxWidth: 780, color: "var(--qb-main-meta, var(--qb-text-muted))", fontSize: 12, lineHeight: 1.55 },
  actions: { display: "flex", gap: 8, flexWrap: "wrap" },
  readiness: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "9px 12px", borderRadius: 7, border: "1px solid" },
  readinessReady: { borderColor: "color-mix(in srgb, var(--qb-success, #22c55e) 45%, transparent)", background: "color-mix(in srgb, var(--qb-success, #22c55e) 9%, transparent)" },
  readinessDegraded: { borderColor: "color-mix(in srgb, var(--qb-warning, #f59e0b) 45%, transparent)", background: "color-mix(in srgb, var(--qb-warning, #f59e0b) 9%, transparent)" },
  readinessDown: { borderColor: "color-mix(in srgb, var(--qb-danger, #ef4444) 45%, transparent)", background: "color-mix(in srgb, var(--qb-danger, #ef4444) 9%, transparent)" },
  readinessMeta: { marginLeft: "auto", color: "var(--qb-text-muted)", fontSize: 11 },
  error: { padding: "8px 12px", borderRadius: 6, color: "var(--qb-danger, #ef4444)", background: "color-mix(in srgb, var(--qb-danger, #ef4444) 9%, transparent)" },
  tableWrap: { overflowX: "auto", border: "1px solid var(--qb-sidebar-border, var(--qb-border))", borderRadius: 8 },
  table: { width: "100%", minWidth: 1160, borderCollapse: "collapse", fontSize: 12 },
  th: { padding: "9px 10px", textAlign: "left", color: "var(--qb-text-muted)", fontSize: 11, fontWeight: 600, borderBottom: "1px solid var(--qb-sidebar-border, var(--qb-border))", background: "var(--qb-config-table-head-bg, transparent)" },
  tr: { borderBottom: "1px solid var(--qb-sidebar-border, var(--qb-border-subtle))" },
  td: { padding: "10px", verticalAlign: "top", lineHeight: 1.45 },
  sourceName: { fontWeight: 650 },
  code: { fontSize: 10, color: "var(--qb-text-muted)" },
  vendor: { marginTop: 2, color: "var(--qb-text-muted)", fontSize: 10 },
  tags: { display: "flex", gap: 4, flexWrap: "wrap" },
  tag: { padding: "1px 5px", borderRadius: 999, background: "var(--qb-pill-info-bg)", color: "var(--qb-pill-info-fg)", fontSize: 10 },
  periods: { marginTop: 5, color: "var(--qb-text-muted)", fontSize: 10, maxWidth: 180 },
  good: { color: "var(--qb-success, #22c55e)", fontSize: 11 },
  bad: { color: "var(--qb-danger, #ef4444)", fontSize: 11 },
  muted: { color: "var(--qb-text-muted)", fontSize: 10, marginTop: 2 },
  smallButton: { marginTop: 6, padding: "2px 7px", minHeight: 24, fontSize: 10 },
  errorCell: { maxWidth: 250 },
  lastError: { marginTop: 3, color: "var(--qb-danger, #ef4444)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" },
  priority: { display: "flex", alignItems: "center", gap: 7 },
  stepButton: { width: 24, minHeight: 24, padding: 0 },
  toggleLabel: { display: "flex", alignItems: "center", gap: 5, marginBottom: 6, cursor: "pointer", whiteSpace: "nowrap" },
  empty: { padding: 24, textAlign: "center", color: "var(--qb-text-muted)" },
};
