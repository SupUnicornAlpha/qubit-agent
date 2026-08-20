import type { CSSProperties, FC } from "react";
import { KlinePanel } from "../components/chart/KlinePanel";
import { IdeWorkbenchToolbar } from "../components/ide/IdeWorkbenchToolbar";
import { MarketTerminalDock } from "../components/market/MarketTerminalDock";
import { MarketWatchlistPanel } from "../components/market/MarketWatchlistPanel";

/** 独立行情工作台：左侧用户上下文，右侧 K 线与指标，和 IDE 工作台共享同一自选。 */
export const MarketWorkspacePage: FC = () => (
  <div style={styles.root} data-qb-market-workspace>
    <IdeWorkbenchToolbar />
    <div className="qb-market-workspace__body" style={styles.body}>
      <aside className="qb-market-workspace__context" style={styles.contextPane}>
        <MarketWatchlistPanel />
      </aside>
      <section className="qb-market-workspace__chart" style={styles.chartPane}>
        <div className="qb-market-workspace__chart-surface" style={styles.chartSurface}>
          <KlinePanel embedded />
        </div>
        <MarketTerminalDock />
      </section>
    </div>
  </div>
);

const styles: Record<string, CSSProperties> = {
  root: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--qb-bg-root, #09090b)" },
  body: { flex: 1, minHeight: 0, minWidth: 0, display: "flex", overflow: "hidden" },
  contextPane: { width: "clamp(245px, 25vw, 340px)", minWidth: 220, minHeight: 0, overflow: "hidden", borderRight: "1px solid var(--qb-kline-header-border, #27272a)" },
  chartPane: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" },
  chartSurface: { flex: 1, minWidth: 0, minHeight: 220, display: "flex", overflow: "hidden" },
};
