/**
 * Prime 工具面适配：证据链 + catalog lifecycle 一览。
 * 与 seed `ORCHESTRATOR_PRIME_*` / tool-catalog 对齐，供配置中心「数据源」页使用。
 */
import type { CSSProperties, FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { getAgentToolCatalog } from "../../api/backend";
import type { ToolCatalogEntry, ToolLifecycle } from "../../api/types";

const PRIME_EVIDENCE_CHAIN: Array<{ name: string; step: string; purpose: string }> = [
  {
    name: "market.snapshot.get",
    step: "1 · 固定事实",
    purpose: "不可变 snapshotId；交易/研究共用的数据锚点",
  },
  {
    name: "research.thesis.write",
    step: "2 · 结构化判断",
    purpose: "绑定 snapshotId → thesisId（live 强制）",
  },
  {
    name: "research.forecast_book.get",
    step: "2b · 预测账本",
    purpose: "回看 thesis / forecast 关联",
  },
  {
    name: "portfolio.construct",
    step: "3 · 确定性仓位",
    purpose: "绑定 thesisId → TargetPortfolio",
  },
  {
    name: "order.create_intent",
    step: "4 · 下单意图",
    purpose: "live 须 thesis；质量门 fail-closed",
  },
];

/** Phase A：已从 catalog / 默认面移除；面板仅作退役说明。 */
const TEAM_COMPAT_RETIRED = ["run_analyst_team", "fuse_signals", "summarize_team_decision"] as const;

function lifecycleCounts(catalog: ToolCatalogEntry[]): Record<string, number> {
  const out: Record<string, number> = { stable: 0, deprecated: 0, stub: 0, experimental: 0 };
  for (const e of catalog) {
    const life = (e.lifecycle ?? "stable") as ToolLifecycle | "stable";
    out[life] = (out[life] ?? 0) + 1;
  }
  return out;
}

export const ToolSurfacePanel: FC = () => {
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDeprecated, setShowDeprecated] = useState(false);

  useEffect(() => {
    void getAgentToolCatalog()
      .then(setCatalog)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const byName = useMemo(() => new Map(catalog.map((e) => [e.name, e])), [catalog]);
  const counts = useMemo(() => lifecycleCounts(catalog), [catalog]);
  const deprecatedRows = useMemo(
    () => catalog.filter((e) => e.lifecycle === "deprecated").sort((a, b) => a.name.localeCompare(b.name)),
    [catalog]
  );

  return (
    <section style={styles.shell} aria-labelledby="tool-surface-title">
      <header style={styles.header}>
        <div>
          <div id="tool-surface-title" style={styles.title}>
            Prime 工具面 · 证据链
          </div>
          <div style={styles.subtitle}>
            Orchestrator 默认走 snapshot → thesis → portfolio → intent。团队批量工具已退役（调用会失败）；
            专家派单用 <code>assign_task</code> / <code>call_team_*</code> / <code>agent.invoke</code>。
          </div>
        </div>
        <div style={styles.counts}>
          <span style={styles.countPill}>catalog {catalog.length}</span>
          <span style={styles.countPill}>stable {counts.stable ?? 0}</span>
          <span style={{ ...styles.countPill, ...styles.countDeprecated }}>deprecated {counts.deprecated ?? 0}</span>
          <span style={styles.countPill}>stub {counts.stub ?? 0}</span>
        </div>
      </header>

      {error ? (
        <div style={styles.error} role="alert">
          工具目录加载失败：{error}
        </div>
      ) : null}

      <div style={styles.chain}>
        {PRIME_EVIDENCE_CHAIN.map((step, i) => {
          const meta = byName.get(step.name);
          return (
            <div key={step.name} style={styles.chainCard}>
              <div style={styles.chainStep}>{step.step}</div>
              <code style={styles.chainName}>{step.name}</code>
              <div style={styles.chainPurpose}>{step.purpose}</div>
              {meta?.description ? (
                <div style={styles.chainDesc} title={meta.description}>
                  {meta.description.slice(0, 120)}
                  {meta.description.length > 120 ? "…" : ""}
                </div>
              ) : (
                <div style={styles.muted}>catalog 未登记或后端未启动</div>
              )}
              {i < PRIME_EVIDENCE_CHAIN.length - 1 ? <div style={styles.chainArrow} aria-hidden>↓</div> : null}
            </div>
          );
        })}
      </div>

      <div style={styles.compatBox}>
        <div style={styles.compatTitle}>团队兼容工具（Phase A 已退役 · 调用硬拒绝）</div>
        <div style={styles.compatChips}>
          {TEAM_COMPAT_RETIRED.map((name) => (
            <span
              key={name}
              style={styles.compatChip}
              title="请用 assign_task / call_team_* / agent.invoke"
            >
              {name}
              <span style={styles.badge}>retired</span>
            </span>
          ))}
        </div>
      </div>

      <div style={styles.deprecatedBlock}>
        <button
          type="button"
          className="qb-btn-ghost qb-btn--compact"
          onClick={() => setShowDeprecated((v) => !v)}
        >
          {showDeprecated ? "收起" : "展开"}全部 deprecated（{deprecatedRows.length}）
        </button>
        {showDeprecated ? (
          <ul style={styles.deprecatedList}>
            {deprecatedRows.map((e) => (
              <li key={e.name}>
                <code>{e.name}</code>
                {e.replacedBy ? <span style={styles.muted}> → {e.replacedBy}</span> : null}
                {e.deprecationReason ? <span style={styles.muted}> · {e.deprecationReason}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
};

const styles: Record<string, CSSProperties> = {
  shell: { display: "flex", flexDirection: "column", gap: 12 },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  title: { fontSize: 16, fontWeight: 700 },
  subtitle: {
    marginTop: 4,
    maxWidth: 820,
    color: "var(--qb-main-meta, var(--qb-text-muted))",
    fontSize: 12,
    lineHeight: 1.55,
  },
  counts: { display: "flex", gap: 6, flexWrap: "wrap" },
  countPill: {
    fontSize: 11,
    padding: "3px 8px",
    borderRadius: 999,
    border: "1px solid var(--qb-sidebar-border, var(--qb-border))",
    color: "var(--qb-main-meta, #a1a1aa)",
  },
  countDeprecated: {
    borderColor: "color-mix(in srgb, var(--qb-warning, #f59e0b) 50%, transparent)",
    color: "var(--qb-warning, #f59e0b)",
  },
  error: {
    padding: "8px 12px",
    borderRadius: 6,
    color: "var(--qb-danger, #ef4444)",
    background: "color-mix(in srgb, var(--qb-danger, #ef4444) 9%, transparent)",
  },
  chain: { display: "flex", flexDirection: "column", gap: 8 },
  chainCard: {
    position: "relative",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--qb-sidebar-border, var(--qb-border))",
    background: "var(--qb-main-panel-bg, transparent)",
  },
  chainStep: { fontSize: 11, fontWeight: 650, color: "var(--qb-pill-info-fg, #93c5fd)", marginBottom: 4 },
  chainName: { fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)" },
  chainPurpose: { marginTop: 4, fontSize: 12, color: "var(--qb-body-fg, #d4d4d8)" },
  chainDesc: { marginTop: 4, fontSize: 11, color: "var(--qb-text-muted)", lineHeight: 1.4 },
  chainArrow: {
    position: "absolute",
    right: 12,
    bottom: -10,
    color: "var(--qb-text-muted)",
    fontSize: 12,
  },
  muted: { color: "var(--qb-text-muted)", fontSize: 11 },
  compatBox: {
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px dashed color-mix(in srgb, var(--qb-warning, #f59e0b) 40%, transparent)",
    background: "color-mix(in srgb, var(--qb-warning, #f59e0b) 6%, transparent)",
  },
  compatTitle: { fontSize: 12, fontWeight: 600, marginBottom: 8 },
  compatChips: { display: "flex", flexWrap: "wrap", gap: 6 },
  compatChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    borderRadius: 6,
    fontSize: 11,
    background: "var(--qb-main-panel-bg, transparent)",
    border: "1px solid var(--qb-sidebar-border, var(--qb-border))",
  },
  badge: {
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--qb-warning, #f59e0b)",
  },
  deprecatedBlock: { display: "flex", flexDirection: "column", gap: 8 },
  deprecatedList: {
    margin: 0,
    paddingLeft: 18,
    fontSize: 11,
    color: "var(--qb-body-fg, #d4d4d8)",
    lineHeight: 1.55,
    maxHeight: 220,
    overflow: "auto",
  },
};
