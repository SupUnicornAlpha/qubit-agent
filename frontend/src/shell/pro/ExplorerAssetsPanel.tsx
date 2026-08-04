import { type FC, useEffect, useState } from "react";
import {
  getOrCreateDefaultProject,
  listFactors,
  listStrategyRuntimes,
  listStrategyVersions,
  type FactorRecord,
  type StrategyVersionFlatRecord,
} from "../../api/backend";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store";

type AssetTab = "strategies" | "factors" | "positions";

export const ExplorerAssetsPanel: FC = () => {
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setQuantTab = useAppStore((s) => s.setQuantTab);
  const setQuantContext = useAppStore((s) => s.setQuantContext);
  const setQuantHandoff = useAppStore((s) => s.setQuantHandoff);
  const { t } = useTranslation();
  const [tab, setTab] = useState<AssetTab>("strategies");
  const [factors, setFactors] = useState<FactorRecord[]>([]);
  const [strategies, setStrategies] = useState<StrategyVersionFlatRecord[]>([]);
  const [positions, setPositions] = useState<
    Array<{ id: string; label: string; detail: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const project = await getOrCreateDefaultProject();
        if (!cancelled) {
          setQuantContext({ projectId: project.id, sourceLabel: "assets-explorer" });
        }
        const [factorRows, strategyRows, runtimeRows] = await Promise.all([
          listFactors({ projectId: project.id }).catch(() => [] as FactorRecord[]),
          listStrategyVersions(project.id).catch(() => [] as StrategyVersionFlatRecord[]),
          listStrategyRuntimes().catch(() => []),
        ]);
        if (cancelled) return;
        setFactors(factorRows);
        setStrategies(strategyRows);
        setPositions(
          runtimeRows.slice(0, 50).map((r) => ({
            id: r.id,
            label: `${r.symbol} · ${r.market}`,
            detail: `${r.status} · ${r.executionMode}`,
          }))
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setQuantContext]);

  if (loading) {
    return <div className="qb-explorer-assets__meta">{t("common.status.loading")}</div>;
  }

  return (
    <div className="qb-explorer-assets">
      <div className="qb-explorer-sections" style={{ paddingLeft: 0, paddingRight: 0 }}>
        {(
          [
            ["strategies", t("proShell.assets.strategies")],
            ["factors", t("proShell.assets.factors")],
            ["positions", t("proShell.assets.positions")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {error ? <div className="qb-explorer-assets__meta">{error}</div> : null}
      {tab === "strategies" ? (
        strategies.length === 0 ? (
          <div className="qb-explorer-assets__meta">{t("proShell.assets.emptyStrategies")}</div>
        ) : (
          strategies.map((s) => (
            <button
              key={s.id}
              type="button"
              className="qb-explorer-assets__row"
              title={s.id}
              onClick={() => {
                setActiveView("quant");
                setQuantTab("composer");
                setQuantHandoff({
                  kind: "strategy-version-to-composer",
                  strategyVersionId: s.id,
                  note: "assets-panel",
                });
              }}
            >
              <span>{s.strategyName || s.versionTag || s.id}</span>
            </button>
          ))
        )
      ) : null}
      {tab === "factors" ? (
        factors.length === 0 ? (
          <div className="qb-explorer-assets__meta">{t("proShell.assets.emptyFactors")}</div>
        ) : (
          factors.map((f) => (
            <button
              key={f.id}
              type="button"
              className="qb-explorer-assets__row"
              title={f.id}
              onClick={() => {
                setActiveView("quant");
                setQuantTab("factor");
                setQuantHandoff({
                  kind: "factor-to-workbench",
                  factorId: f.id,
                  note: "assets-panel",
                });
              }}
            >
              <span>{f.name || f.id}</span>
            </button>
          ))
        )
      ) : null}
      {tab === "positions" ? (
        <>
          <div className="qb-explorer-assets__meta">{t("proShell.assets.positionsHint")}</div>
          {positions.length === 0 ? (
            <div className="qb-explorer-assets__meta">{t("proShell.assets.emptyPositions")}</div>
          ) : (
            positions.map((p) => (
              <button
                key={p.id}
                type="button"
                className="qb-explorer-assets__row"
                onClick={() => setActiveView("trader")}
              >
                <span>
                  {p.label}
                  <span style={{ opacity: 0.65 }}> · {p.detail}</span>
                </span>
              </button>
            ))
          )}
          <button
            type="button"
            className="qb-explorer-assets__row"
            onClick={() => setActiveView("trader")}
          >
            <span>{t("proShell.assets.openTrader")}</span>
          </button>
        </>
      ) : null}
    </div>
  );
};
