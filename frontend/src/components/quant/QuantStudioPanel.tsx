/**
 * QuantStudioPanel — 量化工作台壳
 *
 * 四个 Tab：
 *   - factor：FactorWorkbench（列表 + 注册 + compute / auto-evaluate）
 *   - discovery：DiscoveryStudio（发起挖掘 + 候选排行榜 + promote）
 *   - composer：Composer（因子+规则 → strategy_composition）
 *   - backtest：BacktestStudio（提交回测 + equity 曲线 + metrics）
 *
 * 顶部 KPI 条（2026-06-09 视觉强化）：
 *   实时聚合本 project 下 factors / discoveries / compositions / backtests 数量与
 *   Agent 产物占比，给用户一眼看到工作台规模与「Agent 联动度」。
 */

import type { CSSProperties, FC } from "react";
import { useEffect, useState } from "react";
import { useAppStore, type QuantTab } from "../../store";
import { FactorWorkbenchTab } from "./FactorWorkbenchTab";
import { DiscoveryStudioTab } from "./DiscoveryStudioTab";
import { ComposerTab } from "./ComposerTab";
import { BacktestStudioTab } from "./BacktestStudioTab";
import {
  listBacktestJobs,
  listDiscoveryJobs,
  listFactors,
  listStrategyVersions,
  listStrategyCompositions,
} from "../../api/backend";
import { useDefaultProject } from "./useDefaultProject";

const TABS: readonly { id: QuantTab; label: string; desc: string; color: string }[] = [
  { id: "factor", label: "因子工坊", desc: "FactorWorkbench", color: "var(--qb-quant-accent-1)" },
  { id: "discovery", label: "挖掘工坊", desc: "DiscoveryStudio", color: "var(--qb-quant-accent-2)" },
  { id: "composer", label: "组合工坊", desc: "Composer", color: "var(--qb-quant-accent-4)" },
  { id: "backtest", label: "回测工坊", desc: "BacktestStudio", color: "var(--qb-quant-accent-5)" },
];

interface KpiSummary {
  factors: { total: number; agent: number; promoted: number };
  discoveries: { total: number; succeeded: number };
  compositions: { total: number; clone: number };
  backtests: { total: number; completed: number };
}

const EMPTY_KPI: KpiSummary = {
  factors: { total: 0, agent: 0, promoted: 0 },
  discoveries: { total: 0, succeeded: 0 },
  compositions: { total: 0, clone: 0 },
  backtests: { total: 0, completed: 0 },
};

export const QuantStudioPanel: FC = () => {
  const tab = useAppStore((s) => s.quantTab);
  const setTab = useAppStore((s) => s.setQuantTab);
  const { projectId } = useDefaultProject();
  const [kpi, setKpi] = useState<KpiSummary>(EMPTY_KPI);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const [factors, discoveries, versions, backtests] = await Promise.all([
          listFactors({ projectId }).catch(() => []),
          listDiscoveryJobs({ projectId }).catch(() => []),
          listStrategyVersions(projectId).catch(() => []),
          listBacktestJobs().catch(() => []),
        ]);
        // 聚合 composition 数量（每个 strategy_version 各取一次；限制并发避免压垮 SQLite）
        const compositionsByVersion = await Promise.all(
          versions.slice(0, 20).map((v) =>
            listStrategyCompositions(v.id).catch(() => [])
          )
        );
        const compositions = compositionsByVersion.flat();
        if (cancelled) return;
        setKpi({
          factors: {
            total: factors.length,
            agent: factors.filter((f) => f.createdBy === "agent").length,
            promoted: factors.filter((f) => f.createdBy === "discovery_promote").length,
          },
          discoveries: {
            total: discoveries.length,
            succeeded: discoveries.filter((d) => d.status === "succeeded").length,
          },
          compositions: {
            total: compositions.length,
            clone: compositions.filter((c) => c.createdBy === "clone").length,
          },
          backtests: {
            total: backtests.length,
            completed: backtests.filter((b) => b.status === "completed").length,
          },
        });
      } catch {
        if (!cancelled) setKpi(EMPTY_KPI);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, tab]);

  return (
    <div data-qb-quant-shell className="qb-quant-shell" style={styles.root}>
      <header className="qb-quant-header" style={styles.header}>
        <div className="qb-quant-header-titles" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="qb-quant-title" style={styles.title}>
            量化工作台
          </div>
          <div className="qb-quant-subtitle" style={styles.subtitle}>
            因子研究 · 自动挖掘 · 策略回测 — 后端由 Provider 抽象层驱动，可在「配置中心 · Providers」切换实现
          </div>
          <div className="qb-quant-kpi-row" aria-label="工作台统计">
            <KpiPill color="indigo" label="因子" value={kpi.factors.total} hint={`Agent ${kpi.factors.agent} · Promoted ${kpi.factors.promoted}`} />
            <KpiPill color="cyan" label="挖掘任务" value={kpi.discoveries.total} hint={`${kpi.discoveries.succeeded} succeeded`} />
            <KpiPill color="pink" label="组合" value={kpi.compositions.total} hint={`${kpi.compositions.clone} cloned`} />
            <KpiPill color="emerald" label="回测" value={kpi.backtests.total} hint={`${kpi.backtests.completed} completed`} />
          </div>
        </div>
        <div role="tablist" className="qb-quant-tabbar" style={styles.tabbar} aria-label="量化工作台子模块">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              data-qb-quant-tab-id={t.id}
              className={`qb-quant-tab${tab === t.id ? " qb-quant-tab--active" : ""}`}
              title={t.desc}
            >
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: t.color,
                  marginRight: 6,
                  verticalAlign: "middle",
                  boxShadow:
                    tab === t.id
                      ? `0 0 0 3px color-mix(in srgb, ${t.color} 28%, transparent)`
                      : "none",
                }}
              />
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <div className="qb-quant-body" data-qb-quant-active={tab} style={styles.body}>
        {tab === "factor" ? <FactorWorkbenchTab /> : null}
        {tab === "discovery" ? <DiscoveryStudioTab /> : null}
        {tab === "composer" ? <ComposerTab /> : null}
        {tab === "backtest" ? <BacktestStudioTab /> : null}
      </div>
    </div>
  );
};

const KpiPill: FC<{ color: "indigo" | "cyan" | "amber" | "pink" | "emerald"; label: string; value: number; hint?: string }> = ({
  color,
  label,
  value,
  hint,
}) => (
  <span className="qb-quant-kpi" title={hint ?? ""}>
    <span className="qb-quant-kpi-dot" data-color={color} />
    <span style={{ color: "var(--qb-text-muted)" }}>{label}</span>
    <span className="qb-quant-kpi-value">{value}</span>
    {hint ? <span style={{ color: "var(--qb-text-muted)" }}>· {hint}</span> : null}
  </span>
);

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
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  title: { fontSize: 19, fontWeight: 700 },
  subtitle: { fontSize: 12, color: "var(--qb-text-muted)", marginTop: 4 },
  tabbar: { display: "flex", gap: 6, alignSelf: "flex-start" },
  body: { flex: 1, minHeight: 0, overflow: "auto" },
};
