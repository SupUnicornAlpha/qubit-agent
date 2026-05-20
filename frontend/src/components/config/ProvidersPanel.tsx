/**
 * ProvidersPanel — Provider 注册中心 UI
 *
 * 与后端 /api/v1/providers 对接：
 *   - 按 kind 分组列出所有 Provider（factor_compute / factor_eval / rule_engine / backtest / ...）
 *   - 支持 enable/disable、priority 调整、健康检查
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
          <button type="button" onClick={() => void reload()} disabled={busy} style={styles.btn}>
            刷新
          </button>
          <button
            type="button"
            onClick={() => void refreshHealth()}
            disabled={busy}
            style={styles.btn}
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
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.thLeft}>providerKey</th>
                      <th style={styles.thLeft}>显示名 / 版本</th>
                      <th>状态</th>
                      <th>priority</th>
                      <th>健康</th>
                      <th style={styles.thLeft}>能力</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => {
                      const h = healthByKey[`${p.kind}|${p.providerKey}`];
                      const cap = p.capability as { features?: string[] } | null;
                      const features = cap?.features ?? [];
                      return (
                        <tr key={p.id}>
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
                            <span
                              style={{
                                ...styles.statusPill,
                                background:
                                  p.status === "enabled" ? "rgba(16,185,129,.15)" : "rgba(239,68,68,.15)",
                                color: p.status === "enabled" ? "#10b981" : "#ef4444",
                              }}
                            >
                              {p.status}
                            </span>
                          </td>
                          <td style={styles.tdCenter}>
                            <div style={styles.priorityRow}>
                              <button
                                style={styles.priBtn}
                                onClick={() => void bumpPriority(p, -5)}
                                disabled={busy}
                                aria-label="降低 priority"
                              >
                                −
                              </button>
                              <span style={styles.priorityValue}>{p.priority}</span>
                              <button
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
                                <span style={{ color: "#10b981" }}>OK{h.latencyMs ? ` · ${h.latencyMs}ms` : ""}</span>
                              ) : (
                                <span style={{ color: "#ef4444" }} title={h.error}>
                                  failed
                                </span>
                              )
                            ) : (
                              <span style={{ color: "#a1a1aa" }}>—</span>
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
                              style={styles.btn}
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
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  shell: { padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  title: { fontSize: 16, fontWeight: 600 },
  subtitle: { fontSize: 12, opacity: 0.7, marginTop: 4, maxWidth: 720 },
  actions: { display: "flex", gap: 8, alignItems: "center" },
  select: {
    padding: "6px 10px",
    borderRadius: 6,
    background: "var(--qb-bg-elev, #1c1c1f)",
    color: "inherit",
    border: "1px solid var(--qb-border, #303035)",
    fontSize: 12,
  },
  btn: {
    padding: "6px 12px",
    fontSize: 12,
    borderRadius: 6,
    background: "var(--qb-bg-elev, #2a2a30)",
    color: "inherit",
    border: "1px solid var(--qb-border, #404048)",
    cursor: "pointer",
  },
  error: {
    padding: "8px 12px",
    borderRadius: 6,
    background: "rgba(239,68,68,.15)",
    color: "#fca5a5",
    fontSize: 12,
  },
  ok: {
    padding: "8px 12px",
    borderRadius: 6,
    background: "rgba(16,185,129,.15)",
    color: "#a7f3d0",
    fontSize: 12,
  },
  kindsCol: { display: "flex", flexDirection: "column", gap: 16 },
  kindSection: {
    border: "1px solid var(--qb-border, #303035)",
    borderRadius: 8,
    padding: 12,
    background: "var(--qb-bg-elev, #1a1a1c)",
  },
  kindHeader: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  kindBadge: {
    padding: "2px 8px",
    borderRadius: 4,
    background: "rgba(96,165,250,.15)",
    color: "#93c5fd",
    fontSize: 12,
    fontWeight: 600,
  },
  kindKey: { fontFamily: "ui-monospace, monospace", fontSize: 11, opacity: 0.6 },
  kindCount: { fontSize: 11, opacity: 0.5, marginLeft: "auto" },
  empty: { padding: "16px", textAlign: "center", opacity: 0.5, fontSize: 12 },
  table: { width: "100%", fontSize: 12, borderCollapse: "collapse" },
  thLeft: { textAlign: "left", padding: "6px 8px", fontWeight: 500, opacity: 0.7 },
  tdMono: {
    padding: "8px",
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  tdLeft: { padding: "8px", verticalAlign: "top" },
  tdCenter: { padding: "8px", verticalAlign: "middle", textAlign: "center" },
  cellTitle: { fontSize: 12, fontWeight: 500 },
  cellSub: { fontSize: 11, opacity: 0.6, marginTop: 2 },
  fallback: { fontSize: 10, opacity: 0.6, marginLeft: 6 },
  builtin: { fontSize: 10, opacity: 0.6, marginLeft: 6 },
  statusPill: {
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 500,
  },
  priorityRow: { display: "inline-flex", gap: 6, alignItems: "center" },
  priBtn: {
    width: 22,
    height: 22,
    borderRadius: 4,
    background: "var(--qb-bg-elev, #2a2a30)",
    color: "inherit",
    border: "1px solid var(--qb-border, #404048)",
    cursor: "pointer",
    fontSize: 13,
    lineHeight: 1,
  },
  priorityValue: { fontFamily: "ui-monospace, monospace", minWidth: 28, textAlign: "center" },
  featuresRow: { display: "flex", flexWrap: "wrap", gap: 4 },
  featurePill: {
    padding: "1px 6px",
    borderRadius: 4,
    background: "rgba(148,163,184,.15)",
    color: "#cbd5e1",
    fontSize: 10,
    fontFamily: "ui-monospace, monospace",
  },
};
