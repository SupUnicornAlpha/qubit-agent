/**
 * ProvidersPanel — Provider 注册中心 UI
 *
 * 与后端 /api/v1/providers 对接：
 *   - 按 kind 分组列出所有 Provider（factor_compute / factor_eval / rule_engine / backtest / ...）
 *   - 支持 enable/disable、priority 调整、健康检查
 *
 * 样式约定：
 *   - 所有颜色走 CSS 变量（--qb-body-fg / --qb-main-panel-bg / --qb-sidebar-border /
 *     --qb-config-table-* / --qb-pill-*），跨风格 (dark / light / glass / biophilic / industrial …)
 *     自动适配；不再写死 #1a1a1c 这类深色 fallback
 *   - 按钮复用 .qb-btn-secondary / .qb-btn-primary-brand 等全局类
 *
 * 参考 docs/FACTOR_RULE_STRATEGY_DESIGN.md §5.4 §7.7
 */

import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listProviders,
  listProviderHealth,
  patchProvider,
  type ProviderHealthRecord,
  type ProviderKind,
  type ProviderRecord,
} from "../../api/backend";
import { MarketDataSourcesPanel } from "./MarketDataSourcesPanel";

const KIND_LABELS: Record<ProviderKind, string> = {
  factor_compute: "因子计算",
  factor_eval: "因子评估",
  rule_engine: "规则引擎",
  backtest: "回测引擎",
  live_ems: "实盘 EMS",
  market_data: "行情数据",
  llm: "LLM",
  factor_miner: "因子挖掘",
};

const KIND_ORDER: ProviderKind[] = [
  "factor_compute",
  "factor_eval",
  "rule_engine",
  "backtest",
  "factor_miner",
  "market_data",
  "live_ems",
  "llm",
];

