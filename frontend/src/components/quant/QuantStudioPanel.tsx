/**
 * QuantStudioPanel — 量化工作台壳
 *
 * 三个 Tab：
 *   - factor：FactorWorkbench（列表 + 注册 + compute / auto-evaluate）
 *   - discovery：DiscoveryStudio（发起挖掘 + 候选排行榜 + promote）
 *   - backtest：BacktestStudio（提交回测 + equity 曲线 + metrics）
 *
 * 路由由 Sidebar 控制 `quantTab`。
 */

import type { CSSProperties, FC } from "react";
import { useAppStore, type QuantTab } from "../../store";
import { FactorWorkbenchTab } from "./FactorWorkbenchTab";
import { DiscoveryStudioTab } from "./DiscoveryStudioTab";
import { ComposerTab } from "./ComposerTab";
import { BacktestStudioTab } from "./BacktestStudioTab";

const TABS: readonly { id: QuantTab; label: string; desc: string }[] = [
  { id: "factor", label: "因子工坊", desc: "FactorWorkbench" },
  { id: "discovery", label: "挖掘工坊", desc: "DiscoveryStudio" },
  { id: "composer", label: "组合工坊", desc: "Composer" },
  { id: "backtest", label: "回测工坊", desc: "BacktestStudio" },
];

export const QuantStudioPanel: FC = () => {
  const tab = useAppStore((s) => s.quantTab);
  const setTab = useAppStore((s) => s.setQuantTab);

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <div>
          <div style={styles.title}>量化工作台</div>
          <div style={styles.subtitle}>
            因子研究 · 自动挖掘 · 策略回测 — 后端由 Provider 抽象层驱动，可在「配置中心 · Providers」切换实现
          </div>
        </div>
        <div role="tablist" style={styles.tabbar} aria-label="量化工作台子模块">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`qb-quant-tab${tab === t.id ? " qb-quant-tab--active" : ""}`}
              style={{
                ...styles.tabBtn,
                ...(tab === t.id ? styles.tabBtnActive : null),
              }}
              title={t.desc}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <div style={styles.body}>
        {tab === "factor" ? <FactorWorkbenchTab /> : null}
        {tab === "discovery" ? <DiscoveryStudioTab /> : null}
        {tab === "composer" ? <ComposerTab /> : null}
        {tab === "backtest" ? <BacktestStudioTab /> : null}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "var(--qb-bg-surface)",
  },
  header: {
    flex: "0 0 auto",
    padding: "16px 20px 12px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  title: { fontSize: 18, fontWeight: 600 },
  subtitle: { fontSize: 12, color: "var(--qb-text-muted)", marginTop: 4 },
  tabbar: { display: "flex", gap: 6 },
  tabBtn: {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 6,
    border: "1px solid var(--qb-border-subtle)",
    background: "transparent",
    cursor: "pointer",
    color: "var(--qb-text-muted)",
  },
  tabBtnActive: {
    background: "var(--qb-bg-elevated)",
    borderColor: "var(--qb-border-strong, var(--qb-border-subtle))",
    color: "var(--qb-text-strong, inherit)",
  },
  body: { flex: 1, minHeight: 0, overflow: "auto" },
};
