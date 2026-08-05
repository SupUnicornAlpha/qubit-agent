/**
 * Explorer「资产」：双入口
 * - 工坊：DB 因子/策略版本（原行为）
 * - 工作区：DecisionProvider 投影到 FS 的 factors/strategies（可打开文件）
 */
import { type CSSProperties, type FC, useCallback, useEffect, useState } from "react";
import {
  getOrCreateDefaultProject,
  listFactors,
  listFsWorkspaceDecisionFactors,
  listFsWorkspaceDecisionStrategies,
  listStrategyRuntimes,
  listStrategyVersions,
  syncFsWorkspaceDecision,
  type FactorRecord,
  type FsDecisionAssetItem,
  type StrategyVersionFlatRecord,
} from "../../api/backend";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store";

type AssetTab = "strategies" | "factors" | "positions";
type AssetSource = "workshop" | "workspace";

export const ExplorerAssetsPanel: FC = () => {
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setQuantTab = useAppStore((s) => s.setQuantTab);
  const setQuantContext = useAppStore((s) => s.setQuantContext);
  const setQuantHandoff = useAppStore((s) => s.setQuantHandoff);
  const activeFsWorkspaceId = useAppStore((s) => s.activeFsWorkspaceId);
  const setPendingWorkspaceFile = useAppStore((s) => s.setPendingWorkspaceFile);
  const { t } = useTranslation();

  const [tab, setTab] = useState<AssetTab>("strategies");
  const [source, setSource] = useState<AssetSource>(() =>
    activeFsWorkspaceId ? "workspace" : "workshop"
  );
  const [projectId, setProjectId] = useState<string | null>(null);
  const [factors, setFactors] = useState<FactorRecord[]>([]);
  const [strategies, setStrategies] = useState<StrategyVersionFlatRecord[]>([]);
  const [wsFactors, setWsFactors] = useState<FsDecisionAssetItem[]>([]);
  const [wsStrategies, setWsStrategies] = useState<FsDecisionAssetItem[]>([]);
  const [providerKind, setProviderKind] = useState<string | null>(null);
  const [positions, setPositions] = useState<
    Array<{ id: string; label: string; detail: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const loadWorkshop = useCallback(async () => {
    const project = await getOrCreateDefaultProject();
    setProjectId(project.id);
    setQuantContext({ projectId: project.id, sourceLabel: "assets-explorer" });
    const [factorRows, strategyRows, runtimeRows] = await Promise.all([
      listFactors({ projectId: project.id }).catch(() => [] as FactorRecord[]),
      listStrategyVersions(project.id).catch(() => [] as StrategyVersionFlatRecord[]),
      listStrategyRuntimes().catch(() => []),
    ]);
    setFactors(factorRows);
    setStrategies(strategyRows);
    setPositions(
      runtimeRows.slice(0, 50).map((r) => ({
        id: r.id,
        label: `${r.symbol} · ${r.market}`,
        detail: `${r.status} · ${r.executionMode}`,
      }))
    );
  }, [setQuantContext]);

  const loadWorkspace = useCallback(async (wsId: string) => {
    const [strat, fac] = await Promise.all([
      listFsWorkspaceDecisionStrategies(wsId),
      listFsWorkspaceDecisionFactors(wsId),
    ]);
    setWsStrategies(strat.items);
    setWsFactors(fac.items);
    setProviderKind(strat.kind || fac.kind || null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await loadWorkshop();
      if (activeFsWorkspaceId) {
        await loadWorkspace(activeFsWorkspaceId);
      } else {
        setWsStrategies([]);
        setWsFactors([]);
        setProviderKind(null);
        if (source === "workspace") setSource("workshop");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeFsWorkspaceId, loadWorkshop, loadWorkspace, source]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (activeFsWorkspaceId && source !== "workspace") {
      // 有课题时默认偏向工作区投影，但不强制打断用户已选手动工坊
    } else if (!activeFsWorkspaceId && source === "workspace") {
      setSource("workshop");
    }
  }, [activeFsWorkspaceId, source]);

  const openWsAsset = (item: FsDecisionAssetItem) => {
    if (!activeFsWorkspaceId) return;
    const path = item.relPath || item.id;
    if (!path) return;
    setPendingWorkspaceFile({ workspaceId: activeFsWorkspaceId, path });
    setActiveView("team");
  };

  const handleSync = async () => {
    if (!activeFsWorkspaceId || !projectId) return;
    setSyncing(true);
    setError(null);
    try {
      const r = await syncFsWorkspaceDecision(activeFsWorkspaceId, projectId);
      await loadWorkspace(activeFsWorkspaceId);
      setSource("workspace");
      setError(null);
      window.alert?.(
        t("proShell.assets.syncDone", {
          factors: String(r.factorCount),
          strategies: String(r.strategyCount),
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return <div className="qb-explorer-assets__meta">{t("common.status.loading")}</div>;
  }

  return (
    <div className="qb-explorer-assets">
      <div className="qb-explorer-sections" style={{ paddingLeft: 0, paddingRight: 0 }}>
        {(
          [
            ["workshop", t("proShell.assets.sourceWorkshop")],
            ["workspace", t("proShell.assets.sourceWorkspace")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-selected={source === id}
            disabled={id === "workspace" && !activeFsWorkspaceId}
            title={
              id === "workspace" && !activeFsWorkspaceId
                ? t("proShell.assets.needWorkspace")
                : undefined
            }
            onClick={() => setSource(id)}
          >
            {label}
          </button>
        ))}
      </div>
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

      {source === "workspace" ? (
        <div style={styles.toolbar}>
          <span style={styles.meta}>
            {providerKind
              ? t("proShell.assets.providerKind", { kind: providerKind })
              : t("proShell.assets.providerUnknown")}
          </span>
          <button
            type="button"
            style={styles.link}
            disabled={!activeFsWorkspaceId || !projectId || syncing}
            onClick={() => void handleSync()}
          >
            {syncing ? t("proShell.assets.syncing") : t("proShell.assets.syncFromWorkshop")}
          </button>
        </div>
      ) : null}

      {error ? <div className="qb-explorer-assets__meta">{error}</div> : null}

      {source === "workshop" && tab === "strategies" ? (
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

      {source === "workshop" && tab === "factors" ? (
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

      {source === "workspace" && tab === "strategies" ? (
        wsStrategies.length === 0 ? (
          <div className="qb-explorer-assets__meta">
            {t("proShell.assets.emptyWorkspaceStrategies")}
          </div>
        ) : (
          wsStrategies.map((s) => (
            <button
              key={s.id}
              type="button"
              className="qb-explorer-assets__row"
              title={s.relPath || s.id}
              onClick={() => openWsAsset(s)}
            >
              <span>{s.name}</span>
            </button>
          ))
        )
      ) : null}

      {source === "workspace" && tab === "factors" ? (
        wsFactors.length === 0 ? (
          <div className="qb-explorer-assets__meta">{t("proShell.assets.emptyWorkspaceFactors")}</div>
        ) : (
          wsFactors.map((f) => (
            <button
              key={f.id}
              type="button"
              className="qb-explorer-assets__row"
              title={f.relPath || f.id}
              onClick={() => openWsAsset(f)}
            >
              <span>{f.name}</span>
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

const styles: Record<string, CSSProperties> = {
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "4px 0 8px",
  },
  meta: { fontSize: 10, color: "#71717a", lineHeight: 1.3 },
  link: {
    border: "none",
    background: "transparent",
    color: "#38bdf8",
    fontSize: 11,
    cursor: "pointer",
    padding: 0,
    whiteSpace: "nowrap",
  },
};