export const ProvidersPanel: FC = () => {
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [healthByKey, setHealthByKey] = useState<Record<string, ProviderHealthRecord>>({});
  const [filterKind, setFilterKind] = useState<ProviderKind | "all">("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const all = await listProviders();
      setProviders(all);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const rows = await listProviderHealth();
      const map: Record<string, ProviderHealthRecord> = {};
      for (const r of rows) map[`${r.kind}|${r.providerKey}`] = r;
      setHealthByKey(map);
    } catch (e) {
      setError(`健康检查失败：${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const grouped = useMemo(() => {
    const out = new Map<ProviderKind, ProviderRecord[]>();
    for (const p of providers) {
      if (filterKind !== "all" && p.kind !== filterKind) continue;
      const arr = out.get(p.kind) ?? [];
      arr.push(p);
      out.set(p.kind, arr);
    }
    for (const arr of out.values()) arr.sort((a, b) => b.priority - a.priority);
    return out;
  }, [providers, filterKind]);

  const togglesStatus = async (p: ProviderRecord) => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await patchProvider(p.id, { status: p.status === "enabled" ? "disabled" : "enabled" });
      setMsg(`${p.providerKey} → ${p.status === "enabled" ? "disabled" : "enabled"}`);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const bumpPriority = async (p: ProviderRecord, delta: number) => {
    const target = Math.max(0, Math.min(100, p.priority + delta));
    if (target === p.priority) return;
    setBusy(true);
    setError(null);
    try {
      await patchProvider(p.id, { priority: target });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.shell}>
      <MarketDataSourcesPanel />
      <div style={styles.divider} />
      <div style={styles.header}>
        <div>
          <div style={styles.title}>Provider 注册中心</div>
          <div style={styles.subtitle}>
            因子 / 评估 / 规则 / 回测 / 数据 / LLM 等模块的可插拔实现。priority 高者优先被解析。
          </div>
        </div>
        <div style={styles.actions}>
          <select
            value={filterKind}
            onChange={(e) => setFilterKind(e.target.value as ProviderKind | "all")}
            style={styles.select}
          >
            <option value="all">全部 kind</option>
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="qb-btn-secondary"
            onClick={() => void reload()}
            disabled={busy}
          >
            刷新
          </button>
          <button
            type="button"
            className="qb-btn-secondary"
            onClick={() => void refreshHealth()}
            disabled={busy}
          >
            健康检查
          </button>
        </div>
      </div>

      {error ? <div style={styles.error}>{error}</div> : null}
      {msg ? <div style={styles.ok}>{msg}</div> : null}

      <div style={styles.kindsCol}>
        {KIND_ORDER.filter((k) => filterKind === "all" || k === filterKind).map((kind) => {
          const rows = grouped.get(kind) ?? [];
          return (
            <section key={kind} style={styles.kindSection}>
              <header style={styles.kindHeader}>
                <span style={styles.kindBadge}>{KIND_LABELS[kind]}</span>
                <span style={styles.kindKey}>{kind}</span>
                <span style={styles.kindCount}>{rows.length} 个 Provider</span>
              </header>
              {rows.length === 0 ? (
                <div style={styles.empty}>暂无注册</div>
              ) : (
                <div style={styles.tableWrap}>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.thLeft}>providerKey</th>
                        <th style={styles.thLeft}>显示名 / 版本</th>
                        <th style={styles.thCenter}>状态</th>
                        <th style={styles.thCenter}>priority</th>
                        <th style={styles.thCenter}>健康</th>
                        <th style={styles.thLeft}>能力</th>
                        <th style={styles.thCenter}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => {
                        const h = healthByKey[`${p.kind}|${p.providerKey}`];
                        const cap = p.capability as { features?: string[] } | null;
                        const features = cap?.features ?? [];
                        const statusPill =
                          p.status === "enabled"
                            ? { background: "var(--qb-pill-success-bg)", color: "var(--qb-pill-success-fg)" }
                            : { background: "var(--qb-pill-disabled-bg)", color: "var(--qb-pill-disabled-fg)" };
                        return (
                          <tr key={p.id} style={styles.tr}>
                            <td style={styles.tdMono}>
                              {p.providerKey}
                              {p.isFallback ? <span style={styles.fallback}>· fallback</span> : null}
                              {p.isBuiltin ? <span style={styles.builtin}>· builtin</span> : null}
                            </td>
                            <td style={styles.tdLeft}>
                              <div style={styles.cellTitle}>{p.displayName}</div>
                              <div style={styles.cellSub}>v{p.version}</div>
                            </td>
                            <td style={styles.tdCenter}>
                              <span style={{ ...styles.statusPill, ...statusPill }}>{p.status}</span>
                            </td>
                            <td style={styles.tdCenter}>
                              <div style={styles.priorityRow}>
                                <button
                                  type="button"
                                  className="qb-btn-secondary"
                                  style={styles.priBtn}
                                  onClick={() => void bumpPriority(p, -5)}
                                  disabled={busy}
                                  aria-label="降低 priority"
                                >
                                  −
                                </button>
                                <span style={styles.priorityValue}>{p.priority}</span>
                                <button
                                  type="button"
                                  className="qb-btn-secondary"
                                  style={styles.priBtn}
                                  onClick={() => void bumpPriority(p, +5)}
                                  disabled={busy}
                                  aria-label="提高 priority"
                                >
                                  +
                                </button>
                              </div>
                            </td>
                            <td style={styles.tdCenter}>
                              {h ? (
                                h.ok ? (
                                  <span style={styles.healthOk}>
                                    OK{h.latencyMs ? ` · ${h.latencyMs}ms` : ""}
                                  </span>
                                ) : (
                                  <span style={styles.healthFail} title={h.error}>
                                    failed
                                  </span>
                                )
                              ) : (
                                <span style={styles.healthNone}>—</span>
                              )}
                            </td>
                            <td style={styles.tdLeft}>
                              <div style={styles.featuresRow}>
                                {features.slice(0, 5).map((f) => (
                                  <span key={f} style={styles.featurePill}>
                                    {f}
                                  </span>
                                ))}
                                {features.length > 5 ? (
                                  <span style={styles.cellSub}>+{features.length - 5}</span>
                                ) : null}
                              </div>
                              {p.description ? (
                                <div style={styles.cellSub} title={p.description}>
                                  {p.description.slice(0, 80)}
                                  {p.description.length > 80 ? "…" : ""}
                                </div>
                              ) : null}
                            </td>
                            <td style={styles.tdCenter}>
                              <button
                                type="button"
                                className="qb-btn-secondary"
                                disabled={busy}
                                onClick={() => void togglesStatus(p)}
                              >
                                {p.status === "enabled" ? "disable" : "enable"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  shell: {
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
    color: "var(--qb-body-fg, inherit)",
  },
  divider: { height: 1, background: "var(--qb-sidebar-border, var(--qb-border-subtle))" },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--qb-body-fg, inherit)",
  },
  subtitle: {
    fontSize: 12,
    color: "var(--qb-main-meta, var(--qb-muted-fg, #71717a))",
    marginTop: 4,
    maxWidth: 720,
    lineHeight: 1.6,
  },
  actions: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  select: {
    padding: "6px 10px",
    borderRadius: 6,
    background: "var(--qb-input-bg, var(--qb-main-panel-bg, transparent))",
    color: "var(--qb-body-fg, inherit)",
    border: "1px solid var(--qb-sidebar-border, var(--qb-border, rgba(127,127,127,0.3)))",
    fontSize: 12,
  },
  error: {
    padding: "8px 12px",
    borderRadius: 6,
    background: "var(--qb-config-error-bg, rgba(239,68,68,.15))",
    color: "var(--qb-config-error-fg, #b91c1c)",
    border: "1px solid var(--qb-config-error-border, rgba(239,68,68,.35))",
    fontSize: 12,
  },
  ok: {
    padding: "8px 12px",
    borderRadius: 6,
    background: "var(--qb-pill-success-bg, rgba(16,185,129,.15))",
    color: "var(--qb-pill-success-fg, #047857)",
    border: "1px solid var(--qb-sidebar-border, transparent)",
    fontSize: 12,
  },
  kindsCol: { display: "flex", flexDirection: "column", gap: 16 },
  kindSection: {
    border: "1px solid var(--qb-sidebar-border, var(--qb-border, rgba(127,127,127,0.3)))",
    borderRadius: 8,
    padding: 12,
    background: "var(--qb-card-bg, var(--qb-main-panel-bg, transparent))",
  },
  kindHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
    color: "var(--qb-body-fg, inherit)",
  },
  kindBadge: {
    padding: "2px 8px",
    borderRadius: 4,
    background: "var(--qb-pill-info-bg, rgba(96,165,250,.15))",
    color: "var(--qb-pill-info-fg, #1d4ed8)",
    fontSize: 12,
    fontWeight: 600,
  },
  kindKey: {
    fontFamily: "ui-monospace, monospace",
    fontSize: 11,
    color: "var(--qb-main-meta, var(--qb-muted-fg, #71717a))",
  },
  kindCount: {
    fontSize: 11,
    color: "var(--qb-main-meta, var(--qb-muted-fg, #71717a))",
    marginLeft: "auto",
  },
  empty: {
    padding: 16,
    textAlign: "center",
    color: "var(--qb-main-meta, var(--qb-muted-fg, #71717a))",
    fontSize: 12,
  },
  tableWrap: { width: "100%", overflowX: "auto" },
  table: {
    width: "100%",
    fontSize: 12,
    borderCollapse: "collapse",
    color: "var(--qb-config-table-row-fg, var(--qb-body-fg, inherit))",
  },
  tr: {
    borderTop: "1px solid var(--qb-config-table-border, var(--qb-sidebar-border, rgba(127,127,127,0.2)))",
  },
  thLeft: {
    textAlign: "left",
    padding: "8px",
    fontWeight: 500,
    color: "var(--qb-config-table-header-fg, var(--qb-main-meta, var(--qb-muted-fg, #71717a)))",
    borderBottom: "1px solid var(--qb-config-table-border, var(--qb-sidebar-border, rgba(127,127,127,0.2)))",
  },
  thCenter: {
    textAlign: "center",
    padding: "8px",
    fontWeight: 500,
    color: "var(--qb-config-table-header-fg, var(--qb-main-meta, var(--qb-muted-fg, #71717a)))",
    borderBottom: "1px solid var(--qb-config-table-border, var(--qb-sidebar-border, rgba(127,127,127,0.2)))",
  },
  tdMono: {
    padding: "8px",
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
    whiteSpace: "nowrap",
    color: "var(--qb-body-fg, inherit)",
  },
  tdLeft: { padding: "8px", verticalAlign: "top", color: "var(--qb-body-fg, inherit)" },
  tdCenter: {
    padding: "8px",
    verticalAlign: "middle",
    textAlign: "center",
    color: "var(--qb-body-fg, inherit)",
  },
  cellTitle: { fontSize: 12, fontWeight: 500, color: "var(--qb-body-fg, inherit)" },
  cellSub: {
    fontSize: 11,
    color: "var(--qb-main-meta, var(--qb-muted-fg, #71717a))",
    marginTop: 2,
  },
  fallback: {
    fontSize: 10,
    color: "var(--qb-main-meta, var(--qb-muted-fg, #71717a))",
    marginLeft: 6,
  },
  builtin: {
    fontSize: 10,
    color: "var(--qb-main-meta, var(--qb-muted-fg, #71717a))",
    marginLeft: 6,
  },
  statusPill: {
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 500,
    display: "inline-block",
    minWidth: 56,
    textAlign: "center",
  },
  priorityRow: { display: "inline-flex", gap: 6, alignItems: "center" },
  priBtn: {
    width: 24,
    height: 24,
    padding: 0,
    borderRadius: 4,
    fontSize: 13,
    lineHeight: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  priorityValue: {
    fontFamily: "ui-monospace, monospace",
    minWidth: 28,
    textAlign: "center",
    color: "var(--qb-body-fg, inherit)",
  },
  healthOk: { color: "var(--qb-pill-success-fg, #047857)", fontWeight: 500 },
  healthFail: { color: "var(--qb-pill-error-fg, #b91c1c)", fontWeight: 500 },
  healthNone: { color: "var(--qb-main-meta, var(--qb-muted-fg, #a1a1aa))" },
  featuresRow: { display: "flex", flexWrap: "wrap", gap: 4 },
  featurePill: {
    padding: "1px 6px",
    borderRadius: 4,
    background: "var(--qb-pill-muted-bg, rgba(148,163,184,.15))",
    color: "var(--qb-pill-muted-fg, var(--qb-body-fg, #475569))",
    border: "1px solid var(--qb-sidebar-border, transparent)",
    fontSize: 10,
    fontFamily: "ui-monospace, monospace",
  },
};
